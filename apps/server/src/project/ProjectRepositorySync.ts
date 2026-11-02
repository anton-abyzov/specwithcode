import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { Project, ProjectId, ProviderInstanceId } from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";

import {
  foldersOverlap,
  NOT_UPDATED,
  projectRepositories,
  repositorySyncNotice,
  syncRepositories,
  savedRepositoryFolder,
  takeProjectMoved,
  type RepositorySyncNotice,
} from "../fleet/repositorySync.ts";
import * as ServerConfig from "../config.ts";
import { isScratchWorkspace } from "./ManagedProjectFolders.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";

/** The wait a thread's first turn accepts; whatever is unfinished then is simply left. */
const SYNC_TIMEOUT = Duration.seconds(30);
const SAME_SKIPS_QUIET_MS = 60 * 60 * 1000;

/** What each project was last told it skipped, so every new thread does not repeat it. */
const lastSkips = new Map<string, { readonly text: string; readonly at: number }>();

/** Drops the skipped lines a project has already been told about within the hour. */
export function quietRepeatedSkips(
  projectId: string,
  notice: RepositorySyncNotice | null,
  now: number,
): RepositorySyncNotice | null {
  if (notice === null) return null;
  const last = lastSkips.get(projectId);
  const repeated =
    notice.skipped !== "" && last?.text === notice.skipped && now - last.at < SAME_SKIPS_QUIET_MS;
  if (!repeated) {
    if (notice.skipped !== "") lastSkips.set(projectId, { text: notice.skipped, at: now });
    return notice;
  }
  const rest = notice.message
    .split("\n")
    .filter((line) => !line.startsWith(`${NOT_UPDATED} `))
    .join("\n");
  return rest === "" ? null : { ...notice, message: rest, skipped: "" };
}

type BusyProject = Pick<Project, "workspaceRoot" | "workspaceSettings">;

/** The folders a running thread can write in: its own, and the project's saved ones. */
export function threadFolders(
  worktreePath: string | null,
  project: BusyProject | null,
): ReadonlyArray<string> {
  const environment = project?.workspaceSettings?.environment;
  const saved = [
    ...(environment?.additionalFolders ?? []),
    ...(project === null
      ? []
      : (environment?.repositories ?? []).map((repository) =>
          savedRepositoryFolder(project.workspaceRoot, repository),
        )),
  ];
  if (worktreePath !== null) return [worktreePath, ...saved];
  return project === null ? saved : [project.workspaceRoot, ...saved];
}

const REMEMBERED_RUNS = 1000;

/**
 * True the first time it sees a run. A turn can come through prepare and then start, and a
 * failed start retries: one sync per run keeps those from spending the start's time limit.
 */
export function makeFirstPassOfRun() {
  const seen = new Set<string>();
  return (runId: string): boolean => {
    if (seen.has(runId)) return false;
    seen.add(runId);
    if (seen.size > REMEMBERED_RUNS) seen.delete(seen.values().next().value as string);
    return true;
  };
}

/**
 * Wraps a session so a thread's first turn, and a coordinator's first turn after moving
 * here, starts on current repositories. Best effort from end to end: whatever goes wrong
 * here is logged and the turn starts anyway.
 */
export const makeRepositorySyncRuntime = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const firstPassOfRun = makeFirstPassOfRun();

  /** Folders other running threads work in; null when they cannot be read. */
  const busyFolders = <E>(
    turn: ProviderAdapterV2TurnInput,
    read: (projectId: ProjectId) => Effect.Effect<Option.Option<Project>, E>,
  ) =>
    Effect.gen(function* () {
      const shell = yield* projections.getShellSnapshot();
      const folders: Array<string> = [];
      for (const thread of shell.threads) {
        if (thread.id === turn.threadId || thread.activeRunId === null) continue;
        if (thread.deletedAt !== null) continue;
        const project = yield* read(thread.projectId);
        folders.push(...threadFolders(thread.worktreePath, Option.getOrNull(project)));
      }
      return folders;
    }).pipe(Effect.orElseSucceed(() => null));

  const record = (
    turn: ProviderAdapterV2TurnInput,
    providerInstanceId: ProviderInstanceId,
    notice: RepositorySyncNotice,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId: turn.threadId }),
            type: "turn-item.updated",
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: idAllocator.derive.runSignalTurnItem({
                runId: turn.runId,
                signal: "repositories-synced",
              }),
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              providerThreadId: turn.providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              // Before the environment notice, imported context and the user message.
              ordinal: turn.runOrdinal * 100 - 3,
              status: "completed",
              title: notice.title,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: notice.message,
            },
          },
        ],
      });
    });

  const sync = <E>(
    turn: ProviderAdapterV2TurnInput,
    project: Project,
    providerInstanceId: ProviderInstanceId,
    read: (projectId: ProjectId) => Effect.Effect<Option.Option<Project>, E>,
  ) =>
    Effect.gen(function* () {
      const busy = yield* busyFolders(turn, read);
      const results = yield* Effect.tryPromise((signal) =>
        projectRepositories(project, { signal }).then((paths) =>
          syncRepositories({
            paths,
            // Without the list of running threads, every checkout counts as in use.
            inUse: async (path) => busy === null || foldersOverlap(path, busy),
            signal,
          }),
        ),
      ).pipe(Effect.timeoutOption(SYNC_TIMEOUT));
      const now = yield* Clock.currentTimeMillis;
      const notice = Option.isNone(results)
        ? {
            title: "Repositories not updated",
            message:
              "Repositories were still updating after 30 seconds; the thread started anyway.",
            skipped: "",
          }
        : quietRepeatedSkips(project.id, repositorySyncNotice(results.value), now);
      if (notice !== null) yield* record(turn, providerInstanceId, notice);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not sync repositories", cause)));

  return <E>(
    session: ProviderAdapterV2SessionRuntime,
    read: (projectId: ProjectId) => Effect.Effect<Option.Option<Project>, E>,
    providerInstanceId: ProviderInstanceId,
  ): ProviderAdapterV2SessionRuntime => {
    const before = (turn: ProviderAdapterV2TurnInput) =>
      Effect.gen(function* () {
        const projectId = turn.appThread.projectId;
        if (!firstPassOfRun(turn.runId)) return;
        if (!takeProjectMoved(projectId) && turn.runOrdinal !== 1) return;
        const project = yield* read(projectId).pipe(
          Effect.orElseSucceed(() => Option.none<Project>()),
        );
        if (Option.isNone(project)) return;
        // "No project" and assistants hold no project repositories. What is in their folder
        // belongs to other chats, which this thread has nothing to do with.
        if (isPersonalAssistantProject(project.value)) return;
        if (isScratchWorkspace(path, config.baseDir, project.value.workspaceRoot)) return;
        yield* sync(turn, project.value, providerInstanceId, read);
      });
    return {
      ...session,
      startTurn: (turn) => before(turn).pipe(Effect.andThen(session.startTurn(turn))),
      ...(session.prepareTurn === undefined
        ? {}
        : {
            prepareTurn: (turn: ProviderAdapterV2TurnInput) =>
              before(turn).pipe(Effect.andThen(session.prepareTurn!(turn))),
          }),
    };
  };
});
