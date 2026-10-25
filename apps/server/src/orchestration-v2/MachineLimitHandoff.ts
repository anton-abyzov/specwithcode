/**
 * Hands a thread to a model on another paired machine when its provider
 * stops on the usage limit, or, idle, has reached the switch threshold
 * (increment 0968). The provider fallback sweep asks first; when no machine
 * target qualifies the sweep's own same-machine step runs as before.
 *
 * Moving is the handoff port's job (0967's checkpoint, lease and epoch),
 * provided by `LimitHandoffAdapter`. Without one, `LimitHandoffPort` refuses
 * every move, so nothing leaves the machine and only the verdicts are shown.
 * A thread the persisted handoff state holds (handing off, continued
 * elsewhere) never starts a turn here, even after a restart
 * (`localTurnBlocked`).
 *
 * The fleet (RemoteWorkers) is built on top of the orchestration runtime
 * this service lives in, so it is bound after both exist (`layerFleet`).
 *
 * @module MachineLimitHandoff
 */
import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import {
  type EnvironmentId,
  WS_METHODS,
  WsLimitHandoffRpcGroup,
  type LimitHandoffCandidate,
  type LimitHandoffCandidatesResult,
  LimitHandoffError,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpMachineListResult,
  type ProjectId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  describeMachineWait,
  judgeMachineCandidate,
  type MachineCandidateVerdict,
  providerName,
  targetMachineLabel,
} from "@specweave-studio/shared/machineFallback";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import { HandoffTurnGate } from "../handoff/HandoffTurnGate.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { providerUsageSummary } from "../usage/providerUsageSummary.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isBlockingRuntimeRequest, type PendingRequestSummary } from "./blockingRuntimeRequest.ts";

/** An idle thread at the threshold moves only when its latest turn ended this recently (D-06). */
export const LIMIT_PREMOVE_RECENT_MS = 10 * 60_000;
/** One fleet probe per project serves a sweep and the Settings view. */
const MACHINE_LIST_TTL_MS = 30_000;
const MACHINE_LIST_TIMEOUT = Duration.seconds(20);
/**
 * A move that hasn't answered by then is in doubt: never continued here, asked again.
 * Above 0967's own worst case (about 8 minutes with a running turn), and it only stops
 * the wait: the move itself is never interrupted.
 */
const HANDOFF_TIMEOUT = Duration.minutes(10);
/** Moves, refusals and waits are forgotten after a day. */
const STATE_MAX_AGE_MS = 24 * 60 * 60_000;

export type LimitHandoffReason = "usage-limit" | "threshold";

export interface LimitHandoffRequest {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly destinationEnvironmentId: EnvironmentId;
  /** "Minis", as the verdicts name it. */
  readonly destinationLabel?: string;
  readonly modelSelection: ModelSelection;
  readonly reason: LimitHandoffReason;
  /** Continue the stopped turn there from the checkpoint; false moves an idle thread. */
  readonly resume: boolean;
  /** The same key for every attempt at one stopped run (or one idle window). */
  readonly idempotencyKey: string;
  /** "Hit 95% of Claude on M4", for the thread's notice. */
  readonly sourceSummary: string;
  /** The target model as the setting names it ("Claude Opus 5.5"), for the notice. */
  readonly modelLabel?: string;
}

/** 0967 starts its messages with the machine ("Minis: …", "Minis did not answer."). */
const namesMachine = (message: string, label: string) =>
  message.startsWith(`${label}:`) || message.startsWith(`${label} `);

export type LimitHandoffOutcome =
  | {
      readonly type: "moved";
      readonly machineLabel: string;
      /** The thread there, or null when only the other machine knows it. */
      readonly threadId: string | null;
      readonly notice: string | null;
    }
  | {
      /** The move may have happened: nothing runs here and the same target is asked again. */
      readonly type: "in-doubt";
      readonly message: string;
      /**
       * The handoff state itself holds the thread here (a move still handing
       * off, or a machine that woke paused), so `message` is the wait text.
       */
      readonly heldByState?: boolean;
    }
  | {
      readonly type: "refused";
      readonly code: string;
      /** Shown on the thread as given: "Minis: secrets missing: STRIPE_KEY". */
      readonly message: string;
      /** Nothing was moved and asking again later may work (offline, busy). */
      readonly retryable: boolean;
    };

export interface LimitHandoffPortShape {
  readonly available: boolean;
  readonly handOff: (request: LimitHandoffRequest) => Effect.Effect<LimitHandoffOutcome>;
}

export const LIMIT_HANDOFF_UNAVAILABLE_MESSAGE =
  "This SpecWithCode version can't hand threads to another machine yet.";

const unavailablePort: LimitHandoffPortShape = {
  available: false,
  handOff: () =>
    Effect.succeed({
      type: "refused",
      code: "unavailable",
      message: LIMIT_HANDOFF_UNAVAILABLE_MESSAGE,
      retryable: false,
    }),
};

/** Moves a thread to another machine. Provided by the handoff mode service. */
export class LimitHandoffPort extends Context.Reference<LimitHandoffPortShape>(
  "studio/orchestration-v2/LimitHandoffPort",
  { defaultValue: () => unavailablePort },
) {}

export interface LimitHandoffTrigger {
  readonly reason: LimitHandoffReason;
  readonly resume: boolean;
  readonly key: string;
}

type TriggerThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "status" | "providerInstanceId" | "latestRunId" | "activeRunId" | "settledOverride"
> &
  Partial<Pick<OrchestrationV2ThreadShell, "latestRunCompletedAt">> & {
    readonly pendingRuntimeRequest: PendingRequestSummary | null;
  };

type TriggerRule = Pick<
  ServerSettingsValue,
  "providerLimitAction" | "providerLimitMachineTargets" | "providerLimitTargetOrder"
>;

/**
 * Whether a machine target is asked to take the thread before the local
 * step. Only at a real boundary (D-06): a turn that stopped on the limit
 * (resumed there), or an idle thread at the threshold whose latest turn
 * completed in the last ten minutes (moved with no resume). Redeeming a
 * reset, spending credits and API credits keep their priority; under "Same
 * machine first" a local fallback model goes first.
 */
export function limitHandoffTrigger(input: {
  readonly thread: TriggerThread;
  readonly rule: TriggerRule;
  readonly nowMs: number;
  /** Stopped on the limit, and the stop does not reset within the project's wait. */
  readonly stopped: boolean;
  /** Idle with usage at the switch threshold (`shouldSwitchBeforeTurn`). */
  readonly atThreshold: boolean;
  /** The local step's type, or null when the sweep has none. */
  readonly localStep: string | null;
  /** The usage window the threshold belongs to, so an idle thread moves once per window. */
  readonly windowKey: string;
}): LimitHandoffTrigger | null {
  const { thread, rule } = input;
  if (rule.providerLimitAction !== "switch") return null;
  if ((rule.providerLimitMachineTargets ?? []).length === 0) return null;
  if (input.localStep !== null && input.localStep !== "switch") return null;
  if (input.localStep === "switch" && rule.providerLimitTargetOrder === "same-machine-first")
    return null;
  if (thread.latestRunId === null || thread.activeRunId !== null) return null;
  // A question the next message answers, or one an earlier run left, holds
  // nothing; the sweep fills in that detail (a bare summary still holds).
  if (isBlockingRuntimeRequest(thread, thread.latestRunId) || thread.settledOverride === "settled")
    return null;
  if (input.stopped)
    return {
      reason: "usage-limit",
      resume: true,
      key: `limit-handoff:${thread.id}:${thread.latestRunId}`,
    };
  if (!input.atThreshold || thread.status !== "completed") return null;
  const endedMs =
    thread.latestRunCompletedAt == null
      ? Number.NaN
      : DateTime.toEpochMillis(thread.latestRunCompletedAt);
  if (!Number.isFinite(endedMs) || input.nowMs - endedMs > LIMIT_PREMOVE_RECENT_MS) return null;
  return {
    reason: "threshold",
    resume: false,
    key: `limit-premove:${thread.id}:${thread.providerInstanceId}:${input.windowKey}`,
  };
}

const targetKey = (target: { environmentId: string; modelSelection: ModelSelection }) =>
  `${target.environmentId}|${target.modelSelection.instanceId}|${target.modelSelection.model}`;

type Refusal = { readonly code: string; readonly message: string; readonly atMs: number };
type Moved = {
  readonly machineLabel: string;
  readonly threadId: string | null;
  readonly atMs: number;
};
type InDoubt = {
  readonly target: MachineCandidateVerdict["target"];
  readonly machineLabel: string;
  readonly sinceMs: number;
};
/** Why no machine took the thread, for the run it was judged on. */
type Waiting = { readonly text: string; readonly runId: string | null; readonly atMs: number };

interface State {
  readonly moved: ReadonlyMap<string, Moved>;
  readonly inDoubt: ReadonlyMap<string, InDoubt>;
  /** Per trigger key, non-retryable refusals by target. */
  readonly refused: ReadonlyMap<string, ReadonlyMap<string, Refusal>>;
  readonly waiting: ReadonlyMap<string, Waiting>;
}

const prune = <V extends { readonly atMs?: number; readonly sinceMs?: number }>(
  map: ReadonlyMap<string, V>,
  nowMs: number,
): Map<string, V> =>
  new Map(
    [...map].filter(([, value]) => nowMs - (value.atMs ?? value.sinceMs ?? 0) < STATE_MAX_AGE_MS),
  );

const pruneRefused = (
  refused: ReadonlyMap<string, ReadonlyMap<string, Refusal>>,
  nowMs: number,
): Map<string, ReadonlyMap<string, Refusal>> =>
  new Map(
    [...refused].flatMap(([key, byTarget]) => {
      const kept = prune(byTarget, nowMs);
      return kept.size === 0 ? [] : [[key, kept] as const];
    }),
  );

export interface ConsiderInput {
  readonly thread: OrchestrationV2ThreadShell;
  readonly rule: ServerSettingsValue;
  readonly trigger: LimitHandoffTrigger;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectTitle: string | null;
  readonly nowMs: number;
  /** Re-checks the trigger under the project's admission lock and current settings. */
  readonly admit: Effect.Effect<boolean>;
}

export interface LimitHandoffFleet {
  readonly listMachines: RemoteWorkers.RemoteWorkersShape["listMachines"];
  readonly port: LimitHandoffPortShape;
}

export interface MachineLimitHandoffShape {
  /** Connects the paired machines and the port once the server has built them. */
  readonly bind: (fleet: LimitHandoffFleet) => Effect.Effect<void>;
  /**
   * "handled" when the thread moved, or a move's outcome is in doubt: the
   * sweep then sends nothing here, so the turn never runs twice.
   */
  readonly consider: (input: ConsiderInput) => Effect.Effect<"handled" | "skipped">;
  /** Whether a stopped run was handed off (or may have been): nothing resumes it here. */
  readonly holds: (threadId: ThreadId, runId: string | null) => Effect.Effect<boolean>;
  /**
   * Whether the persisted handoff state keeps the thread from starting a turn
   * here (handing off, continued or leased elsewhere). Survives a restart.
   */
  readonly localTurnBlocked: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly candidates: (
    threadId: ThreadId,
  ) => Effect.Effect<LimitHandoffCandidatesResult, LimitHandoffError>;
}

const disabled: MachineLimitHandoffShape = {
  bind: () => Effect.void,
  consider: () => Effect.succeed("skipped"),
  holds: () => Effect.succeed(false),
  localTurnBlocked: () => Effect.succeed(false),
  candidates: () =>
    Effect.fail(
      new LimitHandoffError({ code: "failed", message: LIMIT_HANDOFF_UNAVAILABLE_MESSAGE }),
    ),
};

export class MachineLimitHandoff extends Context.Reference<MachineLimitHandoffShape>(
  "studio/orchestration-v2/MachineLimitHandoff",
  { defaultValue: () => disabled },
) {}

const verdictToCandidate = (verdict: MachineCandidateVerdict): LimitHandoffCandidate => ({
  environmentId: verdict.target.environmentId,
  machineLabel: verdict.machineLabel,
  modelSelection: verdict.target.modelSelection,
  eligible: verdict.eligible,
  reason: verdict.reason,
  text: verdict.text,
  usedPercent: verdict.usedPercent,
  resetsAt: verdict.resetsAt,
});

/**
 * Whether the thread's latest turn may be continued elsewhere: one still
 * running, or one the provider stopped on its usage limit. A turn the user
 * stopped, or one that completed, was cancelled or failed otherwise, never is.
 */
export function limitResumable(
  thread: Pick<OrchestrationV2ThreadShell, "status" | "activeRunId" | "latestRunId"> &
    Partial<Pick<OrchestrationV2ThreadShell, "lastErrorClass">>,
): boolean {
  if (thread.activeRunId !== null) return true;
  return (
    thread.latestRunId !== null &&
    thread.status === "failed" &&
    thread.lastErrorClass === "usage_limit"
  );
}

export const make = Effect.gen(function* () {
  const fleet = yield* Ref.make<LimitHandoffFleet | null>(null);
  const gate = yield* HandoffTurnGate;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* Projects.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const state = yield* Ref.make<State>({
    moved: new Map(),
    inDoubt: new Map(),
    refused: new Map(),
    waiting: new Map(),
  });
  const machineLists = yield* Ref.make(
    new Map<
      string,
      { readonly atMs: number; readonly list: OrchestratorMcpMachineListResult | string }
    >(),
  );

  /** The fleet as this project sees it, or why it couldn't be read. */
  const machinesFor = (projectId: ProjectId, nowMs: number) =>
    Effect.gen(function* () {
      const bound = yield* Ref.get(fleet);
      if (bound === null) return "the paired machines aren't loaded yet";
      const cached = (yield* Ref.get(machineLists)).get(projectId);
      if (cached !== undefined && nowMs - cached.atMs < MACHINE_LIST_TTL_MS) return cached.list;
      const read = yield* bound
        .listMachines({ projectId, probe: true })
        .pipe(Effect.timeout(MACHINE_LIST_TIMEOUT), Effect.exit);
      const list = Exit.isSuccess(read) ? read.value : "couldn't check the paired machines";
      yield* Ref.update(machineLists, (current) =>
        new Map(current).set(projectId, { atMs: nowMs, list }),
      );
      return list;
    });

  const judge = (input: {
    readonly thread: Pick<OrchestrationV2ThreadShell, "projectId" | "providerInstanceId">;
    readonly rule: ServerSettingsValue;
    readonly source: ServerProvider | undefined;
    readonly projectTitle: string | null;
    readonly nowMs: number;
    readonly refusals: ReadonlyMap<string, Refusal> | undefined;
  }) =>
    Effect.gen(function* () {
      const targets = input.rule.providerLimitMachineTargets;
      if (targets.length === 0) return [] as ReadonlyArray<MachineCandidateVerdict>;
      const list = yield* machinesFor(input.thread.projectId, input.nowMs);
      if (typeof list === "string")
        return targets.map((target): MachineCandidateVerdict => {
          const machineLabel = targetMachineLabel(target, undefined);
          return {
            target,
            machineLabel,
            eligible: false,
            reason: "not_checked",
            text: `${machineLabel}: ${list}`,
            usedPercent: null,
            resetsAt: null,
          };
        });
      const project = yield* projects
        .getById(input.thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const logical = Option.isSome(project)
        ? project.value.workspaceSettings?.logicalProject
        : undefined;
      const linkedEnvironmentIds =
        logical == null ? null : logical.members.map((member) => member.environmentId);
      const sourceUsage =
        input.source === undefined ? null : providerUsageSummary(input.source, input.nowMs);
      const source = {
        machineLabel: list.local.label,
        driverKind: input.source?.driver ?? "",
        accountFingerprint: sourceUsage?.accountFingerprint ?? null,
      };
      return targets.map((target) => {
        const machine = list.machines.find((row) => row.environmentId === target.environmentId);
        const verdict = judgeMachineCandidate({
          target,
          machine,
          source,
          projectTitle: input.projectTitle,
          linkedEnvironmentIds,
          thresholdPercent: input.rule.providerLimitSwitchAtPercent,
          unknownUsageEligible: input.rule.providerLimitUnknownUsageEligible,
          nowMs: input.nowMs,
          excludedModels: input.rule.providerLimitExcludedModels,
        });
        // A personal assistant's threads never continue on another machine.
        if (Option.isSome(project) && isPersonalAssistantProject(project.value))
          return {
            ...verdict,
            eligible: false,
            reason: "refused" as const,
            text: `${verdict.machineLabel}: ${PERSONAL_ASSISTANT_PRIVATE_MESSAGE}`,
          };
        const refusal = input.refusals?.get(targetKey(target));
        return refusal === undefined
          ? verdict
          : {
              ...verdict,
              eligible: false,
              reason: "refused" as const,
              // 0967 names the machine itself ("Minis: no .env.local; Minis: …").
              text: namesMachine(refusal.message, verdict.machineLabel)
                ? refusal.message
                : `${verdict.machineLabel}: ${refusal.message}`,
            };
      });
    });

  const sourceSummary = (
    thread: OrchestrationV2ThreadShell,
    trigger: LimitHandoffTrigger,
    source: ServerProvider | undefined,
    rule: ServerSettingsValue,
    machineLabel: string,
  ) => {
    const name = providerName(source?.driver ?? "");
    return trigger.reason === "threshold"
      ? `Hit ${rule.providerLimitSwitchAtPercent ?? 100}% of ${name} on ${machineLabel}`
      : `${name} limit reached on ${machineLabel}`;
  };

  const portOf = Ref.get(fleet).pipe(Effect.map((bound) => bound?.port ?? unavailablePort));

  const consider = Effect.fn("MachineLimitHandoff.consider")(function* (input: ConsiderInput) {
    const port = yield* portOf;
    const { thread, trigger, nowMs } = input;
    const setWaiting = (text: string) =>
      Ref.update(state, (s) => ({
        ...s,
        waiting: prune(s.waiting, nowMs).set(thread.id, {
          text,
          runId: thread.latestRunId,
          atMs: nowMs,
        }),
      }));
    if (!port.available) {
      yield* setWaiting(LIMIT_HANDOFF_UNAVAILABLE_MESSAGE);
      return "skipped" as const;
    }
    const current = yield* Ref.get(state);
    if (current.moved.has(trigger.key)) return "handled" as const;
    // Only a running turn or one stopped on the limit continues elsewhere.
    if (trigger.resume && !limitResumable(thread)) {
      yield* Effect.logWarning("orchestration-v2.limit-handoff.not-resumable", {
        threadId: thread.id,
        key: trigger.key,
        status: thread.status,
      });
      return "skipped" as const;
    }
    const source = input.providers.find((p) => p.instanceId === thread.providerInstanceId);
    const doubt = current.inDoubt.get(trigger.key);
    const verdicts =
      doubt === undefined
        ? yield* judge({
            thread,
            rule: input.rule,
            source,
            projectTitle: input.projectTitle,
            nowMs,
            refusals: current.refused.get(trigger.key),
          })
        : [];
    // A move in doubt is asked again on the same target, whatever it looks like now.
    const attempts =
      doubt === undefined
        ? verdicts.filter((verdict) => verdict.eligible)
        : [{ target: doubt.target, machineLabel: doubt.machineLabel }];
    const list = yield* machinesFor(thread.projectId, nowMs);
    const localLabel = typeof list === "string" ? "this machine" : list.local.label;
    // Refusals worth asking again later still name their reason in the wait text.
    const transient = new Map<string, Refusal>();
    for (const attempt of attempts) {
      if (doubt === undefined && !(yield* input.admit)) return "skipped" as const;
      yield* Ref.update(state, (s) => ({
        ...s,
        inDoubt: new Map(s.inDoubt).set(trigger.key, {
          target: attempt.target,
          machineLabel: attempt.machineLabel,
          sinceMs: doubt?.sinceMs ?? nowMs,
        }),
      }));
      const request: LimitHandoffRequest = {
        threadId: thread.id,
        projectId: thread.projectId,
        destinationEnvironmentId: attempt.target.environmentId,
        destinationLabel: attempt.machineLabel,
        modelSelection: attempt.target.modelSelection,
        reason: trigger.reason,
        resume: trigger.resume,
        idempotencyKey: trigger.key,
        sourceSummary: sourceSummary(thread, trigger, source, input.rule, localLabel),
        ...(attempt.target.modelLabel === undefined
          ? {}
          : { modelLabel: attempt.target.modelLabel }),
      };
      // Interrupting 0967 mid-takeover would leave the lease "handing-off" with nobody to
      // settle it, so the move runs detached and the timeout (or a stopping sweep) only
      // stops waiting for it.
      const move = yield* Effect.forkDetach(port.handOff(request));
      const answer = yield* Fiber.await(move).pipe(Effect.timeoutOption(HANDOFF_TIMEOUT));
      const failure = Option.isSome(answer) && Exit.isFailure(answer.value) ? answer.value : null;
      // No answer, a defect or an in-doubt answer: the move may have happened.
      const outcome: LimitHandoffOutcome =
        Option.isSome(answer) && Exit.isSuccess(answer.value)
          ? answer.value.value
          : { type: "in-doubt", message: failure === null ? "timed out" : "failed" };
      if (outcome.type === "in-doubt") {
        yield* Effect.logWarning("orchestration-v2.limit-handoff.in-doubt", {
          threadId: thread.id,
          key: trigger.key,
          destination: attempt.target.environmentId,
          message: outcome.message,
          ...(failure === null ? {} : { cause: failure.cause }),
        });
        yield* setWaiting(
          outcome.heldByState === true
            ? outcome.message
            : `${attempt.machineLabel} hasn't confirmed the handoff yet; the thread stays here until it answers.`,
        );
        return "handled" as const;
      }
      if (outcome.type === "moved") {
        yield* Ref.update(state, (s) => {
          const inDoubt = new Map(s.inDoubt);
          inDoubt.delete(trigger.key);
          const waiting = new Map(s.waiting);
          waiting.delete(thread.id);
          return {
            ...s,
            inDoubt,
            waiting,
            moved: prune(s.moved, nowMs).set(trigger.key, {
              machineLabel: outcome.machineLabel,
              threadId: outcome.threadId,
              atMs: nowMs,
            }),
          };
        });
        yield* Effect.logInfo("orchestration-v2.limit-handoff.moved", {
          threadId: thread.id,
          key: trigger.key,
          reason: trigger.reason,
          to: attempt.target.environmentId,
          remoteThreadId: outcome.threadId,
          notice: outcome.notice,
        });
        return "handled" as const;
      }
      // Refused: nothing moved, so the thread may continue elsewhere.
      yield* Ref.update(state, (s) => {
        const inDoubt = new Map(s.inDoubt);
        inDoubt.delete(trigger.key);
        if (outcome.retryable) {
          transient.set(targetKey(attempt.target), {
            code: outcome.code,
            message: outcome.message,
            atMs: nowMs,
          });
          return { ...s, inDoubt };
        }
        const refused = pruneRefused(s.refused, nowMs);
        const forKey = new Map(refused.get(trigger.key) ?? []);
        forKey.set(targetKey(attempt.target), {
          code: outcome.code,
          message: outcome.message,
          atMs: nowMs,
        });
        refused.set(trigger.key, forKey);
        return { ...s, inDoubt, refused };
      });
      yield* Effect.logInfo("orchestration-v2.limit-handoff.refused", {
        threadId: thread.id,
        key: trigger.key,
        to: attempt.target.environmentId,
        code: outcome.code,
        retryable: outcome.retryable,
      });
    }
    const latest = yield* Ref.get(state);
    const shown = yield* judge({
      thread,
      rule: input.rule,
      source,
      projectTitle: input.projectTitle,
      nowMs,
      refusals: new Map([...transient, ...(latest.refused.get(trigger.key) ?? [])]),
    });
    yield* setWaiting(describeMachineWait(shown));
    yield* Effect.logInfo("orchestration-v2.limit-handoff.no-machine", {
      threadId: thread.id,
      key: trigger.key,
      reasons: shown.map((verdict) => verdict.reason),
    });
    return "skipped" as const;
  });

  const holds = (threadId: ThreadId, runId: string | null) =>
    Ref.get(state).pipe(
      Effect.map((s) => {
        if (runId === null) return false;
        const key = `limit-handoff:${threadId}:${runId}`;
        return s.moved.has(key) || s.inDoubt.has(key);
      }),
    );

  const localTurnBlocked = (threadId: ThreadId) =>
    gate.check(threadId).pipe(Effect.map((refusal) => refusal !== null));

  const candidates = Effect.fn("MachineLimitHandoff.candidates")(function* (threadId: ThreadId) {
    const thread = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (thread === null)
      return yield* new LimitHandoffError({ code: "not_found", message: "Thread not found." });
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const preferences = yield* settings.getSettings.pipe(
      Effect.mapError(
        () => new LimitHandoffError({ code: "failed", message: "Couldn't read the settings." }),
      ),
    );
    const rule = resolveProjectSettings(preferences, thread.projectId).settings;
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const providers = yield* registry.getProviders;
    const current = yield* Ref.get(state);
    const verdicts = yield* judge({
      thread,
      rule,
      source: providers.find((p) => p.instanceId === thread.providerInstanceId),
      projectTitle: Option.isSome(project) ? project.value.title : null,
      nowMs,
      refusals: thread.latestRunId
        ? current.refused.get(`limit-handoff:${thread.id}:${thread.latestRunId}`)
        : undefined,
    });
    const waiting = current.waiting.get(thread.id);
    return {
      available: (yield* portOf).available,
      order: rule.providerLimitTargetOrder,
      thresholdPercent: rule.providerLimitSwitchAtPercent,
      candidates: verdicts.map(verdictToCandidate),
      waiting:
        waiting !== undefined &&
        waiting.runId === thread.latestRunId &&
        nowMs - waiting.atMs < STATE_MAX_AGE_MS
          ? waiting.text
          : null,
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    } satisfies LimitHandoffCandidatesResult;
  });

  const bind = (bound: LimitHandoffFleet) =>
    Ref.set(fleet, bound).pipe(
      Effect.andThen(Ref.set(machineLists, new Map())),
      Effect.andThen(
        Effect.logInfo("orchestration-v2.limit-handoff.bound", {
          portAvailable: bound.port.available,
        }),
      ),
    );

  return {
    bind,
    consider,
    holds,
    localTurnBlocked,
    candidates,
  } satisfies MachineLimitHandoffShape;
});

export const layer = Layer.effect(MachineLimitHandoff, make);

/** Binds the paired machines and the handoff port; built where both are in context. */
export const layerFleet = Layer.effectDiscard(
  Effect.gen(function* () {
    const handoff = yield* MachineLimitHandoff;
    const remote = yield* RemoteWorkers.RemoteWorkers;
    const port = yield* LimitHandoffPort;
    yield* handoff.bind({ listMachines: remote.listMachines, port });
  }),
);

export const layerRpcHandlers = WsLimitHandoffRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const handoff = yield* MachineLimitHandoff;
    return {
      [WS_METHODS.limitHandoffCandidates]: (input) => handoff.candidates(input.threadId),
    };
  }),
);
