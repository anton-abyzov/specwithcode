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
  teamRulesInstanceDriver,
  teamRulesMachines,
  teamRulesSelectionRefusal,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules, teamRulesForFolder } from "../teamRules/TeamRules.ts";
import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import {
  type EnvironmentId,
  type ProviderLimitMachineTarget,
  WS_METHODS,
  WsLimitHandoffRpcGroup,
  type LimitHandoffCandidate,
  type LimitHandoffCandidatesResult,
  LimitHandoffError,
  type LimitHandoffTrackDecision,
  MODEL_TRACK_LABELS,
  type ModelSelection,
  type ModelTrack,
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
import { usageResetAt } from "@specweave-studio/shared/providerFallback";
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
import {
  describeReviewWait,
  machineReviewTarget,
  REVIEW_FAMILY_UNKNOWN,
  type ReviewStays,
  sourceReviewLock,
} from "../handoff/handoffReviewLock.ts";
import { AUTOMATIC_OFF } from "../handoff/HandoffTransferRunner.ts";
import { HandoffTurnGate } from "../handoff/HandoffTurnGate.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { providerUsageSummary } from "../usage/providerUsageSummary.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { PeerCheckRequest } from "../handoff/handoffPlan.ts";
import { isBlockingRuntimeRequest, type PendingRequestSummary } from "./blockingRuntimeRequest.ts";
import {
  type JudgedTrackMachine,
  judgeTrackMachine,
  type ThreadTrackState,
  type TrackCheckAnswer,
  trackDecision,
  trackMachineReach,
  trackOutReason,
} from "./limitHandoffTrack.ts";

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
  /** The track that is out here, when that is why the thread leaves (1390). */
  readonly track?: ModelTrack;
  /** When the usage window that set the move off resets, for the transfer record. */
  readonly usageWindowKey?: string;
  /** The run the move was admitted for; with `resume`, what the transfer is fenced to. */
  readonly runId?: string;
}

/** What a machine is asked before an automatic track start; the port adds this machine's identity. */
export type LimitHandoffCheckInput = Pick<
  PeerCheckRequest,
  "start" | "thresholdPercent" | "threads"
>;

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
  /**
   * Asks a machine what it would run a track's thread on, before anything is
   * copied there. Without it no thread leaves for a track that is out here.
   */
  readonly check?: (
    environmentId: EnvironmentId,
    input: LimitHandoffCheckInput,
  ) => Effect.Effect<Exclude<TrackCheckAnswer, { readonly kind: "unreachable" }>>;
  /** The thread's "Hand off automatically" is Off: nothing starts for it by itself. */
  readonly optedOut?: (threadId: ThreadId) => Effect.Effect<boolean>;
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
  /** Set for a thread on a track that is out on this machine: the target is asked for that track. */
  readonly track?: Extract<ThreadTrackState, { readonly kind: "track" }>;
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
 *
 * A thread on a track ignores that order (1390): no machine is asked while
 * its track has room here, and one is asked once the track is out here,
 * whatever the saved order says. A thread whose track is not known, and a
 * review thread, start nothing by themselves.
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
  /** The thread's track and whether it is out here; absent for a project without tracks. */
  readonly track?: ThreadTrackState;
}): LimitHandoffTrigger | null {
  const { thread, rule } = input;
  const track = input.track ?? { kind: "none" };
  if (track.kind === "held") return null;
  if (rule.providerLimitAction !== "switch") return null;
  if ((rule.providerLimitMachineTargets ?? []).length === 0) return null;
  if (input.localStep !== null && input.localStep !== "switch") return null;
  if (track.kind === "track") {
    if (!track.outHere) return null;
  } else if (input.localStep === "switch" && rule.providerLimitTargetOrder === "same-machine-first")
    return null;
  const onTrack = track.kind === "track" ? { track } : {};
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
      ...onTrack,
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
    ...onTrack,
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
/** The last decision for a thread on a track; its machines are not asked again before `recheckAtMs`. */
type Tracked = {
  readonly key: string;
  readonly runId: string | null;
  readonly decision: LimitHandoffTrackDecision;
  readonly recheckAtMs: number;
  readonly atMs: number;
};

interface State {
  readonly moved: ReadonlyMap<string, Moved>;
  readonly inDoubt: ReadonlyMap<string, InDoubt>;
  /** Per trigger key, non-retryable refusals by target. */
  readonly refused: ReadonlyMap<string, ReadonlyMap<string, Refusal>>;
  readonly waiting: ReadonlyMap<string, Waiting>;
  /** Per thread. */
  readonly tracks: ReadonlyMap<string, Tracked>;
}

/** A wait on a track is kept until the machines are asked again, however far that is. */
const pruneTracks = (tracks: ReadonlyMap<string, Tracked>, nowMs: number): Map<string, Tracked> =>
  new Map(
    [...tracks].filter(
      ([, value]) => nowMs - value.atMs < STATE_MAX_AGE_MS || nowMs < value.recheckAtMs,
    ),
  );

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

/** A verdict, and for a review thread that stays, what about this machine keeps it. */
type Verdict = MachineCandidateVerdict & { readonly review?: ReviewStays };

const verdictToCandidate = (verdict: Verdict): LimitHandoffCandidate => ({
  environmentId: verdict.target.environmentId,
  machineLabel: verdict.machineLabel,
  modelSelection: verdict.target.modelSelection,
  eligible: verdict.eligible,
  reason: verdict.reason,
  text: verdict.text,
  usedPercent: verdict.usedPercent,
  resetsAt: verdict.resetsAt,
  ...(verdict.review === undefined ? {} : { review: verdict.review }),
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
    tracks: new Map(),
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
    readonly thread: Pick<
      OrchestrationV2ThreadShell,
      "projectId" | "providerInstanceId" | "worktreePath"
    > &
      Partial<Pick<OrchestrationV2ThreadShell, "routing" | "title" | "modelSelection">>;
    readonly rule: ServerSettingsValue;
    readonly source: ServerProvider | undefined;
    readonly projectTitle: string | null;
    readonly nowMs: number;
    readonly refusals: ReadonlyMap<string, Refusal> | undefined;
  }) =>
    Effect.gen(function* () {
      // A machine target is a fallback too, so it stays inside this machine's list.
      // Reach rules decide first: no target at all when work may not cross machines.
      if (teamRulesMachines(yield* currentTeamRules) === "none") {
        return [] as ReadonlyArray<Verdict>;
      }
      // The list is the one for this thread's folder, which a zone or repository can narrow.
      const folderProject = yield* projects
        .getById(input.thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<{ readonly workspaceRoot: string }>()));
      const teamRules = yield* teamRulesForFolder(
        input.thread.worktreePath ?? Option.getOrUndefined(folderProject)?.workspaceRoot,
      );
      // A review thread carries its reviewer lock (1390 AC-40): a machine is a
      // target only when it keeps the lock and offers a reviewer inside it.
      // One whose reviewer has no known family cannot be locked, so it waits.
      const review = sourceReviewLock(input.thread);
      if (review.kind === "unknown-family") return [] as ReadonlyArray<Verdict>;
      const targets = input.rule.providerLimitMachineTargets.filter(
        (target) =>
          teamRulesSelectionRefusal(teamRules, {
            driver: teamRulesInstanceDriver(input.rule, target.modelSelection.instanceId),
            model: target.modelSelection.model,
          }) === null,
      );
      if (targets.length === 0) return [] as ReadonlyArray<Verdict>;
      const list = yield* machinesFor(input.thread.projectId, input.nowMs);
      if (typeof list === "string")
        return targets.map((target): Verdict => {
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
      const judgeOn = (
        target: ProviderLimitMachineTarget,
        machine: (typeof list.machines)[number] | undefined,
      ) =>
        judgeMachineCandidate({
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
      return targets.map((saved): Verdict => {
        const machine = list.machines.find((row) => row.environmentId === saved.environmentId);
        const locked =
          review.kind !== "lock" || machine?.teamRulesRefused !== undefined
            ? null
            : machineReviewTarget({
                lock: review.lock,
                target: saved,
                machine,
                machineLabel: targetMachineLabel(saved, machine),
                allowed: (driver, model) =>
                  teamRulesSelectionRefusal(teamRules, { driver, model }) === null,
                usable: (target) => judgeOn(target, machine).eligible,
              });
        if (locked?.kind === "stays") {
          const reason = locked.review === "update_needed" ? "update_needed" : "refused";
          return {
            target: saved,
            machineLabel: targetMachineLabel(saved, machine),
            eligible: false,
            reason,
            text: locked.text,
            usedPercent: null,
            resetsAt: null,
            review: locked.review,
          };
        }
        const target = locked?.target ?? saved;
        if (machine?.teamRulesRefused !== undefined) {
          const machineLabel = targetMachineLabel(target, machine);
          return {
            target,
            machineLabel,
            eligible: false,
            reason: "refused" as const,
            text: `${machineLabel}: ${machine.teamRulesRefused}`,
            usedPercent: null,
            resetsAt: null,
          } satisfies MachineCandidateVerdict;
        }
        const judged = judgeOn(target, machine);
        // A review moves only to a machine that was read and keeps its lock.
        const verdict = locked !== null && !locked.proven ? { ...judged, eligible: false } : judged;
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

  /**
   * The machines a track's thread may go to: each machine of the saved targets
   * once, in their order, with why it cannot be asked when it cannot. The model
   * it would run is the machine's own answer, never the saved target's.
   */
  const trackMachines = (
    thread: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">,
    rule: ServerSettingsValue,
    projectTitle: string | null,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      if (teamRulesMachines(yield* currentTeamRules) === "none") return [];
      const project = yield* projects
        .getById(thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      // A personal assistant's threads never continue on another machine.
      if (Option.isSome(project) && isPersonalAssistantProject(project.value)) return [];
      const teamRules = yield* teamRulesForFolder(
        thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot,
      );
      const list = yield* machinesFor(thread.projectId, nowMs);
      const seen = new Set<string>();
      return rule.providerLimitMachineTargets.flatMap((target) => {
        if (seen.has(target.environmentId)) return [];
        seen.add(target.environmentId);
        const machine =
          typeof list === "string"
            ? undefined
            : list.machines.find((row) => row.environmentId === target.environmentId);
        const label = targetMachineLabel(target, machine);
        return [
          {
            environmentId: target.environmentId,
            label,
            reach:
              typeof list === "string"
                ? `${label}: ${list}`
                : trackMachineReach({ label, machine, projectTitle }),
            teamRules,
          },
        ];
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
    // A track that is out here asks each machine for that track; a move in doubt is settled first.
    const tracked = trigger.track !== undefined && doubt === undefined ? trigger.track : null;
    const verdicts =
      doubt === undefined && tracked === null
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
    // When the window that sends the thread away resets: the track's first reset here, or
    // the stop's own. A thread sent for it is not sent straight back before then.
    // An idle thread moved at the threshold has no stop: its sign-in's own reset is the end.
    const stopResetMs = Date.parse(thread.usageLimitResetAt ?? "");
    const windowEndMs =
      tracked !== null
        ? tracked.earliestResetMs
        : Number.isFinite(stopResetMs)
          ? stopResetMs
          : source === undefined
            ? null
            : usageResetAt(
                source,
                input.rule.providerLimitSwitchAtPercent ?? 100,
                nowMs,
                thread.modelSelection.model,
              );
    const windowEnd =
      windowEndMs !== null && Number.isFinite(windowEndMs)
        ? DateTime.formatIso(DateTime.makeUnsafe(windowEndMs))
        : null;
    /** Asks one target to take the thread; "next" when it refused and nothing moved. */
    const moveTo = Effect.fnUntraced(function* (
      attempt: {
        readonly target: MachineCandidateVerdict["target"];
        readonly machineLabel: string;
      },
      summary: string,
      track?: ModelTrack,
    ) {
      // The last check before sending: the trigger, and with it the track's state here, read afresh.
      if (doubt === undefined) {
        if (!(yield* input.admit)) return "skipped" as const;
        // The destination was approved under settings that may have changed since.
        const saved = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const targets =
          saved === null
            ? []
            : resolveProjectSettings(saved, thread.projectId).settings.providerLimitMachineTargets;
        if (!targets.some((target) => target.environmentId === attempt.target.environmentId))
          return "skipped" as const;
        // Off may have been chosen while a machine answered; unreadable counts as Off.
        if (port.optedOut !== undefined && (yield* port.optedOut(thread.id))) {
          yield* setWaiting(AUTOMATIC_OFF);
          return "skipped" as const;
        }
      }
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
        sourceSummary: summary,
        ...(attempt.target.modelLabel === undefined
          ? {}
          : { modelLabel: attempt.target.modelLabel }),
        ...(track === undefined ? {} : { track }),
        ...(thread.latestRunId === null ? {} : { runId: thread.latestRunId }),
        ...(windowEnd === null ? {} : { usageWindowKey: windowEnd }),
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
      return { refused: outcome.message };
    });

    if (tracked !== null) {
      // A review keeps its reviewer: no machine is asked for a track on its behalf.
      if (sourceReviewLock(thread).kind !== "none") return "skipped" as const;
      if (port.optedOut !== undefined && (yield* port.optedOut(thread.id))) {
        yield* setWaiting(AUTOMATIC_OFF);
        return "skipped" as const;
      }
      const held = current.tracks.get(thread.id);
      // No machine had the track: nothing is asked again before the reset it named.
      if (
        held !== undefined &&
        held.key === trigger.key &&
        held.decision.target === null &&
        nowMs < held.recheckAtMs
      )
        return "skipped" as const;
      const check = port.check;
      if (check === undefined) {
        yield* setWaiting(LIMIT_HANDOFF_UNAVAILABLE_MESSAGE);
        return "skipped" as const;
      }
      const remember = (decision: LimitHandoffTrackDecision) =>
        Ref.update(state, (s) => ({
          ...s,
          tracks: pruneTracks(s.tracks, nowMs).set(thread.id, {
            key: trigger.key,
            runId: thread.latestRunId,
            decision,
            recheckAtMs: decision.recheckAt === null ? nowMs : Date.parse(decision.recheckAt),
            atMs: nowMs,
          }),
        }));
      const decide = (
        machines: ReadonlyArray<JudgedTrackMachine>,
        target: LimitHandoffTrackDecision["target"],
      ) =>
        trackDecision({
          threadId: thread.id,
          track: tracked.track,
          machineLabel: localLabel,
          outHere: tracked.outHere,
          localResetMs: tracked.earliestResetMs,
          machines,
          target,
          nowMs,
        });
      const judged: Array<JudgedTrackMachine> = [];
      for (const machine of yield* trackMachines(thread, input.rule, input.projectTitle, nowMs)) {
        const answer: TrackCheckAnswer =
          machine.reach !== null
            ? { kind: "unreachable", line: machine.reach }
            : yield* check(machine.environmentId, {
                start: "automatic",
                thresholdPercent: input.rule.providerLimitSwitchAtPercent,
                threads: [
                  {
                    sourceThreadId: thread.id,
                    sourceProjectId: thread.projectId,
                    modelSelection: thread.modelSelection,
                    track: tracked.track,
                    driverKind: source?.driver ?? "",
                    accountFingerprints: [...tracked.fingerprints],
                  },
                ],
              });
        const row = judgeTrackMachine({
          environmentId: machine.environmentId,
          machineLabel: machine.label,
          threadId: thread.id,
          answer,
        });
        const selection = row.state === "room" ? (row.evidence?.modelSelection ?? null) : null;
        if (selection === null) {
          judged.push(row);
          continue;
        }
        // The sign-in the machine confirmed stays inside this folder's rules, like any fallback.
        const rules = teamRulesSelectionRefusal(machine.teamRules, {
          driver: teamRulesInstanceDriver(input.rule, selection.instanceId),
          model: selection.model,
        });
        if (rules !== null) {
          judged.push({
            ...row,
            state: "error",
            line: `${row.machineLabel}: ${rules.message}`,
            evidence: null,
          });
          continue;
        }
        const result = yield* moveTo(
          {
            target: {
              environmentId: machine.environmentId,
              label: row.machineLabel,
              modelSelection: selection,
            },
            machineLabel: row.machineLabel,
          },
          trackOutReason(tracked.track, localLabel),
          tracked.track,
        );
        if (result === "skipped") return result;
        if (result === "handled") {
          yield* remember(
            decide([...judged, row], {
              environmentId: machine.environmentId,
              machineLabel: row.machineLabel,
              modelSelection: selection,
              disposition: trigger.resume ? "resume" : "ready",
            }),
          );
          return result;
        }
        judged.push({
          ...row,
          state: "error",
          line: namesMachine(result.refused, row.machineLabel)
            ? result.refused
            : `${row.machineLabel}: ${result.refused}`,
          evidence: null,
        });
      }
      const decision = decide(judged, null);
      yield* remember(decision);
      yield* setWaiting(
        decision.everyMachineOut
          ? `${MODEL_TRACK_LABELS[tracked.track]} track is out on every machine.`
          : judged.length === 0
            ? "No other machine is set up to take over."
            : `No other machine has room: ${judged.map((machine) => machine.line).join("; ")}.`,
      );
      yield* Effect.logInfo("orchestration-v2.limit-handoff.track-wait", {
        threadId: thread.id,
        key: trigger.key,
        track: tracked.track,
        everyMachineOut: decision.everyMachineOut,
        recheckAt: decision.recheckAt,
        machines: judged.map((machine) => machine.state),
      });
      return "skipped" as const;
    }

    for (const attempt of attempts) {
      const result = yield* moveTo(
        attempt,
        sourceSummary(thread, trigger, source, input.rule, localLabel),
      );
      if (result === "skipped" || result === "handled") return result;
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
    const unlockable =
      sourceReviewLock(thread).kind === "unknown-family" &&
      input.rule.providerLimitMachineTargets.length > 0;
    // A review that stays is told once, by its own row.
    yield* setWaiting(
      unlockable
        ? REVIEW_FAMILY_UNKNOWN
        : (describeReviewWait(shown) ??
            describeMachineWait(shown.filter((verdict) => verdict.review === undefined))),
    );
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
    const tracked = current.tracks.get(thread.id);
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
      track:
        tracked !== undefined &&
        tracked.runId === thread.latestRunId &&
        (nowMs - tracked.atMs < STATE_MAX_AGE_MS || nowMs < tracked.recheckAtMs)
          ? tracked.decision
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
