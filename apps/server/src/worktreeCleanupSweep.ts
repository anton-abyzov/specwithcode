// @effect-diagnostics nodeBuiltinImport:off -- bounded lstat walks (folder sizes, ignored folders, nested repositories) that never follow symlinks.
/**
 * The chat worktree pass of the storage sweep: one function with a mode.
 * "plan" lists every chat folder with what the sweep would do and why, and
 * changes nothing; "apply" gathers the same facts, asks the same decision
 * (finishedWorktrees.ts) and removes what it allows. Settings > Storage shows
 * the plan, so what a person reads is what the sweep does.
 *
 * Chats are grouped by the real path of their folder: a worker and its
 * sub-chats share one. A folder holds one worktree, or one per repository of
 * a worktree set (worktreeSet.ts). Every member's Git registration is checked
 * from its files before any Git command runs in it, and a folder with one
 * that points elsewhere is neither read further nor removed.
 *
 * Removal runs under the workspace lease, after every fact that can change
 * quickly is read again; any change keeps the folder. Ignored media is copied
 * to `<app folder>/evidence/removed-worktrees/` first. Members go deepest
 * first, never forced; branches and the worktree-set manifest stay, so a chat
 * that resumes gets its folder back.
 *
 * @module worktreeCleanupSweep
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerSettings,
  type StorageCleanupPlanItem,
  type TerminalSummary,
  type WorktreeCleanupRules,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import {
  resolveProjectSettings,
  resolveWorktreeCleanup,
} from "@specweave-studio/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "./config.ts";
import { newestFinite } from "./failClosedAge.ts";
import {
  decideFinishedWorktree,
  type FinishedChatState,
  type FinishedFolderFacts,
  type FinishedMemberGit,
  type FinishedPullRequest,
  type FinishedWorktreeDecision,
  type FinishedWorktreeNeed,
  type FinishedWorktreeRules,
  isMediaFile,
} from "./finishedWorktrees.ts";
import * as GitManager from "./git/GitManager.ts";
import { worktreeHasNoAdditionalChanges } from "./git/worktreeIntegration.ts";
import {
  canonicalPath,
  isOpenThreadOwner,
  listWorktreeBindings,
  ownWorktreeThreadState,
  pathSpellings,
  pathWithin,
  type WorktreeBindings,
  worktreeOwnersOf,
  worktreeThreadState,
} from "./git/worktreeOwnership.ts";
import { checkWorktreeRegistration } from "./git/worktreeRegistration.ts";
import { listProcessCwds } from "./homeUsage/processCwds.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { onlyDependencyIgnores, onlyRebuildableUntracked } from "./orphanWorktrees.ts";
import * as Settings from "./serverSettings.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import { hiddenTrackedChangeReason } from "./worktreeHiddenWork.ts";
import {
  readWorktreeSet,
  worktreeSetManifestPath,
  worktreeSetMemberPath,
  type WorktreeSetMember,
} from "./worktreeSet.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";

const decodeDeletedThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
/** Fingerprints and the evidence manifest; plain values only, so encoding cannot fail. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The plan's size walk stops here and reports no size. */
const SIZE_WALK_MAX_ENTRIES = 200_000;
const SIZE_WALK_TIMEOUT = "5 seconds";
/** Ignored folders are walked for media; one this large keeps the folder instead. */
const IGNORED_WALK_MAX_ENTRIES = 20_000;
const NESTED_WALK_MAX_ENTRIES = 2_000_000;
const NESTED_WALK_TIMEOUT = "30 seconds";
/**
 * A pull request's state is asked of its host once per branch head in this
 * long, however often sweeps and plans run: event sweeps can follow each other
 * every two minutes, and a lookup per folder on each would exhaust the host's
 * rate limit. The hourly sweep still reads every state again.
 */
const PULL_REQUEST_REUSE_MS = 50 * 60_000;
const PULL_REQUEST_CACHE_ENTRIES = 2_000;

/**
 * Finished and waiting for nothing: no run in progress, no background task,
 * no question or approval pending, no turn queued to start. A run that
 * completed, was cancelled, interrupted or rolled back counts; `waiting` does
 * not, and neither does a runless native sub-chat still at work.
 */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    thread.activityRunStatus == null &&
    (thread.status === "idle" ||
      thread.status === "failed" ||
      thread.status === "completed" ||
      thread.status === "cancelled" ||
      thread.status === "interrupted" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/**
 * PR metadata refreshes must not reset the inactivity clock. Null when no
 * reading is known, which never counts as inactive.
 */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number | null {
  return newestFinite(
    [
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].map((value) => (value == null ? null : DateTime.toEpochMillis(value))),
  );
}

/** Whether the global rules or any project's own rules satisfy `predicate`. */
export function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

/** The rules of one project, the resolved-chats switch included. */
function projectRules(settings: ServerSettings, projectId: ProjectId): FinishedWorktreeRules {
  const rules = resolveWorktreeCleanup(settings, projectId);
  // A project whose worktree cleanup is Off keeps its folders under every rule.
  const off = resolveProjectSettings(settings, projectId).settings.worktreeCleanup?.mode === "off";
  return {
    ...rules,
    removeResolvedWorktrees: settings.storageCleanup.removeResolvedWorktrees && !off,
  };
}

/** Every project's rules must allow it: the strictest of them. */
function folderRules(settings: ServerSettings, projectIds: ReadonlySet<ProjectId>) {
  const all = [...projectIds].map((projectId) => projectRules(settings, projectId));
  const days = all.map((rules) => rules.worktreeAfterDays);
  return {
    worktreeAfterDays: days.includes(null) ? null : Math.max(...(days as Array<number>)),
    worktreeOnMerge: all.every((rules) => rules.worktreeOnMerge),
    worktreeOnDelete: all.every((rules) => rules.worktreeOnDelete),
    worktreeUnchanged: all.every((rules) => rules.worktreeUnchanged),
    removeResolvedWorktrees: all.every((rules) => rules.removeResolvedWorktrees),
  } satisfies FinishedWorktreeRules;
}

/**
 * Working directories of running processes for the sweep, or null to read
 * them from the system. Tests set it; null from the system keeps every folder.
 */
export const WorktreeSweepProcessCwds =
  Context.Reference<Effect.Effect<ReadonlyArray<string> | null> | null>(
    "specweave-studio/worktreeCleanupSweep/WorktreeSweepProcessCwds",
    {
      defaultValue: () => null,
    },
  );

export type WorktreeSweepMode = "plan" | "apply";

export interface WorktreeSweepResult {
  readonly items: ReadonlyArray<StorageCleanupPlanItem>;
  /** Folders removed in apply mode, with their size outside dependency installs. */
  readonly removed: ReadonlyArray<{ readonly path: string; readonly bytes: number | null }>;
  /** False when ownership could not be read, a folder could not be checked or a size is missing. */
  readonly complete: boolean;
}

type DeletedChat = typeof OrchestrationV2AppThreadJson.Type;

interface FolderGroup {
  /** Real path, the grouping key. */
  readonly key: string;
  /** As its first chat recorded it, resolved. */
  readonly folder: string;
  readonly chats: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Deleted chats that recorded it; only for a folder no live chat records. */
  readonly deleted: ReadonlyArray<DeletedChat>;
}

interface MediaFile {
  /** Relative to its member's folder. */
  readonly relative: string;
  readonly bytes: number;
}

interface MemberState {
  readonly member: WorktreeSetMember;
  readonly path: string;
  /** The checkout whose `git worktree` commands own this member. */
  readonly repository: string;
  readonly registration: string | null;
  readonly locked: boolean;
  /** Other members inside this one, relative and with forward slashes. */
  readonly inside: ReadonlyArray<string>;
  head: string | null;
  base: string | null;
  media: ReadonlyArray<MediaFile>;
  fingerprint: string;
  git: FinishedMemberGit | undefined;
}

interface Assessment {
  readonly group: FolderGroup;
  readonly decision: FinishedWorktreeDecision;
  readonly members: ReadonlyArray<MemberState>;
  /** The quickly changing facts; any difference at removal keeps the folder. */
  readonly fingerprint: string;
  readonly head: { readonly id: string; readonly title: string } | null;
  readonly threadCount: number;
}

interface SweepContext {
  readonly mode: WorktreeSweepMode;
  readonly settings: ServerSettings;
  readonly now: number;
  readonly bindings: WorktreeBindings;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly roots: ReadonlyArray<string>;
  readonly processCwds: ReadonlyArray<string> | null;
  /** Default-branch refs fetched in this sweep, per repository; null when there is none. */
  readonly defaultRefs: Map<string, string | null>;
}

const toPosix = (value: string) => value.split(NodePath.sep).join("/");

function chatState(thread: OrchestrationV2ThreadShell): FinishedChatState {
  if (thread.archivedAt !== null) return "archived";
  return thread.settledOverride === "settled" ? "resolved" : "open";
}

/**
 * Untracked or ignored entries of a member (Git's `--directory` listing),
 * without the members nested in it: a folder on the way to one is opened and
 * its other entries listed instead. Directories keep their trailing slash.
 */
async function entriesOutsideMembers(
  root: string,
  entries: ReadonlyArray<string>,
  inside: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const kept: Array<string> = [];
  const pending = [...entries];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const relative = entry.replace(/\/$/, "");
    if (relative === "") continue;
    if (inside.some((member) => relative === member || relative.startsWith(`${member}/`))) continue;
    if (!inside.some((member) => member.startsWith(`${relative}/`))) {
      kept.push(entry);
      continue;
    }
    for (const dirent of await NodeFSP.readdir(NodePath.join(root, relative), {
      withFileTypes: true,
    }))
      pending.push(`${relative}/${dirent.name}${dirent.isDirectory() ? "/" : ""}`);
  }
  return kept.toSorted();
}

/**
 * Ignored entries that are neither rebuildable nor media, by name, and the
 * media to copy. An ignored folder is opened (without following links) so a
 * screenshot folder can go once its media is copied; a folder too large to
 * list counts as data.
 */
async function classifyIgnored(
  root: string,
  entries: ReadonlyArray<string>,
): Promise<{ readonly other: ReadonlyArray<string>; readonly media: ReadonlyArray<MediaFile> }> {
  const other: Array<string> = [];
  const media: Array<MediaFile> = [];
  let seen = 0;
  const file = async (relative: string) => {
    if (onlyDependencyIgnores(relative)) return;
    const target = NodePath.join(root, relative);
    const stat = await NodeFSP.lstat(target);
    if (stat.isFile() && isMediaFile(NodePath.basename(target)))
      media.push({ relative: NodePath.normalize(relative), bytes: stat.size });
    else other.push(NodePath.basename(target));
  };
  for (const entry of entries) {
    if (onlyDependencyIgnores(entry)) continue;
    if (!entry.endsWith("/")) {
      await file(entry);
      continue;
    }
    const pending = [entry.replace(/\/$/, "")];
    while (pending.length > 0) {
      const folder = pending.pop()!;
      const dirents = await NodeFSP.readdir(NodePath.join(root, folder), { withFileTypes: true });
      seen += dirents.length;
      if (seen > IGNORED_WALK_MAX_ENTRIES) {
        other.push(NodePath.basename(entry.replace(/\/$/, "")));
        return { other, media };
      }
      for (const dirent of dirents) {
        const relative = `${folder}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (dirent.name !== "node_modules") pending.push(relative);
        } else await file(relative);
      }
    }
  }
  return { other, media };
}

/** A `.git` entry, or the HEAD, objects and refs of a bare repository. */
function holdsRepository(names: ReadonlyArray<string>): boolean {
  const markers = new Set(names.map((name) => name.toLowerCase()));
  return (
    markers.has(".git") || (markers.has("head") && markers.has("objects") && markers.has("refs"))
  );
}

/** A repository in the given untracked or ignored entries; null when the walk ran out. */
async function findRepository(
  root: string,
  entries: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<boolean | null> {
  const pending: Array<string> = [];
  for (const entry of entries) {
    const relative = entry.replace(/\/$/, "");
    if (NodePath.basename(relative).toLowerCase() === ".git") return true;
    pending.push(NodePath.join(root, relative));
  }
  let seen = 0;
  while (pending.length > 0) {
    if (signal.aborted) return null;
    const target = pending.pop()!;
    const stat = await NodeFSP.lstat(target);
    if (!stat.isDirectory()) continue;
    const dirents = await NodeFSP.readdir(target, { withFileTypes: true });
    seen += dirents.length;
    if (seen > NESTED_WALK_MAX_ENTRIES) return null;
    if (holdsRepository(dirents.map((dirent) => dirent.name))) return true;
    for (const dirent of dirents)
      if (dirent.isDirectory()) pending.push(NodePath.join(target, dirent.name));
  }
  return false;
}

/**
 * Bytes on disk outside dependency installs, without following links; null
 * when the walk passes its entry limit or is aborted.
 */
async function folderBytes(root: string, signal: AbortSignal): Promise<number | null> {
  const pending = [root];
  let bytes = 0;
  let seen = 0;
  while (pending.length > 0) {
    if (signal.aborted) return null;
    const folder = pending.pop()!;
    const dirents = await NodeFSP.readdir(folder, { withFileTypes: true });
    for (const dirent of dirents) {
      seen += 1;
      if (seen > SIZE_WALK_MAX_ENTRIES) return null;
      const target = NodePath.join(folder, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name !== "node_modules") pending.push(target);
        continue;
      }
      const stat = await NodeFSP.lstat(target).catch(() => null);
      if (stat === null) continue;
      bytes += stat.blocks > 0 ? stat.blocks * 512 : stat.size;
    }
  }
  return bytes;
}

/** `yyyyMMdd-HHmmss` in UTC, for an evidence folder name. */
const evidenceStamp = (now: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

export const makeWorktreeCleanupSweep = Effect.fn("WorktreeCleanupSweep.make")(function* (options: {
  /** Live terminals, as the storage cleanup tracks them. */
  readonly liveTerminals: () => ReadonlyArray<TerminalSummary>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const processCwdsOverride = yield* WorktreeSweepProcessCwds;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();
  const readProcessCwds = processCwdsOverride ?? listProcessCwds(platform);
  const readBindings = listWorktreeBindings.pipe(Effect.provideContext(services));
  const folderKey = (value: string) => canonicalPath(value).pipe(Effect.provideContext(services));
  const spellingsOf = (value: string) => pathSpellings(value).pipe(Effect.provideContext(services));

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const realOrNull = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed((): string | null => null));
  const run = (
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    maxOutputBytes = 4096,
  ) => git.execute({ operation, cwd, args, maxOutputBytes, allowNonZeroExit: true });

  const readThreads = Effect.fn("WorktreeCleanupSweep.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...active.threads, ...archived.threads] };
  });

  /** Chats grouped by the real path of their folder, sorted by path. */
  const readGroups = Effect.fn("WorktreeCleanupSweep.readGroups")(function* (
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    settings: ServerSettings,
  ) {
    const groups = new Map<
      string,
      { folder: string; chats: Array<OrchestrationV2ThreadShell>; deleted: Array<DeletedChat> }
    >();
    for (const thread of threads) {
      if (thread.worktreePath === null) continue;
      const key = yield* folderKey(thread.worktreePath);
      const group = groups.get(key) ?? {
        folder: path.resolve(thread.worktreePath),
        chats: [],
        deleted: [],
      };
      group.chats.push(thread);
      groups.set(key, group);
    }
    // Deleted chats are read only when a delete rule could act on them.
    if (anyWorktreePolicy(settings, (rules) => rules.worktreeOnDelete)) {
      const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      `;
      for (const row of rows) {
        // A row of another shape only adds no candidate; it can keep nothing either.
        const decoded = yield* decodeDeletedThread(row.payload_json).pipe(Effect.option);
        if (Option.isNone(decoded)) continue;
        const thread = decoded.value;
        if (thread.worktreePath === null) continue;
        if (!resolveWorktreeCleanup(settings, thread.projectId).worktreeOnDelete) continue;
        const key = yield* folderKey(thread.worktreePath);
        const group = groups.get(key) ?? {
          folder: path.resolve(thread.worktreePath),
          chats: [],
          deleted: [],
        };
        if (group.chats.length > 0) continue;
        group.deleted.push(thread);
        groups.set(key, group);
      }
    }
    return [...groups.entries()]
      .map(([key, group]): FolderGroup => ({ key, ...group }))
      .toSorted((left, right) => (left.folder < right.folder ? -1 : 1));
  });

  /** A project folder (or a repository in it) whose own `.specwithcode/worktrees` holds the folder. */
  const projectLocalRepository = Effect.fn("WorktreeCleanupSweep.projectLocal")(function* (
    realFolder: string,
    projects: SweepContext["projects"],
  ) {
    const marker = `${path.sep}.specwithcode${path.sep}worktrees${path.sep}`;
    const index = realFolder.lastIndexOf(marker);
    if (index <= 0) return null;
    const repository = realFolder.slice(0, index);
    const localRoot = path.join(repository, ".specwithcode", "worktrees");
    if ((yield* realOrNull(localRoot)) !== localRoot) return null;
    for (const project of projects) {
      const projectRoot = yield* realOrNull(project.workspaceRoot);
      if (projectRoot !== null && (repository === projectRoot || inside(projectRoot, repository)))
        return repository;
    }
    return null;
  });

  /** Why cleanup must never touch the folder, or null. Reads no Git. */
  const outOfReach = Effect.fn("WorktreeCleanupSweep.outOfReach")(function* (
    folder: string,
    key: string,
    ctx: SweepContext,
  ) {
    const realFolder = yield* realOrNull(folder);
    const realParent = yield* realOrNull(path.dirname(folder));
    if (realFolder === null || realParent === null)
      return { problem: "It could not be read.", localRepository: null };
    // Roots are canonical, so a symlinked parent (a linked drive) is fine; a
    // symlinked folder is not.
    if (realFolder !== path.join(realParent, path.basename(folder)))
      return { problem: "It is reached through a symbolic link.", localRepository: null };
    const localRepository = ctx.roots.some((root) => inside(root, realFolder))
      ? null
      : yield* projectLocalRepository(realFolder, ctx.projects);
    if (!ctx.roots.some((root) => inside(root, realFolder)) && localRepository === null)
      return { problem: "It is outside the app's worktree folders.", localRepository };
    const spellings = [...new Set([folder, key, realFolder])];
    for (const project of ctx.projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      const projectReal = (yield* realOrNull(projectPath)) ?? projectPath;
      if (
        spellings.some((spelling) =>
          [projectPath, projectReal].some(
            (candidate) => candidate === spelling || inside(spelling, candidate),
          ),
        )
      )
        return { problem: "A project's folder is inside it.", localRepository };
    }
    return { problem: null, localRepository };
  });

  const commitCount = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    run(cwd, operation, args, 1024).pipe(
      Effect.map((result) => {
        const count = Number.parseInt(result.stdout.trim(), 10);
        return result.exitCode === 0 && Number.isFinite(count) ? count : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  // Commits the worktree's own HEAD reflog reaches that no remote or local branch
  // holds: removing the worktree deletes that reflog, and with it the only reference.
  const reflogOnlyCommits = Effect.fn("WorktreeCleanupSweep.reflogOnly")(function* (cwd: string) {
    const reflog = yield* run(
      cwd,
      "WorktreeCleanupSweep.reflog",
      ["log", "-g", "--format=%H", "HEAD"],
      4 * 1024 * 1024,
    );
    if (reflog.stdoutTruncated || reflog.exitCode !== 0) return null;
    const commits = [...new Set(reflog.stdout.split("\n").filter((line) => line !== ""))];
    if (commits.length === 0) return 0;
    return yield* commitCount(cwd, "WorktreeCleanupSweep.reflogUnreached", [
      "rev-list",
      "--count",
      ...commits,
      "--not",
      "--remotes",
      "--branches",
    ]);
  });

  /** A stash entry made on `branch` (stashes are shared by every worktree of a repository). */
  const stashOnBranch = (cwd: string, branch: string | null) =>
    branch === null
      ? Effect.succeed(false)
      : run(cwd, "WorktreeCleanupSweep.stash", ["stash", "list", "--format=%gs"], 256 * 1024).pipe(
          Effect.map((result) =>
            result.exitCode !== 0 || result.stdoutTruncated
              ? null
              : result.stdout
                  .split("\n")
                  .some(
                    (line) =>
                      line.startsWith(`WIP on ${branch}:`) || line.startsWith(`On ${branch}:`),
                  ),
          ),
          Effect.orElseSucceed(() => null),
        );

  /** Git's `--directory` listing of a member without the members inside it; null when unreadable. */
  const listOthers = (state: MemberState, args: ReadonlyArray<string>, maxOutputBytes: number) =>
    run(
      state.path,
      "WorktreeCleanupSweep.listFiles",
      ["ls-files", "--others", ...args, "--directory", "-z"],
      maxOutputBytes,
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode !== 0 || result.stdoutTruncated
          ? Effect.succeed(null)
          : Effect.tryPromise(() =>
              entriesOutsideMembers(
                state.path,
                result.stdout.split("\0").filter((entry) => entry !== ""),
                state.inside,
              ),
            ).pipe(Effect.map((entries) => ({ raw: result.stdout, entries }))),
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Everything a member's own Git and folder say, short of the network. */
  const readMemberGit = Effect.fn("WorktreeCleanupSweep.readMemberGit")(function* (
    state: MemberState,
    chatBranch: string | null,
    inSet: boolean,
  ) {
    const status = yield* git.statusDetailsLocal(state.path).pipe(Effect.option);
    const statusRead = Option.isSome(status) && status.value.isRepo ? status.value : null;
    const branch = statusRead?.branch ?? null;
    state.head = yield* git.resolveCommit({ cwd: state.path, revision: "HEAD" }).pipe(
      Effect.map((commit) => commit.commitSha),
      Effect.orElseSucceed((): string | null => null),
    );
    // status.showUntrackedFiles=no hides new files from the status check.
    const untracked = yield* listOthers(state, ["--exclude-standard"], 64 * 1024);
    const ignored = yield* listOthers(state, ["--ignored", "--exclude-standard"], 1024 * 1024);
    const classified =
      ignored === null
        ? null
        : yield* Effect.tryPromise(() => classifyIgnored(state.path, ignored.entries)).pipe(
            Effect.orElseSucceed(() => null),
          );
    state.media = classified?.media ?? [];
    const hidden = yield* hiddenTrackedChangeReason(git, state.path).pipe(
      Effect.map((reason) => reason !== null),
      Effect.orElseSucceed(() => null),
    );
    const restorable =
      chatBranch === null
        ? null
        : !inSet
          ? true
          : yield* run(state.repository, "WorktreeCleanupSweep.branchExists", [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${chatBranch}`,
            ]).pipe(
              Effect.map((result) => result.exitCode === 0),
              Effect.orElseSucceed(() => null),
            );
    const facts: FinishedMemberGit = {
      branch,
      changes: statusRead === null ? null : statusRead.hasWorkingTreeChanges,
      untracked:
        untracked === null
          ? null
          : untracked.entries
              .filter((entry) => !onlyRebuildableUntracked(entry))
              .map((entry) => NodePath.basename(entry.replace(/\/$/, ""))),
      ignoredOther: classified?.other ?? null,
      media:
        classified === null
          ? null
          : {
              files: classified.media.length,
              bytes: classified.media.reduce((total, file) => total + file.bytes, 0),
            },
      hiddenTrackedChanges: hidden,
      stash: yield* stashOnBranch(state.path, branch),
      reflogOnlyCommits: yield* reflogOnlyCommits(state.path).pipe(
        Effect.orElseSucceed(() => null),
      ),
      unpushedCommits: yield* commitCount(state.path, "WorktreeCleanupSweep.unpushed", [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
      ]),
      restorable,
      nestedRepository: undefined,
      headInDefault: undefined,
      pullRequest: undefined,
    };
    state.git = facts;
    state.fingerprint = encodeJson([
      state.path,
      branch,
      state.head,
      facts.changes,
      untracked?.raw ?? null,
      ignored?.raw ?? null,
      hidden,
      facts.stash,
      facts.unpushedCommits,
    ]);
  });

  /** Host answers kept between sweeps, by repository, branch and head commit. */
  const pullRequestStates = new Map<
    string,
    { readonly state: FinishedPullRequest["state"]; readonly at: number }
  >();

  /** The repository's default branch on its primary remote, fetched once per sweep. */
  const defaultRef = Effect.fn("WorktreeCleanupSweep.defaultRef")(function* (
    repository: string,
    ctx: SweepContext,
  ) {
    if (ctx.defaultRefs.has(repository)) return ctx.defaultRefs.get(repository)!;
    const ref = yield* Effect.gen(function* () {
      const remote = yield* git.resolvePrimaryRemoteName(repository);
      const branch = yield* git.resolveDefaultBranchName(repository, remote);
      if (branch === null) return null;
      yield* git.fetchRemoteTrackingBranch({
        cwd: repository,
        remoteName: remote,
        remoteBranch: branch,
      });
      return `refs/remotes/${remote}/${branch}`;
    }).pipe(Effect.orElseSucceed(() => null));
    ctx.defaultRefs.set(repository, ref);
    return ref;
  });

  const readHeadInDefault = Effect.fn("WorktreeCleanupSweep.readHeadInDefault")(function* (
    state: MemberState,
    ctx: SweepContext,
    previous: MemberState | undefined,
  ) {
    if (state.git === undefined) return;
    if (
      previous?.git !== undefined &&
      previous.head === state.head &&
      previous.git.headInDefault !== undefined
    ) {
      state.base = previous.base;
      state.git = { ...state.git, headInDefault: previous.git.headInDefault };
      return;
    }
    let headInDefault: boolean | null = null;
    const ref = yield* defaultRef(state.repository, ctx);
    if (ref !== null && state.head !== null) {
      state.base = yield* git.resolveCommit({ cwd: state.path, revision: ref }).pipe(
        Effect.map((commit) => commit.commitSha),
        Effect.orElseSucceed((): string | null => null),
      );
      if (state.base !== null) {
        const ancestor = yield* run(state.path, "WorktreeCleanupSweep.integratedBranch", [
          "merge-base",
          "--is-ancestor",
          state.head,
          state.base,
        ]).pipe(Effect.orElseSucceed(() => null));
        headInDefault = ancestor?.exitCode === 0 ? true : ancestor?.exitCode === 1 ? false : null;
      }
    }
    state.git = { ...state.git, headInDefault };
  });

  const readPullRequest = Effect.fn("WorktreeCleanupSweep.readPullRequest")(function* (
    state: MemberState,
    previous: MemberState | undefined,
    ctx: SweepContext,
    /** A chat's own synced pull request says merged or closed. */
    finishedHint: boolean,
  ) {
    const facts = state.git;
    if (facts === undefined) return;
    if (facts.branch === null) {
      state.git = { ...facts, pullRequest: { state: "none", contentIntegrated: false } };
      return;
    }
    if (
      previous?.git !== undefined &&
      previous.head === state.head &&
      previous.git.pullRequest !== undefined
    ) {
      state.git = { ...facts, pullRequest: previous.git.pullRequest };
      return;
    }
    const branch = facts.branch;
    const cacheKey = encodeJson([state.repository, branch, state.head]);
    const cached = pullRequestStates.get(cacheKey);
    // Merged is final for this head. Other answers are reused for a while,
    // except an open or missing one the chat's own record already contradicts.
    const reusable =
      cached !== undefined &&
      (cached.state === "merged" ||
        (cached.at <= ctx.now &&
          ctx.now - cached.at < PULL_REQUEST_REUSE_MS &&
          !(finishedHint && cached.state !== "closed")));
    const pullRequest = reusable
      ? cached.state
      : yield* gitManager.branchPullRequest({ cwd: state.path, branch }, { refresh: true }).pipe(
          Effect.map((found) => found?.state ?? ("none" as const)),
          Effect.orElseSucceed(() => null),
        );
    if (pullRequest === null) {
      // A host that gave no answer is never remembered; the folder stays.
      state.git = { ...facts, pullRequest: null };
      return;
    }
    if (!reusable) {
      if (pullRequestStates.size >= PULL_REQUEST_CACHE_ENTRIES) pullRequestStates.clear();
      pullRequestStates.set(cacheKey, { state: pullRequest, at: ctx.now });
    }
    const contentIntegrated =
      pullRequest === "merged" &&
      (facts.headInDefault === true ||
        (state.head !== null &&
          state.base !== null &&
          (yield* worktreeHasNoAdditionalChanges(git, state.path, state.head, state.base).pipe(
            Effect.orElseSucceed(() => false),
          ))));
    state.git = { ...facts, pullRequest: { state: pullRequest, contentIntegrated } };
  });

  const readNested = Effect.fn("WorktreeCleanupSweep.readNested")(function* (
    state: MemberState,
    previous: MemberState | undefined,
  ) {
    const facts = state.git;
    if (facts === undefined) return;
    if (
      previous?.git !== undefined &&
      previous.head === state.head &&
      previous.git.nestedRepository !== undefined
    ) {
      state.git = { ...facts, nestedRepository: previous.git.nestedRepository };
      return;
    }
    // No exclude rules: every untracked path, ignored ones included.
    const listing = yield* listOthers(state, [], 1024 * 1024);
    const nestedRepository =
      listing === null
        ? null
        : yield* Effect.tryPromise({
            try: (signal) => findRepository(state.path, listing.entries, signal),
            catch: () => null,
          }).pipe(
            Effect.timeoutOption(NESTED_WALK_TIMEOUT),
            Effect.map((found) => (Option.isSome(found) ? found.value : null)),
            Effect.orElseSucceed(() => null),
          );
    state.git = { ...facts, nestedRepository };
  });

  /** Gathers what the decision asks for, stage by stage, and decides. */
  const assess = Effect.fn("WorktreeCleanupSweep.assess")(function* (
    group: FolderGroup,
    ctx: SweepContext,
    previous: Assessment | null,
  ) {
    const { folder, key } = group;
    if (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => true)))) return null;
    const spellings = [...new Set([...(yield* spellingsOf(folder)), key])];
    const ids = new Set(group.chats.map((chat) => chat.id));
    const heads = group.chats.filter(
      (chat) => chat.lineage.parentThreadId === null || !ids.has(chat.lineage.parentThreadId),
    );
    const owners = new Map(ctx.bindings.threads.map((owner) => [owner.threadId, owner]));
    // A chat is closed only when its shell and its stored row both say so.
    const stateOf = (chat: OrchestrationV2ThreadShell): FinishedChatState => {
      const owner = owners.get(chat.id);
      return owner === undefined || ownWorktreeThreadState(owner) === "open"
        ? "open"
        : chatState(chat);
    };
    const activity = group.chats.map(storageCleanupActivityAt);
    const branches = new Set(
      [
        ...group.chats.map((chat) => chat.branch),
        ...group.deleted.map((chat) => chat.branch),
      ].filter((branch): branch is NonNullable<typeof branch> => branch !== null),
    );
    const chatBranch = branches.size === 1 ? [...branches][0]! : null;
    const projectIds = new Set<ProjectId>([
      ...group.chats.map((chat) => chat.projectId),
      ...group.deleted.map((chat) => chat.projectId),
    ]);
    const rules = folderRules(ctx.settings, projectIds);

    const reach = yield* outOfReach(folder, key, ctx);
    const members: Array<MemberState> = [];
    let unreadable: string | null = null;
    let looseFiles = 0;
    if (reach.problem === null) {
      const manifestFile = worktreeSetManifestPath(folder, path);
      const inSet = yield* fs.exists(manifestFile).pipe(Effect.orElseSucceed(() => true));
      const set = inSet
        ? yield* readWorktreeSet(folder).pipe(Effect.orElseSucceed(() => null))
        : null;
      if (inSet && set === null) unreadable = "Its worktree-set manifest could not be read.";
      const listed: ReadonlyArray<WorktreeSetMember> = inSet
        ? (set?.members ?? [])
        : [{ repository: "", relativePath: "" }];
      for (const member of listed) {
        const memberPath = worktreeSetMemberPath(folder, member, path);
        // A member already gone has nothing left to lose.
        if (
          member.relativePath !== "" &&
          !(yield* fs.exists(memberPath).pipe(Effect.orElseSucceed(() => true)))
        )
          continue;
        const registration = yield* checkWorktreeRegistration(memberPath);
        let problem = registration.ok ? null : registration.problem;
        if (registration.ok && inSet) {
          const named = yield* realOrNull(path.join(member.repository, ".git"));
          if (named !== registration.commonDir)
            problem = "It is registered with another repository than its worktree set names.";
        }
        if (
          registration.ok &&
          member.relativePath === "" &&
          reach.localRepository !== null &&
          registration.repository !== reach.localRepository
        )
          problem = "It is registered with another repository than the one it sits in.";
        members.push({
          member,
          path: memberPath,
          repository: inSet || !registration.ok ? member.repository : registration.repository,
          registration: problem,
          locked: registration.ok && registration.locked,
          inside: [],
          head: null,
          base: null,
          media: [],
          fingerprint: "",
          git: undefined,
        });
      }
      for (const state of members) {
        (state as { inside: ReadonlyArray<string> }).inside = members
          .filter((other) => other !== state && inside(state.path, other.path))
          .map((other) => toPosix(path.relative(state.path, other.path)));
      }
      // Without a member at the folder itself, its own entries are nobody's.
      if (unreadable === null && !members.some((state) => state.member.relativePath === "")) {
        const entries = yield* fs.readDirectory(folder).pipe(
          Effect.flatMap((names) =>
            Effect.forEach(names, (name) =>
              fs
                .stat(path.join(folder, name))
                .pipe(Effect.map((stat) => `${name}${stat.type === "Directory" ? "/" : ""}`)),
            ),
          ),
          Effect.flatMap((names) =>
            Effect.tryPromise(() =>
              entriesOutsideMembers(
                folder,
                names,
                members.map((state) => toPosix(path.relative(folder, state.path))),
              ),
            ),
          ),
          Effect.orElseSucceed(() => null),
        );
        if (entries === null) unreadable = "Its folder could not be listed.";
        else looseFiles = entries.filter((entry) => entry !== ".DS_Store").length;
      }
    }

    const {
      threads: nearbyOwners,
      sessions,
      terminals,
    } = yield* worktreeOwnersOf(ctx.bindings, spellings, {
      match: "overlapping",
      terminals: options.liveTerminals(),
    }).pipe(Effect.provideContext(services));
    const nearby = nearbyOwners.find(
      (owner) =>
        isOpenThreadOwner(owner) && !owner.paths.some((spelling) => spellings.includes(spelling)),
    );
    const realFolder = (yield* realOrNull(folder)) ?? folder;
    const processInside =
      ctx.processCwds?.some(
        (cwd) => pathWithin(path, realFolder, cwd) || pathWithin(path, folder, cwd),
      ) ?? false;
    const inUse =
      terminals.length > 0
        ? "A terminal is open in it."
        : sessions.length > 0
          ? "An agent session works in it."
          : processInside
            ? "A process works in it."
            : null;

    const deletedCleanupPending =
      group.chats.length > 0 || group.deleted.length === 0
        ? false
        : (yield* Effect.forEach(
            group.deleted,
            (chat) =>
              sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${chat.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `,
          )).some((rows) => rows.length > 0);
    const chatFacts =
      group.chats.length === 0
        ? null
        : {
            heads: heads.map((chat) => ({ title: chat.title, state: stateOf(chat) })),
            notQuiet:
              group.chats.find((chat) => !storageCleanupThreadIdle(chat, ctx.now))?.title ?? null,
            newestActivityAt: activity.includes(null) ? null : newestFinite(activity),
            pullRequestFinished: heads.some((chat) =>
              (chat.pullRequests ?? []).some(
                (link) => link.snapshot?.state === "merged" || link.snapshot?.state === "closed",
              ),
            ),
          };
    const facts = (): FinishedFolderFacts => ({
      chats: chatFacts,
      deleted: group.chats.length === 0 ? { cleanupPending: deletedCleanupPending } : null,
      chatBranch,
      outOfReach: reach.problem,
      unreadable,
      openNearby:
        nearby === undefined
          ? null
          : `${nearby.title ?? nearby.threadId} uses a folder inside it or around it.`,
      inUse,
      processesUnknown: ctx.processCwds === null,
      looseFiles,
      members: members.map((state) => ({
        relativePath: state.member.relativePath,
        registration: state.registration,
        locked: state.locked,
        git: state.git,
      })),
    });
    const before = (state: MemberState) =>
      previous?.members.find((other) => other.path === state.path);
    const gather = (needs: FinishedWorktreeNeed) =>
      Effect.forEach(
        members.filter((state) => state.registration === null),
        (state) =>
          needs === "git"
            ? readMemberGit(state, chatBranch, members.length > 1 || state.member.repository !== "")
            : needs === "default-branch"
              ? readHeadInDefault(state, ctx, before(state))
              : needs === "pull-request"
                ? readPullRequest(
                    state,
                    before(state),
                    ctx,
                    chatFacts?.pullRequestFinished ?? false,
                  )
                : readNested(state, before(state)),
        { discard: true },
      );

    let decision = decideFinishedWorktree(facts(), rules, ctx.now);
    for (let round = 0; decision.action === "keep" && decision.needs !== undefined; round += 1) {
      if (round === 4) {
        decision = { action: "keep", reason: "unknown", detail: "It could not be fully checked." };
        break;
      }
      yield* gather(decision.needs);
      decision = decideFinishedWorktree(facts(), rules, ctx.now);
    }
    const owner = heads[0] ?? group.chats[0];
    return {
      group,
      decision,
      members,
      fingerprint: encodeJson([
        group.chats.map((chat) => [chat.id, stateOf(chat), storageCleanupActivityAt(chat)]),
        nearbyOwners.map((entry) => [entry.threadId, worktreeThreadState(entry)]),
        rules,
        inUse,
        ctx.processCwds === null,
        looseFiles,
        unreadable,
        members.map((state) => [state.registration, state.locked, state.fingerprint]),
      ]),
      head:
        owner !== undefined
          ? { id: owner.id, title: owner.title }
          : group.deleted[0] !== undefined
            ? { id: group.deleted[0].id, title: group.deleted[0].title }
            : null,
      threadCount: group.chats.length + group.deleted.length,
    } satisfies Assessment;
  });

  /** Copies ignored media to evidence and checks each copy by size. False when any copy failed. */
  const copyMedia = Effect.fn("WorktreeCleanupSweep.copyMedia")(function* (
    assessment: Assessment,
    now: number,
  ) {
    const files = assessment.members.flatMap((state) =>
      state.media.map((file) => ({ state, file })),
    );
    if (files.length === 0) return true;
    const base = path.join(
      config.baseDir,
      "evidence",
      "removed-worktrees",
      `${path.basename(assessment.group.folder)}-${evidenceStamp(now)}`,
    );
    return yield* Effect.gen(function* () {
      let target = base;
      for (let index = 2; yield* fs.exists(target); index += 1) target = `${base}-${index}`;
      for (const { state, file } of files) {
        const source = path.join(state.path, file.relative);
        const copy = path.join(target, state.member.relativePath, file.relative);
        yield* fs.makeDirectory(path.dirname(copy), { recursive: true });
        yield* fs.copyFile(source, copy);
        const sizes = [(yield* fs.stat(source)).size, (yield* fs.stat(copy)).size];
        if (sizes.some((size) => Number(size) !== file.bytes)) return false;
      }
      yield* fs.writeFileString(
        path.join(target, "manifest.json"),
        `${encodeJson({
          folder: assessment.group.folder,
          removedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          reason: assessment.decision.reason,
          members: assessment.members.map((state) => ({
            relativePath: state.member.relativePath,
            repository: state.repository,
            branch: state.git?.branch ?? null,
            head: state.head,
          })),
          files: files.map(({ state, file }) => ({
            member: state.member.relativePath,
            path: file.relative,
            bytes: file.bytes,
          })),
        })}\n`,
      );
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("storage cleanup could not copy media to evidence", {
          folder: assessment.group.folder,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
  });

  /** Removes a folder that holds nothing, or only Finder's `.DS_Store`. */
  const removeIfEmpty = (folder: string) =>
    fs.readDirectory(folder).pipe(
      Effect.flatMap((names) =>
        names.every((name) => name === ".DS_Store")
          ? fs.remove(folder, { recursive: true })
          : Effect.void,
      ),
      Effect.ignore,
    );

  /**
   * Removes the members deepest first without force, stopping at the first
   * Git refuses; then prunes each repository's registrations and removes the
   * folders left empty. Branches and the manifest stay.
   */
  const removeMembers = Effect.fn("WorktreeCleanupSweep.removeMembers")(function* (
    assessment: Assessment,
  ) {
    const depth = (state: MemberState) =>
      state.member.relativePath === "" ? 0 : state.member.relativePath.split(path.sep).length;
    for (const state of assessment.members.toSorted((left, right) => depth(right) - depth(left))) {
      const removal = yield* git
        .removeWorktree({ cwd: state.repository, path: state.path, force: false })
        .pipe(Effect.result);
      if (removal._tag === "Failure") {
        yield* Effect.logWarning("storage cleanup could not remove a worktree; the rest stays", {
          folder: assessment.group.folder,
          member: state.member.relativePath,
          error: removal.failure,
        });
        return false;
      }
    }
    for (const repository of new Set(assessment.members.map((state) => state.repository))) {
      yield* git.pruneWorktrees({ cwd: repository }).pipe(Effect.ignore);
      yield* gitManager.invalidateStatus(repository);
    }
    const folder = assessment.group.folder;
    for (const state of assessment.members) {
      let parent = path.dirname(state.path);
      while (inside(folder, parent)) {
        yield* removeIfEmpty(parent);
        parent = path.dirname(parent);
      }
    }
    if (yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))
      yield* removeIfEmpty(folder);
    return true;
  });

  const measure = (folder: string) =>
    Effect.tryPromise({
      try: (signal) => folderBytes(folder, signal),
      catch: () => null,
    }).pipe(
      Effect.timeoutOption(SIZE_WALK_TIMEOUT),
      Effect.map((bytes) => (Option.isSome(bytes) ? bytes.value : null)),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Under the lease: reads everything again, keeps the folder on any change,
   * copies its media, then removes it. Returns the decision that stands.
   */
  const applyRemoval = Effect.fn("WorktreeCleanupSweep.applyRemoval")(function* (
    first: Assessment,
    ctx: SweepContext,
  ) {
    const changed = (detail: string): FinishedWorktreeDecision => ({
      action: "keep",
      reason: "unknown",
      detail,
    });
    const settings = yield* settingsService.getSettings;
    const snapshot = yield* readThreads();
    const groups = yield* readGroups(snapshot.threads, settings);
    const group = groups.find((entry) => entry.key === first.group.key);
    if (group === undefined) return changed("Its chats changed while it was checked.");
    const again = yield* assess(
      group,
      {
        ...ctx,
        settings,
        bindings: yield* readBindings,
        projects: snapshot.projects,
        processCwds: yield* readProcessCwds,
      },
      first,
    );
    if (
      again === null ||
      again.fingerprint !== first.fingerprint ||
      again.decision.action !== "remove" ||
      again.decision.reason !== first.decision.reason
    )
      return changed("Something in it or about it changed while it was checked.");
    if (!(yield* copyMedia(again, ctx.now)))
      return {
        action: "keep",
        reason: "media",
        detail: "Copying its media to evidence failed.",
      } as const;
    if (!(yield* removeMembers(again)))
      return changed("Git refused to remove one of its worktrees; the rest stays.");
    yield* Effect.logInfo("storage cleanup removed worktree", {
      folder: first.group.folder,
      reason: again.decision.reason,
      threadIds: [...group.chats, ...group.deleted].map((chat) => chat.id),
    });
    return again.decision;
  });

  const runSweep = Effect.fn("WorktreeCleanupSweep.run")(function* (
    mode: WorktreeSweepMode,
    settings: ServerSettings,
    now: number,
  ) {
    const empty: WorktreeSweepResult = { items: [], removed: [], complete: false };
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(settings, config.worktreesDir, path)) {
      // An unmounted drive only skips its own worktrees.
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    // Unreadable ownership skips the whole pass: never remove on a guess.
    const read = yield* Effect.all({
      snapshot: readThreads(),
      bindings: readBindings,
    }).pipe(Effect.option);
    if (Option.isNone(read)) return empty;
    const groups = yield* readGroups(read.value.snapshot.threads, settings).pipe(Effect.option);
    if (Option.isNone(groups)) return empty;
    const ctx: SweepContext = {
      mode,
      settings,
      now,
      bindings: read.value.bindings,
      projects: read.value.snapshot.projects,
      roots,
      processCwds: yield* readProcessCwds,
      defaultRefs: new Map(),
    };
    const items: Array<StorageCleanupPlanItem> = [];
    const removed: Array<{ readonly path: string; readonly bytes: number | null }> = [];
    let complete = true;
    for (const group of groups.value) {
      const outcome = yield* Effect.gen(function* () {
        const assessment = yield* assess(group, ctx, null);
        if (assessment === null) return null;
        let decision = assessment.decision;
        let bytes: number | null = null;
        if (mode === "plan" || decision.action === "remove") bytes = yield* measure(group.folder);
        if (mode === "apply" && decision.action === "remove") {
          const leasePaths = [...new Set([group.folder, group.key])].sort();
          decision = yield* leasePaths.reduceRight(
            (effect, leasePath) => withWorkspaceLease(leasePath, effect),
            applyRemoval(assessment, ctx),
          );
          if (decision.action === "remove") removed.push({ path: group.folder, bytes });
        }
        return { assessment, decision, bytes };
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("storage cleanup could not check a worktree", {
              folder: group.folder,
              cause,
            }).pipe(Effect.as("failed" as const)),
        ),
      );
      if (outcome === null) continue;
      const head = outcome === "failed" ? null : outcome.assessment.head;
      const decision: FinishedWorktreeDecision =
        outcome === "failed"
          ? { action: "keep", reason: "unknown", detail: "It could not be checked." }
          : outcome.decision;
      const bytes = outcome === "failed" ? null : outcome.bytes;
      if (outcome === "failed" || (mode === "plan" && bytes === null)) complete = false;
      if (decision.action === "keep" && mode === "apply")
        yield* Effect.logDebug("storage cleanup kept worktree", {
          folder: group.folder,
          reason: decision.reason,
          detail: decision.detail,
        });
      items.push({
        kind: "worktree",
        path: group.folder,
        action: decision.action,
        reason: decision.reason,
        detail: decision.detail,
        bytes,
        threadId: head?.id ?? null,
        threadTitle: head?.title ?? null,
        threadCount: group.chats.length + group.deleted.length,
      });
    }
    return { items, removed, complete } satisfies WorktreeSweepResult;
  });
  return (mode: WorktreeSweepMode, settings: ServerSettings, now: number) =>
    runSweep(mode, settings, now).pipe(Effect.provideContext(services));
});
