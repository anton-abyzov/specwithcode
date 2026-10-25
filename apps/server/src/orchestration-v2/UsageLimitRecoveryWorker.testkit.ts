import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Option from "effect/Option";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Availability from "./UsageLimitAvailability.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import { makeSweep } from "./UsageLimitRecoveryWorker.ts";
import { updateLimitRecovery } from "./usageLimitRecovery.ts";

/**
 * A Claude thread stops on its 5-hour limit. Claude has no availability probe,
 * so the reset time alone decides: nothing happens before it, the thread
 * continues once after it, and a sweep built after a restart does the same
 * from the persisted choice.
 */
export const claudeLimitStop = (resetMs: number) => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const reset = DateTime.formatIso(DateTime.makeUnsafe(resetMs));
  return {
    id: ThreadId.make("claude-limited"),
    providerInstanceId: claude,
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: RunId.make("failed-run"),
    latestRunCompletedAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    usageLimitResetAt: reset,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    snoozedUntil: null,
    limitRecovery: null,
  } satisfies ProjectionStore.ProjectionLimitRecoveryCandidate;
};

export const claudeSweepHarness = (input: {
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  projectAutoResume?: boolean;
  globalAutoResume?: boolean;
  /** The provider registry's snapshot; absent builds the sweep without a registry. */
  provider?: (nowMs: number) => ServerProvider;
  /**
   * A request pending on the thread: the shell shows only its summary (the
   * candidate read leaves such threads out), the thread's records its detail.
   */
  pending?: {
    readonly summary: NonNullable<
      ProjectionStore.ProjectionLimitRecoveryCandidate["pendingRuntimeRequest"]
    >;
    readonly records: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "nodes" | "runs">;
  };
  /** The instance the stopped run ran on, as the thread's records give it. */
  runInstance?: ProviderInstanceId;
  /** Commands the orchestrator rejects; a rejected id is rejected again on replay. */
  refuses?: (command: OrchestrationV2ServerCommand) => boolean;
  /**
   * Resumes the orchestrator refuses. As in `refuseLimitResume`, a refused
   * resume still commits (it records a metadata update) but starts no run, and
   * a replay of its id returns the same committed receipt.
   */
  refusesResume?: (command: OrchestrationV2ServerCommand) => boolean;
  /** Runs after a resume is built and before it is sent (the handoff check). */
  beforeSend?: (state: { current: ProjectionStore.ProjectionLimitRecoveryCandidate }) => void;
  /** More server settings, such as `autoApproveSubscriptionChange`. */
  settings?: Parameters<typeof Settings.layerTest>[0];
  /** What the native availability check answers; the default is a provider without one. */
  availability?: Effect.Success<
    ReturnType<Availability.UsageLimitAvailability["Service"]["check"]>
  >;
}) => {
  const projectId = ProjectId.make("claude-limit-project");
  const state = {
    current: input.thread,
    commands: [] as OrchestrationV2ServerCommand[],
    /** The persisted handoff state keeps the thread from starting a turn here. */
    handoffBlocked: false,
    /** A busy Codex process on the instance still holds the previous subscription. */
    replacementPending: false,
    /** The registry snapshot, replaced by each refresh. */
    snapshot: undefined as ServerProvider | undefined,
    refreshes: 0,
    /** Refreshes that asked to bypass the instance's cached probe. */
    freshRefreshes: 0,
    /** Every dispatch attempt, refused or not. */
    attempts: [] as string[],
    rejected: new Set<string>(),
    /** Ids that committed without effect, as a refused resume does. */
    refusedIds: new Set<string>(),
    /** Runs the accepted message dispatches started, by their message. */
    runs: [] as Array<{
      readonly id: RunId;
      readonly userMessageId: string;
      readonly providerInstanceId: ProviderInstanceId;
    }>,
  };
  const deps = Layer.mergeAll(
    ProjectAdmission.layer,
    Settings.layerTest({
      providerLimitAction: "wait",
      autoResumeLimitedThreads: input.globalAutoResume ?? false,
      ...input.settings,
    }),
    Layer.mock(Availability.UsageLimitAvailability)({
      // What the real service answers for a provider without a native probe.
      check: () => Effect.succeed(input.availability ?? { codex: false, observation: null }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            deletedAt: null,
            workspaceSettings: {
              ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              autoResume: input.projectAutoResume ?? false,
            },
          } as ProjectStore.ProjectRow),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getLimitRecoveryCandidates: () => Effect.sync(() => [state.current]),
      getThreadShell: () =>
        Effect.sync(
          () =>
            ({
              ...state.current,
              projectId,
              ...(input.pending ? { pendingRuntimeRequest: input.pending.summary } : {}),
            }) as never,
        ),
      getThreadProjection: (threadId) =>
        Effect.sync(
          () =>
            ({
              runtimeRequests: [],
              nodes: [],
              ...input.pending?.records,
              runs: [
                ...(input.pending?.records.runs ?? []),
                ...(input.runInstance && state.current.latestRunId
                  ? [{ id: state.current.latestRunId, providerInstanceId: input.runInstance }]
                  : []),
                ...state.runs.filter((run) => run.id.startsWith(`${threadId}:`)),
              ],
            }) as unknown as OrchestrationV2ThreadProjection,
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.suspend(
          (): Effect.Effect<
            { sequence: number; storedEvents: [] },
            Orchestrator.OrchestratorV2Error
          > => {
            state.attempts.push(command.commandId);
            if (state.rejected.has(command.commandId))
              return Effect.fail(
                new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "refused",
                }),
              );
            if (input.refuses?.(command)) {
              state.rejected.add(command.commandId);
              return Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "refused",
                }),
              );
            }
            if (state.refusedIds.has(command.commandId) || input.refusesResume?.(command)) {
              state.refusedIds.add(command.commandId);
              return Effect.succeed({ sequence: state.attempts.length, storedEvents: [] });
            }
            state.commands.push(command);
            if (command.type === "message.dispatch")
              state.runs.push({
                id: RunId.make(`${command.threadId}:run-${state.runs.length + 1}`),
                userMessageId: command.messageId,
                providerInstanceId: state.current.providerInstanceId,
              });
            if (command.type === "thread.metadata.update" && command.limitRecovery)
              state.current = {
                ...state.current,
                limitRecovery: updateLimitRecovery(
                  state.current.limitRecovery,
                  command.limitRecovery,
                  command.commandId,
                  command.limitRecoveryPolicyArm === true,
                )!,
              };
            return Effect.succeed({ sequence: state.commands.length, storedEvents: [] });
          },
        ),
    }),
  );
  const registry = input.provider
    ? Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.sync(() => (state.snapshot ? [state.snapshot] : [])),
        refreshInstance: (_instanceId, options) =>
          Effect.gen(function* () {
            state.refreshes += 1;
            if (options?.fresh) state.freshRefreshes += 1;
            state.snapshot = input.provider!(yield* Clock.currentTimeMillis);
            return [state.snapshot];
          }),
      })
    : Layer.empty;
  const sessions = Layer.mock(ProviderSessionManagerV2)({
    replacementPending: () => Effect.sync(() => state.replacementPending),
  });
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(deps, registry, sessions)),
      Effect.provideService(MachineLimitHandoff, {
        ...MachineLimitHandoff.defaultValue(),
        localTurnBlocked: () =>
          Effect.sync(() => {
            input.beforeSend?.(state);
            return state.handoffBlocked;
          }),
      }),
    );
  // A fresh sweep per call: nothing survives in memory, as after a restart.
  const sweep = provided(Effect.flatMap(makeSweep, (run) => run()));
  // One sweep kept across calls, as the scheduler runs it.
  const running = provided(makeSweep).pipe(Effect.map((run) => provided(run())));
  return { state, sweep, running };
};
