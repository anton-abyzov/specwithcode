import {
  DEFAULT_SERVER_SETTINGS,
  OrchestratorMcpFailure,
  type ModelLane,
  type ModelSelection,
  type OrchestratorMcpTarget,
  type Project,
  type ServerProvider,
  type TaskClass,
  type TaskRoutingDecision,
} from "@specweave-studio/contracts";
import { withDefaultModelOptions } from "@specweave-studio/shared/coordinatorDefault";
import { modelSelectionEffortValue } from "@specweave-studio/shared/effortLevel";
import {
  formatProbability,
  readRoutingDecision,
  routingDecisionRequest,
  type RoutingDecision,
} from "@specweave-studio/shared/decisionModel";
import { classifyLane, resolveLaneRouting } from "@specweave-studio/shared/modelLanes";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  classifyTask,
  resolveTaskRouting,
  routingPromptNote,
  type TaskClassificationInput,
} from "@specweave-studio/shared/taskRouting";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  askDecisionModel,
  jevConfigFromSettings,
  ROUTING_DECISION_TIMEOUT_MS,
} from "../decisions/DecisionModel.ts";
import { simulatedUsageLimitInstances } from "../orchestration-v2/ProviderFailure.ts";
import { usageLimitHeldInstances } from "../orchestration-v2/UnopenableHolds.ts";
import { ProviderFallbackEnv } from "../orchestration-v2/ProviderFallbackWorker.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A caller named the model or provider: a pin, which Auto never touches. */
export function targetPinsModel(target: OrchestratorMcpTarget | undefined): boolean {
  return Boolean(target?.providerInstanceId || target?.driverKind || target?.model);
}

/**
 * Whether Auto may choose this worker's model: nothing named a model, and
 * either the app is already choosing it (a project coordinator's worker) or
 * the caller asked for routing with a task class. Any other thread keeps
 * inheriting its own model, so a lane pinned to one model stays on it.
 */
export function autoRoutingApplies(input: {
  readonly pinned: boolean;
  readonly isCoordinator: boolean;
  readonly taskClass: TaskClass | undefined;
  readonly taskLane?: ModelLane | undefined;
}): boolean {
  return (
    !input.pinned &&
    (input.isCoordinator || input.taskClass !== undefined || input.taskLane !== undefined)
  );
}

/**
 * The routing decision for one worker, or null when neither the model lanes
 * nor Auto have anything to say for the project. `baseline` is the model the
 * app would use otherwise. The lanes go first: a worker starts on the first
 * entry of its lane (complex or routine) that can run now. When the lane is
 * empty, or none of its entries can run, Auto tiers decide if Auto is on.
 * Reads the project's resolved settings, the switch threshold and provider
 * order. The only model call is to the decision model, when one is set up and
 * the rules could not settle the lane or the kind of work; it waits at most
 * two seconds and any failure keeps the rules' answer. The decision is logged
 * whether or not it moved the worker.
 */
export const routeWorkerTask = Effect.fn("project.routeWorkerTask")(function* (input: {
  readonly project: Project;
  readonly baseline: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly task: TaskClassificationInput;
  /** The caller's judgement of the work: complex or routine. */
  readonly laneHint?: ModelLane | undefined;
  readonly runnableInstanceIds?: ReadonlySet<string>;
  /** The settings service a long-lived caller captured; else the current context's. */
  readonly settings?: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
  /** How the decision model is reached; tests pass a fake. */
  readonly decisionFetch?: typeof fetch;
}) {
  const settings =
    input.settings !== undefined && Option.isSome(input.settings)
      ? input.settings
      : yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const preferences = Option.isSome(settings)
    ? yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS))
    : DEFAULT_SERVER_SETTINGS;
  const rule = resolveProjectSettings(preferences, input.project.id, input.project).settings;
  const lanesSet =
    rule.modelLanes.complex.length > 0 ||
    rule.modelLanes.routine.length > 0 ||
    rule.learnedModelPreferences.length > 0;
  if (rule.taskRouting.mode !== "auto" && !lanesSet) return null;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const limited = new Set<string>(simulatedUsageLimitInstances(yield* ProviderFallbackEnv));
  // A provider that reports no usage but stopped a thread on its limit
  // (Copilot's monthly quota) reads as ready: no new worker starts there.
  for (const instanceId of yield* usageLimitHeldInstances(nowMs)) limited.add(instanceId);
  const ruled = classifyTask(input.task);
  // The decision model settles what the rules cannot: a lane nobody named, or
  // a kind of work the keywords left uncertain. Any failure keeps the rules.
  const needsLane =
    lanesSet &&
    input.laneHint === undefined &&
    classifyLane({
      task: input.task,
      classification: ruled,
      preferences: rule.learnedModelPreferences,
    }).source === "rules";
  const needsClass =
    rule.taskRouting.mode === "auto" &&
    input.task.hint === undefined &&
    ruled.confidence === "uncertain";
  const decided: RoutingDecision | null =
    (needsLane || needsClass) && jevConfigFromSettings(preferences.decisionModel) !== null
      ? yield* askDecisionModel(routingDecisionRequest(input.task), {
          timeoutMs: ROUTING_DECISION_TIMEOUT_MS,
          settings,
          ...(input.decisionFetch === undefined ? {} : { send: input.decisionFetch }),
        }).pipe(
          Effect.map(readRoutingDecision),
          Effect.tapError((error) =>
            Effect.logWarning("project.task-routing.decision-model-failed", {
              projectId: input.project.id,
              reason: error.message,
            }),
          ),
          Effect.orElseSucceed(() => null),
        )
      : null;
  const decidedClass = needsClass ? (decided?.taskClass ?? null) : null;
  const classification =
    decidedClass === null
      ? ruled
      : {
          ...ruled,
          taskClass: decidedClass.value,
          confidence: "high" as const,
          signals: [
            `decision model: ${decidedClass.value} ${formatProbability(decidedClass.probability)}`,
            ...ruled.signals,
          ].slice(0, 12),
        };
  const laneDecision =
    needsLane && decided?.lane != null
      ? { lane: decided.lane.value, probability: decided.lane.probability }
      : null;
  const lane = lanesSet
    ? resolveLaneRouting({
        lanes: rule.modelLanes,
        preferences: rule.learnedModelPreferences,
        task: input.task,
        classification,
        laneHint: input.laneHint,
        laneDecision,
        baseline: input.baseline,
        providers: input.providers,
        nowMs,
        policy: rule.taskRouting,
        switchAtPercent: rule.providerLimitSwitchAtPercent,
        limitedInstanceIds: limited,
        ...(input.runnableInstanceIds === undefined
          ? {}
          : { runnableInstanceIds: input.runnableInstanceIds }),
      })
    : null;
  if (lane !== null) {
    if (!lane.found && lane.baselineUnavailable !== null)
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `No permitted ${lane.decision.lane} model can run now. Baseline ${input.baseline.model}: ${lane.baselineUnavailable}. Update the model lane or learned preference before retrying.`,
      });
    yield* logDecision(input.project, lane.decision);
    return lane.decision;
  }
  if (rule.taskRouting.mode !== "auto") return null;
  const tiered = resolveTaskRouting({
    policy: rule.taskRouting,
    classification,
    baseline: input.baseline,
    providers: input.providers,
    nowMs,
    switchAtPercent: rule.providerLimitSwitchAtPercent,
    limitedInstanceIds: limited,
    preferredProviders: rule.defaultModelProviders,
    ...(input.runnableInstanceIds === undefined
      ? {}
      : { runnableInstanceIds: input.runnableInstanceIds }),
  });
  yield* logDecision(input.project, tiered);
  return tiered;
});

const logDecision = (project: Project, decision: TaskRoutingDecision) =>
  Effect.logInfo("project.task-routing.decided", {
    projectId: project.id,
    lane: decision.lane ?? null,
    taskClass: decision.taskClass,
    confidence: decision.confidence,
    moved: decision.moved,
    selected: `${decision.selection.instanceId}/${decision.selection.model}`,
    baseline: `${decision.baseline.instanceId}/${decision.baseline.model}`,
    skipped: decision.skipped ?? [],
    reason: decision.reason,
  });

/**
 * The target a routed worker is resolved with: the routed model, the effort
 * the caller named or the baseline ran at (mapped to the new model by
 * target resolution) and any options the caller named, never the baseline's
 * own options, which belong to another model. An unmoved decision keeps the
 * original target.
 */
export function routedTarget(
  decision: TaskRoutingDecision,
  original: OrchestratorMcpTarget | undefined,
): OrchestratorMcpTarget | undefined {
  if (!decision.moved) return original;
  const effort = original?.effort ?? modelSelectionEffortValue(decision.baseline) ?? undefined;
  return {
    providerInstanceId: decision.selection.instanceId,
    model: decision.selection.model,
    ...(effort === undefined ? {} : { effort }),
    // Options the caller named go with the task; one the routed model cannot take
    // fails resolution, and the worker keeps its baseline.
    ...(original?.options === undefined ? {} : { options: original.options }),
  };
}

/** The worker's own default options (Thinking) on a model Auto moved it to. */
export function routedSelection(
  decision: TaskRoutingDecision,
  resolved: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  return decision.moved ? withDefaultModelOptions(resolved, providers, "worker") : resolved;
}

/** The task prompt with the routing plan appended when its input needs steps outside the model. */
export function promptWithRoutingNote(
  prompt: string,
  decision: TaskRoutingDecision | null,
): string {
  const note = decision === null ? null : routingPromptNote(decision);
  return note === null ? prompt : `${prompt}\n\n${note}`;
}
