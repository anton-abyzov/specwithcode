/**
 * ManagedProjectFolders - the project folders SpecWithCode makes for the user under
 * its data dir, rather than ones the user picks:
 *
 * - `<baseDir>/scratch`: the Scratch project ("No project"), with a folder of
 *   its own for each thread;
 * - `<baseDir>/projects/<slug>`: projects started from just a name, each a new
 *   Git repository with a README, an icon, and a first commit.
 *
 * @module ManagedProjectFolders
 */
import {
  CommandId,
  PERSONAL_ASSISTANT_PROJECT_ICON,
  ProjectCreateFailureReason,
  ProjectId,
  type FilesystemProjectOutcome,
  type ProjectCreateFailure,
  type ThreadId,
} from "@specweave-studio/contracts";
import { newProjectFolderName } from "@specweave-studio/shared/path";
import { canonicalStudioPath } from "@specweave-studio/shared/studioIdentity";
import { machineAssistantOf } from "@specweave-studio/shared/personalAssistant";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The account home only canonicalizes paths recorded under a migrated legacy root.
import { homedir } from "node:os";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as SpecweaveSetup from "./SpecweaveSetup.ts";
import * as WorkspaceSensitivePaths from "../workspace/WorkspaceSensitivePaths.ts";
import {
  isGitSpawnFailure,
  namedProjectFailureMessage,
  platformFailureReason,
} from "./namedProjectFailure.ts";

export class ScratchUnavailableError extends Schema.TaggedError<ScratchUnavailableError>()(
  "ScratchUnavailableError",
  {},
) {
  override get message(): string {
    return "Threads without a project are not available on this environment.";
  }
}

export class ScratchFolderError extends Schema.TaggedError<ScratchFolderError>()(
  "ScratchFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the folder for threads without a project.";
  }
}

export class ScratchProjectError extends Schema.TaggedError<ScratchProjectError>()(
  "ScratchProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project for threads without a project.";
  }
}

export type ScratchError = ScratchUnavailableError | ScratchFolderError | ScratchProjectError;

export class NamedProjectFolderError extends Schema.TaggedError<NamedProjectFolderError>()(
  "NamedProjectFolderError",
  {
    folder: Schema.String,
    /** Why, when it is known; the client says it in its own words and names the machine. */
    reason: Schema.optional(ProjectCreateFailureReason),
    /** A tool's own words (git's error line), or the slug whose names ran out. */
    detail: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.reason !== undefined) {
      return namedProjectFailureMessage({
        reason: this.reason,
        folder: this.folder,
        ...(this.detail === undefined ? {} : { detail: this.detail }),
      });
    }
    // A refusal written here already says what is wrong with the parent.
    return typeof this.cause === "string" ? this.cause : "Failed to create the project folder.";
  }
}

export class NamedProjectCreateError extends Schema.TaggedError<NamedProjectCreateError>()(
  "NamedProjectCreateError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project.";
  }
}

/** A new personal assistant while Settings keeps Percy off. */
export class PersonalAssistantDisabledError extends Schema.TaggedError<PersonalAssistantDisabledError>()(
  "PersonalAssistantDisabledError",
  {},
) {
  override get message(): string {
    return ProjectService.PERSONAL_ASSISTANT_DISABLED_MESSAGE;
  }
}

export type NamedProjectError =
  | NamedProjectFolderError
  | NamedProjectCreateError
  | PersonalAssistantDisabledError;

/** The typed reason a create failure carries to the client, when there is one. */
export function projectCreateFailureOf(error: NamedProjectError): {
  readonly projectCreateFailure?: ProjectCreateFailure;
} {
  if (error._tag !== "NamedProjectFolderError" || error.reason === undefined) return {};
  const detail = error.detail?.trim();
  return {
    projectCreateFailure: {
      reason: error.reason,
      ...(error.folder.trim() ? { folder: error.folder } : {}),
      ...(detail ? { detail } : {}),
    },
  };
}

/**
 * A folder listing with what creating `projectName` in it does, by the
 * create's own rules. Without a name, or for an unreadable folder, the listing
 * is returned as it is.
 */
export const withCreateOutcome = <
  R extends { readonly parentPath: string; readonly unreadable?: boolean | undefined },
>(
  folders: ManagedProjectFolders["Service"],
  projectName: string | undefined,
  result: R,
) =>
  projectName === undefined || result.unreadable === true
    ? Effect.succeed(result)
    : folders
        .previewNamedProject({ name: projectName, parentPath: result.parentPath })
        .pipe(
          Effect.map((outcome) =>
            Option.isSome(outcome) ? { ...result, outcome: outcome.value } : result,
          ),
        );

const SCRATCH_FOLDER = "scratch";

/**
 * Whether a project root is the data folder's Scratch ("No project") folder, also under a
 * since-migrated legacy root. It holds every project-less chat's own folder.
 */
export const isScratchWorkspace = (path: Path.Path, baseDir: string, workspaceRoot: string) =>
  canonicalStudioPath(path.resolve(workspaceRoot), homedir()) ===
  path.resolve(baseDir, SCRATCH_FOLDER);

export class ManagedProjectFolders extends Context.Service<
  ManagedProjectFolders,
  {
    /** The Scratch folder, or None when this environment does not offer one. */
    readonly scratchRoot: Effect.Effect<Option.Option<string>>;
    /** Whether the project is this environment's Scratch project ("No project"). */
    readonly isScratch: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** Finds or creates the Scratch project and (re)creates its folder. */
    readonly ensureScratchProject: Effect.Effect<{ readonly projectId: ProjectId }, ScratchError>;
    /**
     * Claims a fresh folder for a new thread in the Scratch project, named from
     * the date, its first message, and its id. None for every other project.
     */
    readonly folderForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<Option.Option<string>, ScratchFolderError>;
    /** The folder that holds projects started from just a name. */
    readonly namedProjectsRoot: string;
    /**
     * Where this machine's owner keeps projects: the first of the usual
     * folders under home that exists, otherwise `~/Projects`, which is made
     * when a project is first created there.
     */
    readonly suggestedProjectsRoot?: string;
    /**
     * Starts a project. A code project whose chosen `parentPath` is already a
     * project (holding `.git` or `.specweave`, or named like the project), or whose `<parentPath>/<slug>` already is one,
     * binds to that folder as-is and returns `existing: true`: no subfolder,
     * no `git init`, no starter files. Otherwise it claims
     * `<parentPath ?? namedProjectsRoot>/<slug>`
     * (adding `-2`, `-3`, ... when taken), makes it a Git repository with a
     * README, an icon, and a first commit, then creates the project. Personal
     * projects return this machine's assistant when it has one; a new one is
     * refused while Settings keeps Percy off, and otherwise claims a private
     * managed folder without invoking Git. With `specweave`, a new code
     * project also runs `specweave init` before the first commit, so its
     * files land in that commit; a failed init keeps the project and returns
     * why in `specweaveError`. A failed
     * commit (no Git identity, a signing prompt) keeps the project and returns
     * why in `commitError`. The folder is removed when the create fails or is
     * cancelled before the project exists, never once another project owns it.
     */
    readonly createNamedProject: (input: {
      readonly name: string;
      readonly parentPath?: string | undefined;
      readonly kind?: "code" | "personal" | undefined;
      readonly specweave?: boolean | undefined;
    }) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly commitError?: string;
        readonly existing?: boolean;
        readonly specweaveError?: string;
        /** SpecWeave was set up in a folder that already existed and had none. */
        readonly specweaveAdded?: boolean;
      },
      NamedProjectError
    >;
    /**
     * What `createNamedProject` for a code project would do with this parent,
     * decided by the same rules, without touching anything: `uses` an existing
     * folder as the project, or `creates` the named (or numbered) folder.
     * None when the parent cannot be listed.
     */
    readonly previewNamedProject: (input: {
      readonly name: string;
      readonly parentPath: string;
    }) => Effect.Effect<Option.Option<FilesystemProjectOutcome>>;
  }
>()("specweave-studio/project/ManagedProjectFolders") {}

// Only [a-z0-9] reaches a folder name, so it stays one path segment, and the
// words are capped so a pasted blob cannot outgrow a file name.
const folderWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");

// Tailwind 600 shades: dark enough for white initials on every hue.
const ICON_BACKGROUNDS = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
] as const;

const MAX_NAMED_FOLDER_ATTEMPTS = 100;
/** Where people usually keep projects, most common first. */
const USUAL_PROJECT_FOLDERS = ["Projects", "projects", "Developer", "dev", "code", "src", "repos"];

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A rounded square with the name's initials, colored by a hash of the name.
 * It lives at `assets/icon.svg`, a path ProjectFaviconResolver already checks,
 * so every machine that clones the project shows the same icon.
 */
function namedProjectIconSvg(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() ||
    Array.from(name.trim())[0] ||
    "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const background = ICON_BACKGROUNDS[hash % ICON_BACKGROUNDS.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `  <rect width="64" height="64" rx="14" fill="${background}"/>`,
    `  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function namedProjectReadme(name: string): string {
  return [
    `<img src="assets/icon.svg" width="64" height="64" alt="">`,
    "",
    `# ${name}`,
    "",
    "Created in [SpecWithCode](https://specwithcode.com).",
    "",
  ].join("\n");
}

// Git's own identity message runs several lines; say what to do instead.
// Otherwise its last line ("error: gpg failed to sign the data") says enough.
function describeCommitFailure(stderr: string): string {
  if (/identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)) {
    return 'Git has no name or email on this machine, so the first commit was not made. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com", then commit.';
  }
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Git could not make the first commit.";
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const assistantLock = yield* Semaphore.make(1);
  // One code project at a time: two creates for the same empty folder must not
  // both find it empty and scaffold over each other.
  const namedLock = yield* Semaphore.make(1);
  // Optional so hosts without a process runner still create projects; a
  // request for SpecWeave then says it could not run.
  const specweaveSetup = yield* Effect.serviceOption(SpecweaveSetup.SpecweaveSetup);
  // The folders New folder refuses (`~/.ssh`, the app's own state, ...) are
  // refused as a parent here too, by the path asked for and the real one.
  const sensitivePaths = yield* WorkspaceSensitivePaths.sensitivePathGuard;
  const refusedParent = (folder: string) =>
    sensitivePaths.isInsideDeniedFolder(folder) || sensitivePaths.isDenied(folder, "write");

  /**
   * Claims the first free folder among `folderFor(1)`, `folderFor(2)`, ...,
   * stopping with None when `folderFor` runs out of names. Each folder is
   * created without `recursive`, so creating it is the claim: of two racers
   * for one name, one gets AlreadyExists and moves on to the next. Scratch
   * thread folders and named projects both claim through this, so no two
   * threads or projects ever share a folder.
   */
  const claimFreeFolder = Effect.fnUntraced(function* <E>(
    folderFor: (attempt: number) => Effect.Effect<Option.Option<string>, E>,
    onError: (folder: string, cause: PlatformError.PlatformError) => E,
  ) {
    for (let attempt = 1; ; attempt++) {
      const folder = yield* folderFor(attempt);
      if (Option.isNone(folder)) return folder;
      const claimed = yield* fileSystem.makeDirectory(folder.value).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => onError(folder.value, cause)),
      );
      if (claimed) return folder;
    }
  });

  // When Git cannot run (a fresh Linux desktop without it), a `.git` entry in
  // the data dir or any parent still marks a checkout. A failed stat counts as one.
  // The real path, so a data dir linked into a dotfiles checkout is seen inside it.
  const insideCheckoutOnDisk = Effect.fnUntraced(function* (start: string) {
    for (let dir = yield* fileSystem.realPath(start); ; dir = path.dirname(dir)) {
      if (yield* fileSystem.exists(path.join(dir, ".git"))) return true;
      if (path.dirname(dir) === dir) return false;
    }
  });

  // Inside a checkout (a dev worktree's .specwithcode, a dotfiles home) the folder would
  // inherit the repo's git status and checkpoints, so Scratch is offered only
  // when the data dir is outside any work tree. Probed once; when Git detection
  // fails the disk walk decides, and its failures hide Scratch rather than
  // failing callers. An interrupted probe invalidates the cache so the next
  // caller probes again.
  const [probe, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    gitWorkflow.isRepository(config.baseDir).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : insideCheckoutOnDisk(config.baseDir).pipe(
              Effect.catchCause((walkCause) =>
                Cause.hasInterrupts(walkCause) ? Effect.interrupt : Effect.succeed(true),
              ),
            ),
      ),
      Effect.map((isRepository) =>
        isRepository
          ? Option.none<string>()
          : Option.some(path.resolve(config.baseDir, SCRATCH_FOLDER)),
      ),
    ),
    Duration.infinity,
  );
  const scratchRoot = probe.pipe(Effect.onInterrupt(() => invalidate));

  const makeScratchFolder = (folder: string) =>
    fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError((cause) => new ScratchFolderError({ folder, cause })));

  const ensureScratchProject: ManagedProjectFolders["Service"]["ensureScratchProject"] = Effect.gen(
    function* () {
      const workspaceRoot = yield* scratchRoot.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ScratchUnavailableError()),
            onSome: Effect.succeed,
          }),
        ),
      );
      // Re-made on every call, so a deleted Scratch folder still runs threads.
      yield* makeScratchFolder(workspaceRoot);
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })),
      );
      const bootstrapped = yield* projects
        .bootstrap({
          commandId: CommandId.make(`scratch-project:${id}`),
          projectId: ProjectId.make(id),
          title: "No project",
          workspaceRoot,
        })
        .pipe(
          // bootstrap looks the root up before taking the workspace lock, so a
          // racing create loses with a conflict that names the winner.
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              Effect.succeed({
                project: { id: conflict.conflictingProjectId },
                created: false,
              }),
          }),
          Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })),
        );
      if (bootstrapped.created) {
        // A dashed chat bubble in neutral gray marks Scratch. Set once at
        // create, so a user's own icon choice is never overwritten.
        yield* projects
          .update({
            commandId: CommandId.make(`scratch-project-icon:${id}`),
            projectId: bootstrapped.project.id,
            projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
          })
          .pipe(Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })));
      }
      return { projectId: bootstrapped.project.id };
    },
  );

  const isScratchProject = (projectId: ProjectId, root: string) =>
    projects.getById(projectId).pipe(
      Effect.map(
        // A Scratch project recorded under a since-migrated legacy root is still Scratch.
        Option.exists(
          (project) =>
            canonicalStudioPath(path.resolve(project.workspaceRoot), homedir()) ===
            path.resolve(root),
        ),
      ),
      // An unreadable project is not Scratch; the launch reports its own
      // project lookup failure.
      Effect.orElseSucceed(() => false),
    );

  const folderForThread: ManagedProjectFolders["Service"]["folderForThread"] = Effect.fn(
    "ManagedProjectFolders.folderForThread",
  )(function* (input) {
    const root = yield* scratchRoot;
    if (Option.isNone(root)) return Option.none();
    if (!(yield* isScratchProject(input.projectId, root.value))) return Option.none();
    const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const words = folderWords(input.text);
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (idPart: string) =>
      path.join(root.value, [date, words, idPart].filter(Boolean).join("-"));
    yield* makeScratchFolder(root.value);
    const fullFolder = folderFor(id);
    // Thread ids often share a prefix ("thread:..."), so the first name uses
    // the id's tail. A taken short name falls back to the full id, which only
    // this thread holds. Ids that normalize alike, or a launch retried without
    // its receipt, can find the full name taken too, so later attempts add a
    // fresh random suffix; the names never run out.
    return yield* claimFreeFolder(
      (attempt) =>
        attempt === 1
          ? Effect.succeed(Option.some(folderFor(id.slice(-8))))
          : attempt === 2
            ? Effect.succeed(Option.some(fullFolder))
            : crypto.randomUUIDv4.pipe(
                Effect.map((uuid) => Option.some(`${fullFolder}-${uuid.slice(0, 8)}`)),
                Effect.mapError((cause) => new ScratchFolderError({ folder: fullFolder, cause })),
              ),
      (folder, cause) => new ScratchFolderError({ folder, cause }),
    );
  });

  // Personal and legacy name-only requests retain managed storage. Code
  // projects can explicitly choose an existing parent on this machine.
  const namedProjectsRoot = path.resolve(config.baseDir, "projects");
  // serverConfig advertises this folder to every client, so it must exist before anyone browses it.
  yield* fileSystem.makeDirectory(namedProjectsRoot, { recursive: true }).pipe(Effect.ignore);

  let suggestedProjectsRoot = path.join(homedir(), "Projects");
  for (const name of USUAL_PROJECT_FOLDERS) {
    const candidate = path.join(homedir(), name);
    const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") {
      suggestedProjectsRoot = candidate;
      break;
    }
  }

  const claimNamedFolder = Effect.fn("ManagedProjectFolders.claimNamedFolder")(function* (
    name: string,
    parentPath?: string,
  ) {
    // Both advertised default folders may not exist yet; they are made on first use.
    if (parentPath !== undefined && path.resolve(parentPath) === suggestedProjectsRoot) {
      yield* fileSystem
        .makeDirectory(suggestedProjectsRoot, { recursive: true })
        .pipe(Effect.ignore);
    }
    const explicitParent =
      parentPath !== undefined && path.resolve(parentPath) !== namedProjectsRoot
        ? parentPath
        : undefined;
    const root = explicitParent ?? namedProjectsRoot;
    if (explicitParent !== undefined) {
      if (!path.isAbsolute(explicitParent)) {
        return yield* new NamedProjectFolderError({
          folder: root,
          cause: "Choose an absolute parent folder on this machine.",
        });
      }
      const resolvedParent = path.resolve(root);
      const childOf = (parent: string) => path.join(parent, newProjectFolderName(name));
      if (refusedParent(childOf(resolvedParent))) {
        return yield* new NamedProjectFolderError({
          folder: resolvedParent,
          reason: "refused",
          cause: "refused",
        });
      }
      const info = yield* fileSystem.stat(root).pipe(
        Effect.mapError(
          (cause) =>
            new NamedProjectFolderError({
              folder: resolvedParent,
              ...platformFailureReason(cause),
              cause,
            }),
        ),
      );
      if (info.type !== "Directory") {
        return yield* new NamedProjectFolderError({
          folder: root,
          cause: "The parent must be an existing directory.",
        });
      }
      // A link into a refused folder must not be a way around the refusal.
      const realParent = yield* fileSystem
        .realPath(resolvedParent)
        .pipe(Effect.orElseSucceed(() => resolvedParent));
      if (refusedParent(childOf(realParent))) {
        return yield* new NamedProjectFolderError({
          folder: resolvedParent,
          reason: "refused",
          cause: "refused",
        });
      }
    } else
      yield* fileSystem
        .makeDirectory(namedProjectsRoot, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new NamedProjectFolderError({ folder: namedProjectsRoot, cause }),
          ),
        );
    const folderName = newProjectFolderName(name);
    const claimed = yield* claimFreeFolder(
      (attempt) =>
        Effect.succeed(
          attempt > MAX_NAMED_FOLDER_ATTEMPTS
            ? Option.none()
            : Option.some(path.join(root, attempt === 1 ? folderName : `${folderName}-${attempt}`)),
        ),
      (folder, cause) => {
        const reason = platformFailureReason(cause);
        // A permission or missing-parent failure is about the parent, not the new folder.
        return new NamedProjectFolderError({
          folder: reason.reason === undefined ? folder : root,
          ...reason,
          cause,
        });
      },
    );
    if (Option.isSome(claimed)) return claimed.value;
    return yield* new NamedProjectFolderError({
      folder: root,
      reason: "name_exhausted",
      detail: folderName,
      cause: `Every folder name for "${folderName}" is taken.`,
    });
  });

  // `specweave init`, only when asked. Never fails: why it did not run comes back.
  const setUpSpecweave = (cwd: string) =>
    Option.match(specweaveSetup, {
      onNone: () => Effect.succeed("SpecWeave setup is not available on this machine."),
      onSome: (setup) =>
        setup.setUp(cwd).pipe(Effect.map((result) => (result.ok ? undefined : result.detail))),
    });

  // git init, the starter files, SpecWeave when asked, and the first commit.
  // Only SpecWeave and the commit may fail softly; everything else fails the create.
  const scaffoldRepository = Effect.fn("ManagedProjectFolders.scaffoldRepository")(function* (
    cwd: string,
    name: string,
    specweave: boolean,
  ) {
    const branch =
      (yield* git
        .readConfigValue(cwd, "init.defaultBranch")
        .pipe(Effect.orElseSucceed(() => null))) ?? "main";
    // Git's own words come back when init fails, and a git that cannot start is
    // said to be missing, so the person knows what to fix on that machine.
    const init = yield* git
      .execute({
        operation: "ManagedProjectFolders.init",
        cwd,
        args: ["init", `--initial-branch=${branch}`],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((cause) =>
          isGitSpawnFailure(cause)
            ? new NamedProjectFolderError({ folder: cwd, reason: "git_missing", cause })
            : cause,
        ),
      );
    if (init.exitCode !== 0) {
      const detail =
        init.stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1) ?? `exit code ${init.exitCode}`;
      return yield* new NamedProjectFolderError({
        folder: cwd,
        reason: "git_init_failed",
        detail,
        cause: detail,
      });
    }
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), namedProjectReadme(name));
    yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "assets", "icon.svg"),
      namedProjectIconSvg(name),
    );
    // Named and forced so a global ignore rule (say `*.svg`) cannot drop one.
    yield* git.execute({
      operation: "ManagedProjectFolders.add",
      cwd,
      args: ["add", "--force", "--", "README.md", "assets/icon.svg"],
      timeoutMs: 10_000,
    });
    const setupError = specweave ? yield* setUpSpecweave(cwd) : undefined;
    // Everything init wrote, minus what its own .gitignore leaves out. Soft, like
    // the setup itself: the project is kept and the person is told.
    const stageError =
      specweave && setupError === undefined
        ? yield* git
            .execute({
              operation: "ManagedProjectFolders.addSpecweave",
              cwd,
              args: ["add", "--all"],
              allowNonZeroExit: true,
              timeoutMs: 30_000,
            })
            .pipe(
              Effect.map((result) =>
                result.exitCode === 0
                  ? undefined
                  : "SpecWeave's files could not be added to the first commit.",
              ),
              Effect.catch(() =>
                Effect.succeed("SpecWeave's files could not be added to the first commit."),
              ),
            )
        : undefined;
    const specweaveError = setupError ?? stageError;
    const commitError = yield* git
      .execute({
        operation: "ManagedProjectFolders.commit",
        cwd,
        args: ["commit", "--message", "Initial commit"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? undefined : describeCommitFailure(result.stderr),
        ),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
    return { commitError, specweaveError };
  });

  const hasProjectMarker = (folder: string) =>
    Effect.forEach([".git", ".specweave"], (marker) =>
      fileSystem.exists(path.join(folder, marker)).pipe(Effect.orElseSucceed(() => false)),
    ).pipe(Effect.map((found) => found.some(Boolean)));

  /**
   * The folder a new code project should bind to as-is, when the person
   * picked an existing project rather than a parent for a new one. Only the
   * chosen folder's own markers count, not an enclosing work tree, so a
   * parent inside a dotfiles home repository still gets a new subfolder.
   */
  const existingProjectFolder = Effect.fn("ManagedProjectFolders.existingProjectFolder")(function* (
    name: string,
    parentPath: string,
  ) {
    if (!path.isAbsolute(parentPath)) return Option.none<string>();
    const chosen = path.resolve(parentPath);
    const info = yield* fileSystem.stat(chosen).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") return Option.none<string>();
    const folderName = newProjectFolderName(name);
    if (
      newProjectFolderName(path.basename(chosen)) === folderName ||
      (yield* hasProjectMarker(chosen))
    ) {
      return Option.some(chosen);
    }
    const child = path.join(chosen, folderName);
    return (yield* hasProjectMarker(child)) ? Option.some(child) : Option.none<string>();
  });

  // Registers an existing folder without touching its files or its Git state.
  // SpecWeave for a folder that was already there: `specweave init` only. Its
  // files are left for the person to commit, since the repository is theirs.
  const addSpecweaveToExisting = Effect.fn("ManagedProjectFolders.addSpecweaveToExisting")(
    function* (workspaceRoot: string, wanted: boolean) {
      if (!wanted) return {};
      const present = yield* fileSystem
        .exists(path.join(workspaceRoot, ".specweave"))
        .pipe(Effect.orElseSucceed(() => false));
      if (present) return {};
      const error = yield* setUpSpecweave(workspaceRoot);
      return error === undefined ? { specweaveAdded: true } : { specweaveError: error };
    },
  );

  const bindExistingFolder = Effect.fn("ManagedProjectFolders.bindExistingFolder")(function* (
    name: string,
    workspaceRoot: string,
    specweave: boolean,
  ) {
    const owner = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })));
    if (Option.isSome(owner)) {
      return {
        projectId: owner.value.id,
        workspaceRoot,
        existing: true,
        ...(yield* addSpecweaveToExisting(workspaceRoot, specweave)),
      };
    }
    const id = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
    );
    const project = yield* projects
      .create({
        commandId: CommandId.make(`named-project:${id}`),
        projectId: ProjectId.make(id),
        title: name,
        kind: "code",
        workspaceRoot,
      })
      .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })));
    return {
      projectId: project.id,
      workspaceRoot,
      existing: true,
      ...(yield* addSpecweaveToExisting(workspaceRoot, specweave)),
    };
  });

  // An empty folder nobody registered is a place for a new project, not a
  // project: it gets the repository, starter files and SpecWeave like any other.
  const isUnclaimedEmptyFolder = (folder: string) =>
    Effect.all([
      fileSystem.readDirectory(folder).pipe(
        Effect.map((entries) => entries.length === 0),
        Effect.orElseSucceed(() => false),
      ),
      projects.getByWorkspaceRoot(folder).pipe(
        Effect.map(Option.isNone),
        Effect.orElseSucceed(() => false),
      ),
    ]).pipe(Effect.map(([empty, unclaimed]) => empty && unclaimed));

  /** This machine's assistant, if it has one: the earliest personal project. */
  const existingAssistant = projects.snapshot.pipe(
    Effect.map((snapshot) => machineAssistantOf(snapshot.projects)),
    Effect.mapError(
      (cause) => new NamedProjectCreateError({ workspaceRoot: namedProjectsRoot, cause }),
    ),
  );

  const createNamedProject: ManagedProjectFolders["Service"]["createNamedProject"] = Effect.fn(
    "ManagedProjectFolders.createNamedProject",
  )(function* (input) {
    if (input.kind === "personal") {
      const existing = yield* existingAssistant;
      if (existing) return { projectId: existing.id, workspaceRoot: existing.workspaceRoot };
      // Checked before a folder is claimed, so a refusal leaves nothing behind.
      if (!(yield* ProjectService.personalAssistantEnabled))
        return yield* new PersonalAssistantDisabledError();
    }
    let emptyFolder: string | undefined;
    if (input.kind !== "personal" && input.parentPath !== undefined) {
      const existing = yield* existingProjectFolder(input.name, input.parentPath);
      if (Option.isSome(existing)) {
        // A folder New folder refuses is never bound as a project either, by
        // the path asked for or the real one.
        const realExisting = yield* fileSystem
          .realPath(existing.value)
          .pipe(Effect.orElseSucceed(() => existing.value));
        if (refusedParent(existing.value) || refusedParent(realExisting))
          return yield* new NamedProjectFolderError({
            folder: existing.value,
            reason: "refused",
            cause: "refused",
          });
        if (yield* isUnclaimedEmptyFolder(existing.value)) emptyFolder = existing.value;
        else {
          return yield* bindExistingFolder(input.name, existing.value, input.specweave === true);
        }
      }
    }
    const workspaceRoot =
      emptyFolder ??
      (yield* claimNamedFolder(
        input.name,
        input.kind === "personal" ? undefined : input.parentPath,
      ));
    // A folder the person made themselves is never removed or emptied: only the
    // starter files written here are taken back, so nothing that appeared in it
    // meanwhile is lost. Anything SpecWeave wrote stays for the next attempt.
    const removeFolder =
      emptyFolder === undefined
        ? fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore)
        : Effect.forEach(
            [
              { entry: ".git", recursive: true },
              { entry: "README.md", recursive: false },
              { entry: path.join("assets", "icon.svg"), recursive: false },
              // Fails, and is left, when it holds anything else.
              { entry: "assets", recursive: false },
            ],
            ({ entry, recursive }) =>
              fileSystem.remove(path.join(workspaceRoot, entry), { recursive }).pipe(Effect.ignore),
            { discard: true },
          );
    // Until the create is dispatched nothing else can use the folder, so any
    // exit but success removes it, an interrupt included.
    const prepared = yield* Effect.all([
      (input.kind === "personal"
        ? Effect.succeed({ commitError: undefined, specweaveError: undefined })
        : scaffoldRepository(workspaceRoot, input.name, input.specweave === true)
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(NamedProjectFolderError)(cause)
            ? cause
            : new NamedProjectFolderError({ folder: workspaceRoot, cause }),
        ),
      ),
      crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      ),
    ]).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder)));
    const [{ commitError, specweaveError }, id] = prepared;
    const project = yield* projects
      .create({
        commandId: CommandId.make(`named-project:${id}`),
        projectId: ProjectId.make(id),
        title: input.name,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        workspaceRoot,
      })
      .pipe(
        // A rejected create leaves the folder unused, so remove it. An
        // interrupt can land after the create is committed, and a conflict
        // means another project owns the folder, so it stays then; the owner
        // is checked again first, since deleting another project's files is
        // never acceptable.
        Effect.tapError((error) =>
          error._tag === "ProjectConflictError"
            ? Effect.void
            : projects.getByWorkspaceRoot(workspaceRoot).pipe(
                Effect.flatMap((owner) => (Option.isNone(owner) ? removeFolder : Effect.void)),
                Effect.ignore,
              ),
        ),
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      )
      .pipe(
        // Another path created this machine's assistant first: open that one.
        Effect.catchIf(
          (error) =>
            Schema.is(ProjectService.ProjectRequestDeniedError)(error.cause) &&
            error.cause.reason === "assistant_exists",
          (error) =>
            existingAssistant.pipe(
              Effect.flatMap((existing) =>
                existing ? Effect.succeed(existing) : Effect.fail(error),
              ),
            ),
        ),
      );
    if (project.workspaceRoot !== workspaceRoot)
      return { projectId: project.id, workspaceRoot: project.workspaceRoot };
    // An assistant has no repository to draw an icon from, so it gets one that
    // tells it apart in the sidebar. The owner can change it like any icon.
    if (input.kind === "personal") {
      yield* projects
        .update({
          commandId: CommandId.make(`named-project-icon:${id}`),
          projectId: project.id,
          projectIcon: PERSONAL_ASSISTANT_PROJECT_ICON,
        })
        .pipe(Effect.ignore);
    }
    return {
      projectId: project.id,
      workspaceRoot,
      ...(commitError === undefined ? {} : { commitError }),
      ...(specweaveError === undefined ? {} : { specweaveError }),
    };
  });

  const previewNamedProject: ManagedProjectFolders["Service"]["previewNamedProject"] = Effect.fn(
    "ManagedProjectFolders.previewNamedProject",
  )(function* (input) {
    if (!path.isAbsolute(input.parentPath)) return Option.none();
    const parent = path.resolve(input.parentPath);
    const info = yield* fileSystem.stat(parent).pipe(Effect.option);
    // The advertised projects folder is made on first use, so its absence is no refusal.
    const managed = parent === namedProjectsRoot || parent === suggestedProjectsRoot;
    if (
      (Option.isNone(info) && !managed) ||
      (Option.isSome(info) && info.value.type !== "Directory")
    )
      return Option.none();
    // A parent the create would refuse gets no outcome, so the footer never says "Creates".
    if (parent !== namedProjectsRoot) {
      const childOf = (folder: string) => path.join(folder, newProjectFolderName(input.name));
      if (refusedParent(childOf(parent))) return Option.none();
      const realParent = Option.isSome(info)
        ? yield* fileSystem.realPath(parent).pipe(Effect.orElseSucceed(() => parent))
        : parent;
      if (refusedParent(childOf(realParent))) return Option.none();
    }
    // Sent as no parent by clients, so it never binds to an existing folder.
    if (parent !== namedProjectsRoot) {
      const existing = yield* existingProjectFolder(input.name, parent);
      if (Option.isSome(existing)) {
        const folder = existing.value;
        const marker = (name: string) =>
          fileSystem.exists(path.join(folder, name)).pipe(Effect.orElseSucceed(() => false));
        const because: NonNullable<FilesystemProjectOutcome["because"]> = (yield* marker(".git"))
          ? "repository"
          : (yield* marker(".specweave"))
            ? "specweave"
            : (yield* isUnclaimedEmptyFolder(folder))
              ? "empty_named_like_project"
              : "named_like_project";
        return Option.some({ kind: "uses" as const, path: folder, because });
      }
    }
    const folderName = newProjectFolderName(input.name);
    for (let attempt = 1; attempt <= MAX_NAMED_FOLDER_ATTEMPTS; attempt++) {
      const candidate = path.join(parent, attempt === 1 ? folderName : `${folderName}-${attempt}`);
      const taken = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => true));
      if (!taken) {
        return Option.some({
          kind: "creates" as const,
          path: candidate,
          ...(attempt > 1 ? { because: "name_taken" as const } : {}),
        });
      }
    }
    return Option.none();
  });

  const isScratch: ManagedProjectFolders["Service"]["isScratch"] = (projectId) =>
    scratchRoot.pipe(
      Effect.flatMap((root) =>
        Option.isNone(root) ? Effect.succeed(false) : isScratchProject(projectId, root.value),
      ),
    );

  return ManagedProjectFolders.of({
    scratchRoot,
    isScratch,
    ensureScratchProject,
    folderForThread,
    namedProjectsRoot,
    suggestedProjectsRoot,
    previewNamedProject,
    createNamedProject: (input) =>
      input.kind === "personal"
        ? assistantLock.withPermits(1)(createNamedProject(input))
        : namedLock.withPermits(1)(createNamedProject(input)),
  });
});

export const layer = Layer.effect(ManagedProjectFolders, make);
