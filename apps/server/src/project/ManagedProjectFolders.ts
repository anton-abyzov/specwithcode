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
  ProjectId,
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
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project folder.";
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

export type NamedProjectError = NamedProjectFolderError | NamedProjectCreateError;

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
     * Starts a project. A code project whose chosen `parentPath` is already a
     * project (holding `.git` or `.specweave`, or named like the project), or whose `<parentPath>/<slug>` already is one,
     * binds to that folder as-is and returns `existing: true`: no subfolder,
     * no `git init`, no starter files. Otherwise it claims
     * `<parentPath ?? namedProjectsRoot>/<slug>`
     * (adding `-2`, `-3`, ... when taken), makes it a Git repository with a
     * README, an icon, and a first commit, then creates the project. Personal
     * projects claim a private managed folder without invoking Git. A failed
     * commit (no Git identity, a signing prompt) keeps the project and returns
     * why in `commitError`. The folder is removed when the create fails or is
     * cancelled before the project exists, never once another project owns it.
     */
    readonly createNamedProject: (input: {
      readonly name: string;
      readonly parentPath?: string | undefined;
      readonly kind?: "code" | "personal" | undefined;
    }) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly commitError?: string;
        readonly existing?: boolean;
      },
      NamedProjectError
    >;
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
    "Created in [SpecWithCode](https://studio.invalid).",
    "",
  ].join("\n");
}

// Git's own identity message runs several lines; say what to do instead.
// Otherwise its last line ("error: gpg failed to sign the data") says enough.
function describeCommitFailure(stderr: string): string {
  if (/identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)) {
    return "Git has no name or email on this machine. Set user.name and user.email, then commit.";
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
        isRepository ? Option.none<string>() : Option.some(path.resolve(config.baseDir, "scratch")),
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

  const claimNamedFolder = Effect.fn("ManagedProjectFolders.claimNamedFolder")(function* (
    name: string,
    parentPath?: string,
  ) {
    const root = parentPath ?? namedProjectsRoot;
    if (parentPath !== undefined) {
      if (!path.isAbsolute(parentPath)) {
        return yield* new NamedProjectFolderError({
          folder: root,
          cause: "Choose an absolute parent folder on this machine.",
        });
      }
      const info = yield* fileSystem
        .stat(root)
        .pipe(Effect.mapError((cause) => new NamedProjectFolderError({ folder: root, cause })));
      if (info.type !== "Directory") {
        return yield* new NamedProjectFolderError({
          folder: root,
          cause: "The parent must be an existing directory.",
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
      (folder, cause) => new NamedProjectFolderError({ folder, cause }),
    );
    if (Option.isSome(claimed)) return claimed.value;
    return yield* new NamedProjectFolderError({
      folder: path.join(root, folderName),
      cause: `Every folder name for "${folderName}" is taken.`,
    });
  });

  // git init, the starter files, and the first commit. Only the commit may
  // fail softly; everything before it fails the create.
  const scaffoldRepository = Effect.fn("ManagedProjectFolders.scaffoldRepository")(function* (
    cwd: string,
    name: string,
  ) {
    const branch =
      (yield* git
        .readConfigValue(cwd, "init.defaultBranch")
        .pipe(Effect.orElseSucceed(() => null))) ?? "main";
    yield* git.execute({
      operation: "ManagedProjectFolders.init",
      cwd,
      args: ["init", `--initial-branch=${branch}`],
      timeoutMs: 10_000,
    });
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
    return yield* git
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
  const bindExistingFolder = Effect.fn("ManagedProjectFolders.bindExistingFolder")(function* (
    name: string,
    workspaceRoot: string,
  ) {
    const owner = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })));
    if (Option.isSome(owner)) {
      return { projectId: owner.value.id, workspaceRoot, existing: true };
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
    return { projectId: project.id, workspaceRoot, existing: true };
  });

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
    }
    if (input.kind !== "personal" && input.parentPath !== undefined) {
      const existing = yield* existingProjectFolder(input.name, input.parentPath);
      if (Option.isSome(existing)) return yield* bindExistingFolder(input.name, existing.value);
    }
    const workspaceRoot = yield* claimNamedFolder(
      input.name,
      input.kind === "personal" ? undefined : input.parentPath,
    );
    const removeFolder = fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore);
    // Until the create is dispatched nothing else can use the folder, so any
    // exit but success removes it, an interrupt included.
    const prepared = yield* Effect.all([
      (input.kind === "personal"
        ? Effect.succeed(undefined)
        : scaffoldRepository(workspaceRoot, input.name)
      ).pipe(
        Effect.mapError((cause) => new NamedProjectFolderError({ folder: workspaceRoot, cause })),
      ),
      crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      ),
    ]).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder)));
    const [commitError, id] = prepared;
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
    };
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
    createNamedProject: (input) =>
      input.kind === "personal"
        ? assistantLock.withPermits(1)(createNamedProject(input))
        : createNamedProject(input),
  });
});

export const layer = Layer.effect(ManagedProjectFolders, make);
