/**
 * The chat worktree pass of the storage sweep: one function with a mode.
 * "plan" lists every chat folder with what the sweep would do and why, and
 * changes nothing, not even a fetch: it compares with the default branch as
 * last fetched; "apply" gathers the same facts, asks the same decision
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
 * quickly is read again; any change keeps the folder. Ignored media, reports
 * and SpecWeave state are copied to `<baseDir>/evidence/removed-worktrees/`
 * first. Members go deepest first, never forced; branches and the
 * worktree-set manifest stay, so a chat that resumes gets its folder back. A
 * removal Git could not finish leaves the folder untouched and on record
 * (worktreeRemovalFailures.ts).
 *
 * @module worktreeCleanupSweep
 */
import {
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerSettings,
  type StorageCleanupPlanItem,
  type TerminalSummary,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveWorktreeCleanup } from "@specweave-studio/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
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
  type FinishedWorktreeDecision,
  type FinishedWorktreeNeed,
} from "./finishedWorktrees.ts";
import * as GitManager from "./git/GitManager.ts";
import {
  canonicalPath,
  isOpenThreadOwner,
  listWorktreeBindings,
  ownWorktreeThreadState,
  pathSpellings,
  pathWithin,
  worktreeOwnersOf,
  worktreeThreadState,
} from "./git/worktreeOwnership.ts";
import { checkWorktreeRegistration } from "./git/worktreeRegistration.ts";
import { listProcessCwds } from "./homeUsage/processCwds.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as Settings from "./serverSettings.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import {
  readWorktreeSet,
  worktreeSetManifestPath,
  worktreeSetMemberPath,
  type WorktreeSetMember,
} from "./worktreeSet.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import {
  type Assessment,
  type DeletedChat,
  encodeJson,
  type FolderGroup,
  makeMemberFacts,
  type MemberState,
  reflogOnlyCommits,
  type SweepContext,
  type WorktreeSweepMode,
} from "./worktreeCleanupMemberFacts.ts";
import { makeRemoval } from "./worktreeCleanupRemoval.ts";
import {
  anyWorktreePolicy,
  folderRules,
  storageCleanupActivityAt,
  storageCleanupFollowsParent,
  storageCleanupThreadFinished,
  storageCleanupThreadIdle,
} from "./worktreeCleanupRules.ts";
import {
  entriesOutsideMembers,
  folderBytes,
  SIZE_WALK_BUDGET_MS,
  SIZE_WALK_TIMEOUT_MS,
} from "./worktreeCleanupWalks.ts";
import {
  removalFailureDetail,
  removalFailureStands,
  WorktreeRemovalFailures,
} from "./worktreeRemovalFailures.ts";

export { anyWorktreePolicy, reflogOnlyCommits, storageCleanupActivityAt, storageCleanupThreadIdle };

const decodeDeletedThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

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

export type { WorktreeSweepMode };

export interface WorktreeSweepResult {
  readonly items: ReadonlyArray<StorageCleanupPlanItem>;
  /** Folders removed in apply mode, with their size outside dependency installs. */
  readonly removed: ReadonlyArray<{ readonly path: string; readonly bytes: number | null }>;
  /** False when ownership could not be read or a folder could not be checked. A missing size leaves it true. */
  readonly complete: boolean;
}

export interface WorktreeSweepOptions {
  /**
   * Only the folders these chats use are checked: the pass an event asks for.
   * Without it every folder is.
   */
  readonly onlyThreads?: ReadonlySet<string>;
}

const toPosix = (value: string) => value.split("\\").join("/");

function chatState(thread: OrchestrationV2ThreadShell, now: number): FinishedChatState {
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledOverride === "settled") return "resolved";
  return storageCleanupThreadFinished(thread, now) ? "finished" : "open";
}

export const makeWorktreeCleanupSweep = Effect.fn("WorktreeCleanupSweep.make")(function* (options: {
  /** Live terminals, as the storage cleanup tracks them. */
  readonly liveTerminals: () => ReadonlyArray<TerminalSummary>;
  /**
   * True when another instance of the app records chats in these folders; read
   * again before each removal, since one may start while a sweep runs.
   */
  readonly sharedWithAnotherInstance?: Effect.Effect<boolean>;
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

  const readThreads = Effect.fn("WorktreeCleanupSweep.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    // A snapshot lists archived chats under `archivedThreads`, whichever
    // location was asked for; every list is read so none is missed.
    const byId = new Map<string, OrchestrationV2ThreadShell>();
    for (const thread of [
      ...active.threads,
      ...active.archivedThreads,
      ...archived.threads,
      ...archived.archivedThreads,
    ])
      byId.set(thread.id, thread);
    return { projects, threads: [...byId.values()] };
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

  /** The member's real path is the folder's real path plus its own relative path. */
  const memberStaysInside = Effect.fn("WorktreeCleanupSweep.memberStaysInside")(function* (
    folder: string,
    memberPath: string,
  ) {
    if (!inside(path.resolve(folder), path.resolve(memberPath))) return false;
    const realFolder = yield* realOrNull(folder);
    const realMember = yield* realOrNull(memberPath);
    if (
      realFolder === null ||
      realMember === null ||
      realMember !==
        path.join(realFolder, path.relative(path.resolve(folder), path.resolve(memberPath)))
    )
      return false;
    // A volume mounted at the member's path has the same real path and other files.
    return yield* Effect.all([fs.stat(realFolder), fs.stat(realMember)]).pipe(
      Effect.map(([folderStat, memberStat]) => folderStat.dev === memberStat.dev),
      Effect.orElseSucceed(() => false),
    );
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
      return { problem: null, unreadable: "It could not be read.", localRepository: null };
    // Roots are canonical, so a symlinked parent (a linked drive) is fine; a
    // symlinked folder is not.
    if (realFolder !== path.join(realParent, path.basename(folder)))
      return {
        problem: null,
        unreadable: "It is reached through a symbolic link.",
        localRepository: null,
      };
    const localRepository = ctx.roots.some((root) => inside(root, realFolder))
      ? null
      : yield* projectLocalRepository(realFolder, ctx.projects);
    if (!ctx.roots.some((root) => inside(root, realFolder)) && localRepository === null)
      return {
        problem: "It is outside the app's worktree folders.",
        unreadable: null,
        localRepository,
      };
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
        return { problem: "A project's folder is inside it.", unreadable: null, localRepository };
    }
    return { problem: null, unreadable: null, localRepository };
  });

  const facts = makeMemberFacts({ git, gitManager, fs, path });
  const { readMemberGit, readHeadInDefault, readPullRequest, readNested } = facts;

  /**
   * Who uses the folder right now: its chats and their states, chats of
   * folders around it, terminals, agent sessions and processes. Reads no Git,
   * so it is cheap enough to read again before each removal. `key` is equal
   * for two readings exactly when nothing about its use changed.
   */
  const readLive = Effect.fn("WorktreeCleanupSweep.readLive")(function* (
    group: FolderGroup,
    ctx: SweepContext,
  ) {
    const { folder, key } = group;
    const spellings = [...new Set([...(yield* spellingsOf(folder)), key])];
    const owners = new Map(ctx.bindings.threads.map((owner) => [owner.threadId, owner]));
    // A chat is closed only when its shell and its stored row both say so,
    // and finished only when its stored runs show none in progress either.
    const stateOf = (chat: OrchestrationV2ThreadShell): FinishedChatState => {
      const owner = owners.get(chat.id);
      if (owner === undefined) return "open";
      const shell = chatState(chat, ctx.now);
      if (ownWorktreeThreadState(owner) === "open")
        return shell === "finished" && owner.busy === false ? "finished" : "open";
      return shell === "finished" ? "open" : shell;
    };
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
    // A session record of a chat of this folder that is itself finished is a
    // session at rest: the process list below still catches one that works.
    const atRest = new Set(
      group.chats.filter((chat) => stateOf(chat) !== "open").map((chat) => chat.id as string),
    );
    const working = sessions.filter((session) => !atRest.has(session.threadId));
    const inUse =
      terminals.length > 0
        ? "A terminal is open in it."
        : working.length > 0
          ? "An agent session works in it."
          : processInside
            ? "A process works in it."
            : null;
    return {
      stateOf,
      nearbyOwners,
      nearby,
      inUse,
      key: encodeJson([
        group.chats.map((chat) => [
          chat.id,
          stateOf(chat),
          storageCleanupActivityAt(chat),
          storageCleanupThreadIdle(chat, ctx.now),
        ]),
        group.deleted.map((chat) => chat.id),
        nearbyOwners.map((entry) => [entry.threadId, worktreeThreadState(entry)]),
        inUse,
        ctx.processCwds === null,
      ]),
    };
  });

  /** Gathers what the decision asks for, stage by stage, and decides. */
  const assess = Effect.fn("WorktreeCleanupSweep.assess")(function* (
    group: FolderGroup,
    ctx: SweepContext,
    previous: Assessment | null,
  ) {
    const { folder, key } = group;
    if (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => true)))) return null;
    const ids = new Set(group.chats.map((chat) => chat.id));
    // Only a sub-chat its parent started follows that parent. A fork shares
    // the folder too, but a person works in it: it decides as a head.
    const heads = group.chats.filter(
      (chat) =>
        chat.lineage.relationshipToParent !== "subagent" ||
        chat.lineage.parentThreadId === null ||
        !ids.has(chat.lineage.parentThreadId),
    );
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
    let unreadable: string | null = reach.unreadable;
    let looseFiles = 0;
    if (reach.problem === null && reach.unreadable === null) {
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
        // A member already gone has nothing left to lose; neither has the
        // empty folder a removal left where it was.
        if (
          member.relativePath !== "" &&
          (!(yield* fs.exists(memberPath).pipe(Effect.orElseSucceed(() => true))) ||
            (yield* fs.readDirectory(memberPath).pipe(
              Effect.map((names) => names.every((name) => name === ".DS_Store")),
              Effect.orElseSucceed(() => false),
            )))
        )
          continue;
        // A member is a folder of this folder: one that leads elsewhere (a
        // manifest path that climbs out, a symbolic link) may be another
        // chat's worktree, so nothing is read in it and nothing removed.
        if (member.relativePath !== "" && !(yield* memberStaysInside(folder, memberPath))) {
          members.push({
            member,
            path: memberPath,
            repository: member.repository,
            registration: "It is outside its folder, or reached through a symbolic link.",
            locked: false,
            inside: [],
            head: null,
            base: null,
            media: [],
            fingerprint: "",
            git: undefined,
          });
          continue;
        }
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

    const live = yield* readLive(group, ctx);
    const { stateOf, nearby, inUse } = live;

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
              group.chats.find(
                (chat) =>
                  !storageCleanupThreadIdle(chat, ctx.now) &&
                  !storageCleanupFollowsParent(chat, ids),
              )?.title ?? null,
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
                : readNested(state),
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
      liveness: live.key,
      chatBranch,
      fingerprint: encodeJson([
        live.key,
        rules,
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

  /** The app's worktree folders that exist, as the running sweep found them. */
  let managedRoots: ReadonlyArray<string> = [];
  const failures = new WorktreeRemovalFailures(config.stateDir);
  const { copyMedia, discardEvidence, removeMembers } = makeRemoval({
    git,
    gitManager,
    fs,
    path,
    baseDir: config.baseDir,
    platform,
    managedRoots: () => managedRoots,
    inside,
    realOrNull,
    memberStaysInside,
    readMemberGit,
    readNested,
  });

  /** A folder's size within `budgetMs`; null (size unknown) past it or past the entry limit. */
  const measure = (folder: string, budgetMs: number) =>
    budgetMs <= 0
      ? Effect.succeed(null)
      : Effect.tryPromise({
          try: (signal) => folderBytes(folder, signal),
          catch: () => null,
        }).pipe(
          Effect.timeoutOption(Duration.millis(Math.min(SIZE_WALK_TIMEOUT_MS, budgetMs))),
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
    /** Everything read again; null when anything differs from `before` or it no longer goes. */
    const lookAgain = Effect.fn("WorktreeCleanupSweep.lookAgain")(function* (before: Assessment) {
      const settings = yield* settingsService.getSettings;
      const snapshot = yield* readThreads();
      const groups = yield* readGroups(snapshot.threads, settings);
      const group = groups.find((entry) => entry.key === first.group.key);
      if (group === undefined) return null;
      const again = yield* assess(
        group,
        {
          ...ctx,
          settings,
          bindings: yield* readBindings,
          projects: snapshot.projects,
          processCwds: yield* readProcessCwds,
        },
        before,
      );
      return again === null ||
        again.fingerprint !== before.fingerprint ||
        again.decision.action !== "remove" ||
        again.decision.reason !== first.decision.reason
        ? null
        : again;
    });
    const again = yield* lookAgain(first);
    if (again === null) return changed("Something in it or about it changed while it was checked.");
    let last = again;
    let evidence: string | null = null;
    if (again.members.some((state) => state.media.length > 0)) {
      evidence = yield* copyMedia(again, ctx.now);
      if (evidence === null)
        return {
          action: "keep",
          reason: "media",
          detail: "Copying its media to evidence failed.",
        } as const;
      // Copying can take minutes, and Git deletes ignored files without asking.
      const afterCopy = yield* lookAgain(again);
      if (afterCopy === null) {
        yield* discardEvidence(evidence);
        return changed("Something in it changed while its media was copied to evidence.");
      }
      last = afterCopy;
    }
    const liveness = last.liveness;
    const stillFree = Effect.gen(function* () {
      if (
        options.sharedWithAnotherInstance !== undefined &&
        (yield* options.sharedWithAnotherInstance)
      )
        return false;
      const snapshot = yield* readThreads();
      const groups = yield* readGroups(snapshot.threads, yield* settingsService.getSettings);
      const group = groups.find((entry) => entry.key === first.group.key);
      if (group === undefined) return false;
      const live = yield* readLive(group, {
        ...ctx,
        bindings: yield* readBindings,
        projects: snapshot.projects,
        processCwds: yield* readProcessCwds,
      });
      return live.key === liveness;
      // Anything unreadable counts as changed.
    }).pipe(Effect.orElseSucceed(() => false));
    const removal = yield* removeMembers(last, stillFree);
    if (removal.stopped !== null) {
      // Nothing went, so the copies made for this removal are not needed.
      if (removal.gone === 0 && evidence !== null) yield* discardEvidence(evidence);
      if (removal.failure !== null) {
        failures.record(first.group.key, removal.failure);
        yield* Effect.logWarning("storage cleanup left a worktree Git could not remove", {
          folder: first.group.folder,
          member: removal.failure.member,
          what: removal.failure.what,
          holders: removal.failure.holders,
        });
        return changed(removalFailureDetail(removal.failure));
      }
      const why = "It changed, or its use did, right before removal";
      return changed(
        removal.gone === 0
          ? `${why}; nothing was removed.`
          : `${why} after ${removal.gone} of its worktrees were removed; they come back when the chat resumes.`,
      );
    }
    // Counted as removed only when the folder is gone.
    if (yield* fs.exists(first.group.folder).pipe(Effect.orElseSucceed(() => true)))
      return changed("Its worktrees were removed; what is left in the folder stays.");
    failures.clear(first.group.key);
    yield* Effect.logInfo("storage cleanup removed worktree", {
      folder: first.group.folder,
      reason: last.decision.reason,
      threadIds: [...last.group.chats, ...last.group.deleted].map((chat) => chat.id),
    });
    return last.decision;
  });

  const runSweep = Effect.fn("WorktreeCleanupSweep.run")(function* (
    mode: WorktreeSweepMode,
    settings: ServerSettings,
    now: number,
    sweepOptions: WorktreeSweepOptions,
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
    const allGroups = yield* readGroups(read.value.snapshot.threads, settings).pipe(Effect.option);
    if (Option.isNone(allGroups)) return empty;
    managedRoots = roots;
    const only = sweepOptions.onlyThreads;
    const groups = {
      value:
        only === undefined
          ? allGroups.value
          : allGroups.value.filter((group) =>
              [...group.chats, ...group.deleted].some((chat) => only.has(chat.id)),
            ),
    };
    const sizesStartedAt = yield* Clock.currentTimeMillis;
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
        if (assessment === null) {
          // The folder is gone, so what Git once left in it is too.
          if (mode === "apply") failures.clear(group.key);
          return null;
        }
        let decision = assessment.decision;
        let bytes: number | null = null;
        if (mode === "plan" || decision.action === "remove") {
          // Media is copied to evidence first, so removing the folder does not free it.
          const media = assessment.members.reduce(
            (total, state) => total + state.media.reduce((sum, file) => sum + file.bytes, 0),
            0,
          );
          // The walks of one plan share a budget; a folder past it reads "size unknown".
          const spent = (yield* Clock.currentTimeMillis) - sizesStartedAt;
          const measured = yield* measure(group.folder, SIZE_WALK_BUDGET_MS - spent);
          bytes = measured === null ? null : Math.max(0, measured - media);
        }
        // A folder Git could not remove says so until it is gone; it is not
        // tried again while Git has no registration to remove it by.
        const failure = failures.get(group.key);
        if (failure !== undefined) {
          const stands = removalFailureStands(failure, {
            registrationBroken: assessment.members.some((state) => state.registration !== null),
            now,
          });
          if (stands)
            decision = { action: "keep", reason: "unknown", detail: removalFailureDetail(failure) };
          else if (mode === "apply") failures.clear(group.key);
        }
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
      if (outcome === "failed") complete = false;
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
  return (
    mode: WorktreeSweepMode,
    settings: ServerSettings,
    now: number,
    sweepOptions: WorktreeSweepOptions = {},
  ) => runSweep(mode, settings, now, sweepOptions).pipe(Effect.provideContext(services));
});
