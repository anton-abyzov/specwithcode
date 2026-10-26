/**
 * Changing a project's main folder after work has started. Threads that run in
 * the project folder follow it on their next turn; this also rebinds threads
 * bound to a checkout inside the old folder, copies Claude sessions so they
 * resume from the new folder, and closes idle agent processes still running in
 * the old one. When the old folder stays a checkout of another repository (a
 * repository project moving up to its umbrella), its threads keep running there
 * instead, and only the coordinator follows the project. Memory, plans and history are keyed by project and stay as they
 * are. The same operation serves Project settings, the CLI and an approved
 * agent request.
 *
 * The check also reports what the new folder holds (FolderLayout) and which
 * SpecWeave planning root plan cards would read. When that root changes, the
 * change is refused until the user confirms it; changing back restores the
 * old reading, since links and increments are never rewritten here.
 *
 * Some folders are refused outright (ProjectFolderCheck.refusal): a file, a
 * protected folder, a folder whose Git identity could not be read (keeping
 * threads in place depends on it) and a folder the project's approved folders
 * clash with. The change binds kept threads before it moves the root and undoes
 * those binds if anything after them fails, so a refused change leaves every
 * thread where it was.
 */
import {
  CommandId,
  ProjectFolderCheckError,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectFolderCheck,
  type ProjectId,
  type RuntimeRequestId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  claudeHomeFromContinuationKey,
  relocateClaudeTranscript,
} from "../provider/Drivers/ClaudeTranscriptTransfer.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { planningImpact, readFolderLayout } from "./FolderLayout.ts";
import {
  exposesProtectedRealPath,
  normalizeProjectEnvironment,
} from "./ProjectEnvironmentPaths.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

export interface ProjectFolderChangeInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  /** The user accepted a folder whose repository differs from the current one. */
  readonly confirmDifferentRepository?: boolean;
  /** The user accepted that plan cards will read another SpecWeave planning root. */
  readonly confirmPlanningImpact?: boolean;
  /** Internal: the approval card that asked for this change, see ProjectUpdateInput. */
  readonly approvalRequestId?: RuntimeRequestId;
}

export interface ProjectFolderChangeResult {
  readonly project: Project;
  readonly previousRoot: string;
  readonly reboundWorktrees: number;
  readonly keptInPlace: number;
  readonly relocatedSessions: number;
}

export class ProjectFolderService extends Context.Service<
  ProjectFolderService,
  {
    readonly check: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly approvalRequestId?: RuntimeRequestId;
    }) => Effect.Effect<ProjectFolderCheck, ProjectFolderCheckError>;
    readonly change: (
      input: ProjectFolderChangeInput,
    ) => Effect.Effect<
      ProjectFolderChangeResult,
      ProjectService.ProjectServiceError | ProjectFolderCheckError
    >;
  }
>()("specweave-studio/project/ProjectFolderService") {}

/** `candidate` is `root` or below it; returns the path relative to `root`, else null. */
function relativeWithin(path: Path.Path, root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (relative === "") return "";
  // `..cache` is a child named like that, not a step up.
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null
    : relative;
}

/** `child` is below `parent`, not `parent` itself. */
function strictlyInside(path: Path.Path, parent: string, child: string): boolean {
  const relative = relativeWithin(path, parent, child);
  return relative !== null && relative !== "";
}

const PENDING_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * True while a thread holds work the folder must not move under: what
 * ProjectService.threadHasActiveWork counts, plus a queued or waiting run and
 * messages held in its queue. The run that asked for this change through
 * `approvalRequestId` waits on the change itself, so its status does not count.
 * Local on purpose: deleting and archiving keep the narrower rule.
 */
export function threadBlocksFolderChange(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activeRunId" | "pendingRuntimeRequest" | "status" | "activityRunStatus" | "heldQueuedCount"
  >,
  approvalRequestId?: RuntimeRequestId,
): boolean {
  if (ProjectService.threadHasActiveWork(thread, approvalRequestId)) return true;
  if ((thread.heldQueuedCount ?? 0) > 0) return true;
  const asking =
    approvalRequestId !== undefined && thread.pendingRuntimeRequest?.id === approvalRequestId;
  if (asking) return thread.status === "queued";
  return (
    (thread.status !== undefined && PENDING_RUN_STATUSES.has(thread.status)) ||
    (thread.activityRunStatus ?? null) !== null
  );
}

function titles(shells: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "title">>): string {
  return shells.map((thread) => `"${thread.title || "Untitled thread"}"`).join(", ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One paragraph on what plan cards read before and after, or null when nothing changes. */
export function planningImpactText(
  check: Pick<ProjectFolderCheck, "planning" | "currentRoot">,
): string | null {
  const planning = check.planning;
  if (planning === undefined || !planning.changes) return null;
  const before =
    planning.currentRoot === null
      ? "no SpecWeave increments"
      : `${plural(planning.currentIncrements, "increment")} in ${planning.currentRoot}`;
  const after =
    planning.targetRoot === null
      ? "none"
      : `${plural(planning.targetIncrements, "increment")} in ${planning.targetRoot}`;
  const broken =
    planning.brokenLinks.length === 0
      ? ""
      : ` ${plural(planning.brokenLinks.length, "thread link")} to ${planning.brokenLinks.slice(0, 5).join(", ")}${planning.brokenLinks.length > 5 ? " and others" : ""} would show "not found".`;
  return `Plan cards read ${before} now and would read ${after} after the change.${broken} Nothing is deleted or rewritten: changing the folder back to ${check.currentRoot} restores them.`;
}

/** The refusal the user reads when a check says the change cannot happen yet. */
export function folderChangeRefusal(
  check: ProjectFolderCheck,
  confirmDifferentRepository: boolean,
  confirmPlanningImpact = false,
): Pick<ProjectService.ProjectFolderChangeError, "reason" | "detail"> | null {
  if (check.refusal !== undefined)
    return { reason: check.refusal.reason, detail: check.refusal.detail };
  if (!check.targetExists)
    return {
      reason: "folder_missing",
      detail: `${check.targetRoot} does not exist. Create or clone it first, then choose it again.`,
    };
  if (check.conflictingProject !== null) {
    const owner = check.conflictingProject;
    return {
      reason: "folder_conflict",
      detail: `${check.targetRoot} already belongs to the project "${owner.title}" (${plural(owner.threadCount, "thread")}${owner.archived ? ", archived" : ""}). A folder belongs to one project at a time: point "${owner.title}" at another folder or delete it first.`,
    };
  }
  if (check.activeThreads.length > 0)
    return {
      reason: "active_work",
      detail: `Stop the running work first: ${titles(check.activeThreads)}. The folder can change once nothing is queued, running or waiting for an answer.`,
    };
  if (!check.sameRepository && !confirmDifferentRepository)
    return {
      reason: "repository_mismatch",
      detail: `${check.targetRoot} ${check.targetRepository === null ? "has no Git remote" : `is a checkout of ${check.targetRepository}`}, and the current folder ${check.currentRepository === null ? "has no Git remote" : `is a checkout of ${check.currentRepository}`}. Confirm that this is the right folder to use it.`,
    };
  const planning = planningImpactText(check);
  if (planning !== null && !confirmPlanningImpact)
    return {
      reason: "planning_impact",
      detail: `${planning} Confirm the planning change to use ${check.targetRoot}.`,
    };
  return null;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const sessions = yield* Effect.serviceOption(ProviderSessionManager.ProviderSessionManagerV2);
  const adapters = yield* Effect.serviceOption(ProviderAdapterRegistry.ProviderAdapterRegistryV2);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  // Lists every project, deleted ones too, for the nested-project report. The
  // server provides the store from outside like SQLite; without it, one is made
  // on that client, and without either the report is left out.
  const providedStore = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const store = Option.isSome(providedStore)
    ? providedStore
    : Option.isSome(sql)
      ? Option.some(
          yield* ProjectStore.make.pipe(Effect.provideService(SqlClient.SqlClient, sql.value)),
        )
      : Option.none<ProjectStore.ProjectStoreV2["Service"]>();

  const checkFailure = (message: string) => new ProjectFolderCheckError({ message });

  const isDirectory = (folder: string) =>
    fs.stat(folder).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  /**
   * The folder's repository key, or null when it has no repository or no remote.
   * `error` is set when git failed to answer, which is not the same as no remote:
   * keeping threads in place depends on the answer.
   */
  const repositoryOf = (folder: string) =>
    Effect.gen(function* () {
      if (!(yield* isDirectory(folder))) return { key: null, error: null };
      const strict = identities.resolveStrict;
      if (strict === undefined)
        return {
          key: (yield* identities.resolve(folder, { refresh: true }))?.canonicalKey ?? null,
          error: null,
        };
      return yield* strict(folder).pipe(
        Effect.map((identity) => ({ key: identity?.canonicalKey ?? null, error: null })),
        Effect.catch((error) => Effect.succeed({ key: null, error: error.detail })),
      );
    }) as Effect.Effect<{ readonly key: string | null; readonly error: string | null }>;

  /**
   * Why the project's approved folders and repositories would be invalid with
   * `root` as the main folder, by the validation ProjectService.update runs on a
   * folder change; null when they are valid or there are none.
   */
  const environmentProblem = (project: Project, root: string, realRoot: string) =>
    Effect.gen(function* () {
      const environment = project.workspaceSettings?.environment;
      if (
        environment === undefined ||
        (environment.additionalFolders.length === 0 && environment.repositories.length === 0)
      )
        return null;
      const valid = yield* normalizeProjectEnvironment(project.id, realRoot, environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (valid) return null;
      for (const folder of environment.additionalFolders) {
        const real = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
        if (real === realRoot)
          return `${root} is already one of the project's approved extra folders. Remove it from the approved folders first, then choose it again.`;
      }
      return `The project's approved folders and repositories do not all work with ${root} as the main folder. Check them in project settings, then choose the folder again.`;
    });

  /** Other projects, deleted ones too, whose folders sit inside `roots` or hold them. */
  const nestedProjectsOf = (projectId: ProjectId, roots: ReadonlyArray<string>) =>
    Option.isNone(store)
      ? Effect.succeed(null)
      : store.value.list({ includeDeleted: true }).pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => {
              if (row.projectId === projectId) return [];
              // An active owner of the folder itself is the conflicting project; a
              // deleted one is listed, since its history does not come back.
              const relation =
                row.deletedAt !== null &&
                roots.some((root) => relativeWithin(path, root, row.workspaceRoot) === "")
                  ? ("same" as const)
                  : roots.some((root) => strictlyInside(path, root, row.workspaceRoot))
                    ? ("inside" as const)
                    : roots.some((root) => strictlyInside(path, row.workspaceRoot, root))
                      ? ("contains" as const)
                      : null;
              return relation === null
                ? []
                : [
                    {
                      id: row.projectId,
                      title: row.title,
                      workspaceRoot: row.workspaceRoot,
                      relation,
                      deleted: row.deletedAt !== null,
                    },
                  ];
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("project.folder.nested-projects-unreadable", {
              projectId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );

  /**
   * Manual increment links of threads that read the project's planning root
   * (a worktree with its own increments keeps reading those).
   */
  const linkedIncrements = (
    projectId: ProjectId,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) =>
    Option.isNone(sql)
      ? Effect.succeed([] as string[])
      : Effect.gen(function* () {
          const rows = yield* sql.value<{
            readonly threadId: string;
            readonly incrementId: string;
          }>`SELECT thread_id AS "threadId", increment_id AS "incrementId" FROM thread_increment_links WHERE project_id = ${projectId} AND increment_id IS NOT NULL`;
          const worktrees = new Map(
            shells.map((thread) => [thread.id as string, thread.worktreePath]),
          );
          const ids: string[] = [];
          for (const row of rows) {
            if (!worktrees.has(row.threadId)) continue;
            const worktree = worktrees.get(row.threadId) ?? null;
            if (
              worktree !== null &&
              (yield* isDirectory(path.join(worktree, ".specweave", "increments")))
            )
              continue;
            ids.push(row.incrementId);
          }
          return ids;
        }).pipe(Effect.orElseSucceed(() => [] as string[]));

  const projectThreads = (projectId: ProjectId) =>
    projections.getShellSnapshot().pipe(
      Effect.map((snapshot) =>
        [...snapshot.threads, ...snapshot.archivedThreads].filter(
          (thread) => thread.projectId === projectId && thread.deletedAt === null,
        ),
      ),
      Effect.mapError(() => checkFailure("The project's threads could not be read. Try again.")),
    );

  /** Threads bound to a checkout inside `from` whose same place exists under `to`. */
  const reboundWorktrees = Effect.fn("ProjectFolderService.reboundWorktrees")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    from: string,
    to: string,
  ) {
    const rebound: Array<{
      readonly threadId: ThreadId;
      readonly from: string;
      readonly to: string;
    }> = [];
    for (const thread of shells) {
      if (thread.worktreePath === null) continue;
      const relative = relativeWithin(path, from, thread.worktreePath);
      if (relative === null) continue;
      const next = relative === "" ? to : path.join(to, relative);
      if (next !== thread.worktreePath && (yield* isDirectory(next)))
        rebound.push({ threadId: thread.id, from: thread.worktreePath, to: next });
    }
    return rebound;
  });

  /**
   * Moving away from a folder that is still a checkout of a different repository
   * must not move its threads into another repository: they stay bound to it.
   */
  const keepsThreadsInPlace = (
    currentRoot: string,
    currentRepository: string | null,
    targetRepository: string | null,
  ) =>
    currentRepository === null || currentRepository === targetRepository
      ? Effect.succeed(false)
      : isDirectory(currentRoot);

  /**
   * Threads that run in the project folder itself, except the project's
   * coordinator. A project that never bound one still has the default
   * coordinator id ProjectCoordinatorService starts it under.
   */
  const rootThreads = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    project: Pick<Project, "id" | "workspaceSettings">,
  ) => {
    const coordinator =
      project.workspaceSettings?.coordinatorThreadId ??
      ThreadId.make(`project-coordinator:${project.id}`);
    return shells.filter((thread) => thread.worktreePath === null && thread.id !== coordinator);
  };

  /** Layout and planning impact; both are on-demand reads of the two folders only. */
  const folderDetails = (
    projectId: ProjectId,
    currentRoot: string,
    target: { readonly root: string; readonly exists: boolean },
    unchanged: boolean,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) =>
    Effect.gen(function* () {
      if (!target.exists) return {};
      const layout = yield* Effect.promise(() => readFolderLayout(target.root));
      if (unchanged) return layout === null ? {} : { layout };
      const links = yield* linkedIncrements(projectId, shells);
      const planning = yield* Effect.promise(() => planningImpact(currentRoot, target.root, links));
      const reachable =
        planning.currentRoot !== null || planning.targetRoot !== null || links.length > 0;
      return {
        ...(layout === null ? {} : { layout }),
        ...(reachable ? { planning } : {}),
      };
    });

  const check: ProjectFolderService["Service"]["check"] = Effect.fn("ProjectFolderService.check")(
    function* (input) {
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(() => checkFailure("The project could not be read. Try again.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(checkFailure("The project was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      // `exists` is true only for a directory. A file at the path is not a folder
      // the project can use: it reads as missing, and `refusal` says it is a file.
      const normalized = yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.map((root) => ({ root, exists: true, file: false })),
        Effect.catchTags({
          WorkspaceRootNotExistsError: (error) =>
            Effect.succeed({ root: error.normalizedWorkspaceRoot, exists: false, file: false }),
          WorkspaceRootNotDirectoryError: (error) =>
            Effect.succeed({ root: error.normalizedWorkspaceRoot, exists: false, file: true }),
        }),
        Effect.mapError(() => checkFailure(`${input.workspaceRoot} could not be read.`)),
      );
      const currentRoot = project.workspaceRoot;
      const realPath = (folder: string) =>
        fs.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
      const realTarget = normalized.exists ? yield* realPath(normalized.root) : normalized.root;
      const unchanged =
        normalized.root === currentRoot ||
        (normalized.exists && realTarget === (yield* realPath(currentRoot)));
      let refusal: ProjectFolderCheck["refusal"] = normalized.file
        ? {
            reason: "folder_not_directory",
            detail: `${normalized.root} is a file, not a folder. Choose the folder that holds the project.`,
          }
        : normalized.exists && !unchanged && (yield* exposesProtectedRealPath(realTarget, path))
          ? {
              reason: "folder_protected",
              detail: `${normalized.root} is a protected folder: the home folder, the filesystem root, or a folder that holds them or holds credentials or app data. Choose the project's own folder.`,
            }
          : undefined;
      // Only a folder the project may use is read further.
      const usable = normalized.exists && refusal === undefined;
      const shells = yield* projectThreads(project.id);
      const owner =
        unchanged || !usable
          ? Option.none<Project>()
          : yield* projects
              .getByWorkspaceRoot(normalized.root)
              .pipe(Effect.orElseSucceed(() => Option.none<Project>()));
      const conflictingProject =
        Option.isSome(owner) && owner.value.id !== project.id ? owner.value : null;
      const conflictThreads =
        conflictingProject === null ? 0 : (yield* projectThreads(conflictingProject.id)).length;
      const [current, target] = yield* Effect.all([
        repositoryOf(currentRoot),
        usable ? repositoryOf(normalized.root) : Effect.succeed({ key: null, error: null }),
      ]);
      const currentRepository = current.key;
      const targetRepository = target.key;
      if (refusal === undefined && !unchanged) {
        const unreadable =
          current.error !== null
            ? { folder: currentRoot, error: current.error }
            : target.error !== null
              ? { folder: normalized.root, error: target.error }
              : null;
        if (unreadable !== null)
          refusal = {
            reason: "repository_unreadable",
            detail: `Git could not read the repository of ${unreadable.folder} (${unreadable.error}), so the app cannot tell which threads should stay there. Fix the repository or try again.`,
          };
      }
      if (refusal === undefined && usable && !unchanged) {
        const problem = yield* environmentProblem(project, normalized.root, realTarget);
        if (problem !== null) refusal = { reason: "environment_invalid", detail: problem };
      }
      const proceeds = usable && refusal === undefined;
      const keep =
        proceeds &&
        !unchanged &&
        (yield* keepsThreadsInPlace(currentRoot, currentRepository, targetRepository));
      const rebound =
        proceeds && !keep ? yield* reboundWorktrees(shells, currentRoot, normalized.root) : [];
      const nestedProjects =
        normalized.exists && refusal?.reason !== "folder_protected" && !unchanged
          ? yield* nestedProjectsOf(
              project.id,
              realTarget === normalized.root ? [normalized.root] : [normalized.root, realTarget],
            )
          : null;
      return {
        projectId: project.id,
        currentRoot,
        targetRoot: normalized.root,
        unchanged,
        targetExists: normalized.exists,
        currentRepository,
        targetRepository,
        sameRepository:
          unchanged || (currentRepository !== null && currentRepository === targetRepository),
        conflictingProject:
          conflictingProject === null
            ? null
            : {
                id: conflictingProject.id,
                title: conflictingProject.title,
                threadCount: conflictThreads,
                archived: conflictingProject.workspaceSettings?.archived ?? false,
              },
        activeThreads: shells
          .filter((thread) => threadBlocksFolderChange(thread, input.approvalRequestId))
          .map((thread) => ({ id: thread.id, title: thread.title || "Untitled thread" })),
        threadCount: shells.length,
        reboundWorktreeCount: rebound.length,
        keptInPlaceCount: keep ? rootThreads(shells, project).length : 0,
        specweaveWorkspace:
          usable && (yield* isDirectory(path.join(normalized.root, ".specweave"))),
        ...(refusal === undefined ? {} : { refusal }),
        ...(nestedProjects === null ? {} : { nestedProjects }),
        ...(usable
          ? yield* folderDetails(project.id, currentRoot, normalized, unchanged, shells)
          : {}),
      } satisfies ProjectFolderCheck;
    },
  );

  /**
   * Claude Code keys each session by the cwd it ran in, so a thread whose folder
   * moved would otherwise fail to resume. Best effort: a failure is logged and
   * the next turn reports the missing session the way it does today.
   */
  const relocateSessions = Effect.fn("ProjectFolderService.relocateSessions")(function* (
    moves: ReadonlyArray<{ readonly threadId: ThreadId; readonly cwd: string }>,
  ) {
    let relocated = 0;
    for (const move of moves) {
      const records = yield* threads
        .getThreadRecords(move.threadId, ["providerThreads", "providerSessions"])
        .pipe(Effect.option);
      if (Option.isNone(records)) continue;
      for (const providerThread of records.value.providerThreads) {
        const sessionId = providerThread.nativeThreadRef?.nativeId;
        if (providerThread.driver !== "claudeAgent" || !sessionId) continue;
        const metadata =
          Option.isSome(adapters) && adapters.value.getMetadata !== undefined
            ? yield* adapters.value
                .getMetadata(providerThread.providerInstanceId)
                .pipe(Effect.option)
            : Option.none();
        const home = Option.isSome(metadata)
          ? claudeHomeFromContinuationKey(metadata.value.continuationKey)
          : null;
        if (home === null) continue;
        const result = yield* relocateClaudeTranscript({ home, sessionId, toCwd: move.cwd }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.catchCause((cause) =>
            Effect.logWarning("project.folder.session-relocation-failed", {
              threadId: move.threadId,
              cause,
            }).pipe(Effect.as({ status: "missing" as const })),
          ),
        );
        if (result.status === "copied") relocated += 1;
      }
      // A cached agent process keeps the old cwd until it restarts.
      if (Option.isSome(sessions))
        for (const session of records.value.providerSessions)
          if (session.status !== "stopped" && session.cwd !== move.cwd)
            yield* sessions.value
              .release({
                providerSessionId: session.id,
                reason: "manual_shutdown",
                detail: "The project folder changed.",
              })
              .pipe(Effect.ignore);
    }
    return relocated;
  });

  const change: ProjectFolderService["Service"]["change"] = Effect.fn(
    "ProjectFolderService.change",
  )(function* (input) {
    const checked = yield* check({
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      ...(input.approvalRequestId === undefined
        ? {}
        : { approvalRequestId: input.approvalRequestId }),
    });
    const previousRoot = checked.currentRoot;
    if (checked.unchanged) {
      const project = yield* projects.getById(input.projectId);
      if (Option.isSome(project))
        return {
          project: project.value,
          previousRoot,
          reboundWorktrees: 0,
          keptInPlace: 0,
          relocatedSessions: 0,
        };
    }
    const refusal = folderChangeRefusal(
      checked,
      input.confirmDifferentRepository === true,
      input.confirmPlanningImpact === true,
    );
    if (refusal !== null)
      return yield* new ProjectService.ProjectFolderChangeError({
        projectId: input.projectId,
        ...refusal,
      });
    const shells = yield* projectThreads(input.projectId);
    const current = yield* projects.getById(input.projectId).pipe(Effect.map(Option.getOrNull));
    const keep = yield* keepsThreadsInPlace(
      previousRoot,
      checked.currentRepository,
      checked.targetRepository,
    );
    const kept = keep && current !== null ? rootThreads(shells, current) : [];
    const keptIds = new Set<string>(kept.map((thread) => thread.id));
    const rebound = keep ? [] : yield* reboundWorktrees(shells, previousRoot, checked.targetRoot);
    // Bind them before the root moves, so none of them starts a turn in the new
    // folder. Any failure after a bind undoes the binds made so far: the project
    // keeps its folder, and every thread runs exactly where it did.
    const bound: Array<OrchestrationV2ThreadShell> = [];
    const undoKeeps = Effect.suspend(() =>
      Effect.forEach(
        [...bound],
        (thread) =>
          threads
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`${input.commandId}:unkeep:${thread.id}`),
              threadId: thread.id,
              worktreePath: null,
              expectedWorktreePath: previousRoot,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("project.folder.keep-undo-failed", {
                  threadId: thread.id,
                  cause,
                }),
              ),
            ),
        { discard: true },
      ),
    );
    for (const thread of kept) {
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:keep:${thread.id}`),
          threadId: thread.id,
          worktreePath: previousRoot,
          expectedWorktreePath: null,
        })
        .pipe(
          Effect.onError(() => undoKeeps),
          Effect.mapError(() =>
            checkFailure(
              `"${thread.title || "Untitled thread"}" could not stay in ${previousRoot}, so the folder did not change. Try again.`,
            ),
          ),
        );
      bound.push(thread);
    }
    // The check ran before the binds: a thread created or started since then
    // would move with the root or have it moved from under its work.
    const latest = yield* projectThreads(input.projectId).pipe(Effect.onError(() => undoKeeps));
    const busy = latest.filter((thread) =>
      threadBlocksFolderChange(thread, input.approvalRequestId),
    );
    const appeared =
      keep && current !== null
        ? rootThreads(latest, current).filter((thread) => !keptIds.has(thread.id))
        : [];
    if (busy.length > 0 || appeared.length > 0) {
      yield* undoKeeps;
      return yield* new ProjectService.ProjectFolderChangeError({
        projectId: input.projectId,
        reason: "changed_meanwhile",
        detail:
          busy.length > 0
            ? `${titles(busy)} started work while the folder was changing, so the folder did not change. Try again once nothing is queued, running or waiting for an answer.`
            : `${titles(appeared)} ${appeared.length === 1 ? "was" : "were"} created while the folder was changing, so the folder did not change. Check the folder again to include ${appeared.length === 1 ? "it" : "them"}.`,
      });
    }
    const project = yield* projects
      .update({
        commandId: input.commandId,
        projectId: input.projectId,
        workspaceRoot: checked.targetRoot,
        ...(input.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: input.approvalRequestId }),
      })
      .pipe(
        // The update can fail or be interrupted after its commit landed (a read
        // after the commit). Undo only while the project still has its old root,
        // so kept threads never lose their binding to a folder that did move.
        Effect.onError(() =>
          projects.getById(input.projectId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
            Effect.flatMap((latestProject) =>
              latestProject !== null && latestProject.workspaceRoot === previousRoot
                ? undoKeeps
                : Effect.logWarning("project.folder.keep-undo-skipped", {
                    projectId: input.projectId,
                    root: latestProject?.workspaceRoot ?? null,
                  }),
            ),
          ),
        ),
      );
    // A thread whose rebind failed still runs in its old checkout: its session
    // stays where it is.
    const reboundIds = new Map<string, string>();
    for (const move of rebound)
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:worktree:${move.threadId}`),
          threadId: move.threadId,
          worktreePath: move.to,
          expectedWorktreePath: move.from,
        })
        .pipe(
          Effect.map(() => {
            reboundIds.set(move.threadId, move.to);
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("project.folder.worktree-rebind-failed", {
              threadId: move.threadId,
              cause,
            }),
          ),
        );
    const relocatedSessions = yield* relocateSessions(
      shells.flatMap((thread) => {
        if (keptIds.has(thread.id)) return [];
        const cwd =
          reboundIds.get(thread.id) ??
          (thread.worktreePath === null ? project.workspaceRoot : null);
        return cwd === null ? [] : [{ threadId: thread.id, cwd }];
      }),
    );
    yield* Effect.logInfo("project.folder.changed", {
      projectId: input.projectId,
      from: previousRoot,
      to: project.workspaceRoot,
      reboundWorktrees: reboundIds.size,
      failedRebinds: rebound.length - reboundIds.size,
      keptInPlace: kept.length,
      relocatedSessions,
    });
    return {
      project,
      previousRoot,
      reboundWorktrees: reboundIds.size,
      keptInPlace: kept.length,
      relocatedSessions,
    };
  });

  return ProjectFolderService.of({ check, change });
});

export const layer = Layer.effect(ProjectFolderService, make);
