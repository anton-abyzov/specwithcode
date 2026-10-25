import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectCoordinator from "../project/ProjectCoordinatorService.ts";
import { stringifyJson } from "../json.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Service from "./ScheduledTaskService.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

/** The routine provider-gate harness, shared by the provider-gate and one-time tests. */
export const START_ISO = "2026-10-21T06:40:00.000Z";
export const START = Date.parse(START_ISO);
export const TEN_MINUTES = 10 * 60_000;
export const THREAD = "thread-on-copilot";
export const COORDINATOR = "coordinator-aide";
export const NOT_PREPARED =
  "Copilot 1.0.101 is not prepared. Use Install / update agent in Settings → Providers.";

const decodeTaskInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
export const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeTaskInput({
    title: "Inbox sweep",
    prompt: "Check the inbox and summarise anything new.",
    enabled: true,
    projectId: "aide",
    threadId: THREAD,
    schedule: { type: "interval", everyMs: TEN_MINUTES },
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

export const provider = (
  instanceId: string,
  driver: string,
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.98",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: START_ISO,
  models: [],
  slashCommands: [],
  skills: [],
  ...over,
});

export const copilotReady = provider("acpRegistry_copilot", "acpRegistry", {
  displayName: "GitHub Copilot",
});
// The read taken after the failed run: still not ready.
export const copilotNotPrepared: ServerProvider = {
  ...copilotReady,
  status: "error",
  message: NOT_PREPARED,
  checkedAt: "2026-10-21T06:50:00.000Z",
};
export const codexReady = provider("codex", "codex", { displayName: "Codex" });

export const harness = (
  initial: ReadonlyArray<ServerProvider>,
  // The project's limit rule; without settings a blocked fire waits, never moves.
  settings?: ServerSettingsValue,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const state = {
      providers: initial,
      sent: [] as Array<{ readonly threadId: string; readonly instanceId: string | undefined }>,
      messageIds: [] as Array<string>,
      poll: undefined as Effect.Effect<void> | undefined,
      // What the coordinator service resolves the bound thread's next turn to.
      nextTurn: undefined as ModelSelection | undefined,
      nextTurnAsked: [] as Array<string | null>,
      coordinatorWakes: 0,
      launched: [] as Array<string>,
      /** Posts that fail before they reach the thread. */
      failSends: 0,
      /** The error those posts fail with; a defect when unset. */
      failSendsWith: undefined as unknown,
      /** The routine's project, as admission reads it. */
      projectState: "active" as "active" | "paused",
      /** Posts that never return, as when the app quits mid-post; counted as they start. */
      hangSends: false,
      hungSends: 0,
    };
    const threadRow = (threadId: string, instanceId: string) =>
      sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "aide",
        title: "Inbox sweep",
        default_provider: "acpRegistry",
        provider_instance_id: instanceId,
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-10-21T00:00:00.000Z",
        updated_at: "2026-10-21T00:00:00.000Z",
        deleted_at: null,
        payload_json: "{}",
      })}`;
    yield* threadRow(THREAD, "acpRegistry_copilot");
    yield* threadRow(COORDINATOR, "acpRegistry_copilot");
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id: ProjectId) =>
          Effect.suspend(() =>
            Effect.succeedSome({
              ...routineProject(id),
              workspaceSettings: {
                ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                coordinatorThreadId: ThreadId.make(COORDINATOR),
                paused: state.projectState === "paused",
              },
            }),
          ),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            state.launched.push(input.modelSelection.instanceId);
            const threadId = ThreadId.make(`own-thread-${state.launched.length}`);
            yield* Effect.orDie(threadRow(threadId, input.modelSelection.instanceId));
            return { threadId, resumed: false, projection: { messages: [] } } as never;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (input) =>
          state.hangSends
            ? Effect.suspend(() => {
                state.hungSends++;
                return Effect.never;
              })
            : state.failSends > 0
              ? Effect.suspend(() => {
                  state.failSends--;
                  return state.failSendsWith === undefined
                    ? Effect.die(new Error("The thread could not take the message."))
                    : Effect.fail(state.failSendsWith as never);
                })
              : Effect.sync(() => {
                  state.sent.push({
                    threadId: input.threadId,
                    instanceId: input.modelSelection?.instanceId,
                  });
                  state.messageIds.push(input.messageId);
                  return {} as never;
                }),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ProcessRunner.ProcessRunner)({}),
      Layer.mock(ProjectCoordinator.ProjectCoordinatorService)({
        start: () =>
          Effect.sync(() => {
            state.coordinatorWakes++;
            return { threadId: ThreadId.make(COORDINATOR), created: false };
          }),
        nextTurnModel: (_projectId, threadId) =>
          Effect.sync(() => {
            state.nextTurnAsked.push(threadId);
            return state.nextTurn;
          }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => state.providers),
      }),
      settings === undefined
        ? Layer.empty
        : Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(settings),
          }),
      // The poll is run by hand so each fire is observed after it finished.
      Layer.mock(Scheduler.Scheduler)({
        register: (_name, runDueWork) =>
          Effect.map(Effect.context(), (context) => {
            state.poll = Effect.orDie(Effect.provideContext(runDueWork, context));
          }),
        heldMsBetween: () => Effect.succeed(0),
      }),
    );
    const run = <A, E, R>(
      body: (service: Service.ScheduledTaskService["Service"]) => Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Service.ScheduledTaskService;
          return yield* body(service);
        }).pipe(Effect.provide(Service.layer.pipe(Layer.provide(dependencies)))),
      );
    /** Moves the clock to the task's next run and runs the due poll once. */
    const fireNext = Effect.gen(function* () {
      const [row] = yield* sql<{ next_run_at: string }>`SELECT next_run_at FROM scheduled_tasks`;
      yield* TestClock.setTime(Date.parse(row!.next_run_at) + 1_000);
      yield* state.poll!;
    });
    const taskRow = Effect.map(
      sql<{
        enabled: number;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
        schedule_json: string;
        updated_at: string;
      }>`SELECT enabled, last_run_status, last_run_error, next_run_at, run_count, schedule_json, updated_at FROM scheduled_tasks`,
      (rows) => rows[0]!,
    );
    /** A thread's latest run failed because its provider could not open a session. */
    const failRunOnCopilot = (completedAt: string, threadId: string = THREAD) =>
      Effect.gen(function* () {
        const runId = `run-${threadId}`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: runId,
          thread_id: threadId,
          ordinal: 1,
          provider: "acpRegistry",
          provider_instance_id: "acpRegistry_copilot",
          provider_thread_id: null,
          status: "failed",
          requested_at: "2026-10-21T06:44:00.000Z",
          completed_at: completedAt,
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
          turn_item_id: `item-${threadId}`,
          thread_id: threadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal: 1,
          type: "error",
          status: "failed",
          updated_at: completedAt,
          payload_json: stringifyJson({
            type: "error",
            failure: {
              class: "provider_error",
              code: "provider_unavailable",
              message: NOT_PREPARED,
              retryable: false,
            },
          }),
        })}`;
      });
    return { state, run, fireNext, taskRow, failRunOnCopilot };
  });

/** A run on `threadId` as the projection stores it, with an optional error item. */
export const insertRun = (input: {
  readonly runId: string;
  readonly threadId?: string;
  readonly ordinal: number;
  readonly instanceId: string;
  readonly model?: string;
  readonly status: string;
  readonly completedAt: string | null;
  readonly userMessageId: string;
  readonly startMessageId?: string;
  readonly startedAt?: string | null;
  readonly failure?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = input.threadId ?? THREAD;
    const payload = stringifyJson({
      userMessageId: input.userMessageId,
      ...(input.startMessageId === undefined ? {} : { startMessageId: input.startMessageId }),
      modelSelection: { instanceId: input.instanceId, model: input.model ?? "claude-opus-5.5" },
      startedAt: input.startedAt ?? null,
    });
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: input.runId,
      thread_id: threadId,
      ordinal: input.ordinal,
      provider: input.instanceId,
      provider_instance_id: input.instanceId,
      provider_thread_id: null,
      status: input.status,
      requested_at: "2026-10-21T06:44:00.000Z",
      completed_at: input.completedAt,
      payload_json: payload,
    })}
    ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at,
      payload_json = excluded.payload_json`;
    if (input.failure !== undefined)
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
        turn_item_id: `item-${input.runId}`,
        thread_id: threadId,
        run_id: input.runId,
        node_id: null,
        provider_thread_id: null,
        provider_turn_id: null,
        parent_item_id: null,
        ordinal: input.ordinal,
        type: "error",
        status: "failed",
        updated_at: input.completedAt ?? START_ISO,
        payload_json: stringifyJson({ type: "error", failure: input.failure }),
      })}`;
  });

export const openFailure = {
  class: "provider_error",
  code: "provider_unavailable",
  message: NOT_PREPARED,
  retryable: false,
};

export const occurrences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly result_json: string }>`
    SELECT result_json FROM scheduled_task_run_receipts
    WHERE command_id LIKE 'scheduled-occurrence:%' ORDER BY started_at`;
  return rows.map((row) => JSON.parse(row.result_json) as Record<string, unknown>);
});
