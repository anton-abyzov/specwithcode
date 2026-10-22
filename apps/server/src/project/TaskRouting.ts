import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestratorMcpTarget,
  type Project,
  type ServerProvider,
  type TaskClass,
  type TaskRoutingDecision,
} from "@specweave-studio/contracts";
import { withDefaultModelOptions } from "@specweave-studio/shared/coordinatorDefault";
import { modelSelectionEffortValue } from "@specweave-studio/shared/effortLevel";
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
}): boolean {
  return !input.pinned && (input.isCoordinator || input.taskClass !== undefined);
}

/**
 * The Auto routing decision for one worker, or null when Auto is off for the
 * project. `baseline` is the model the app would use without Auto. Reads the
 * project's resolved policy, the switch threshold and provider order; makes
 * no model call. The decision is logged whether or not it moved the worker.
 */
export const routeWorkerTask = Effect.fn("project.routeWorkerTask")(function* (input: {
  readonly project: Project;
  readonly baseline: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly task: TaskClassificationInput;
  readonly runnableInstanceIds?: ReadonlySet<string>;
  /** The settings service a long-lived caller captured; else the current context's. */
  readonly settings?: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
}) {
  const settings =
    input.settings !== undefined && Option.isSome(input.settings)
      ? input.settings
      : yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const preferences = Option.isSome(settings)
    ? yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS))
    : DEFAULT_SERVER_SETTINGS;
  const rule = resolveProjectSettings(preferences, input.project.id, input.project).settings;
  if (rule.taskRouting.mode !== "auto") return null;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const limited = new Set<string>(simulatedUsageLimitInstances(yield* ProviderFallbackEnv));
  // A provider that reports no usage but stopped a thread on its limit
  // (Copilot's monthly quota) reads as ready: no new worker starts there.
  for (const instanceId of yield* usageLimitHeldInstances(nowMs)) limited.add(instanceId);
  const decision = resolveTaskRouting({
    policy: rule.taskRouting,
    classification: classifyTask(input.task),
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
  yield* Effect.logInfo("project.task-routing.decided", {
    projectId: input.project.id,
    taskClass: decision.taskClass,
    confidence: decision.confidence,
    moved: decision.moved,
    selected: `${decision.selection.instanceId}/${decision.selection.model}`,
    baseline: `${decision.baseline.instanceId}/${decision.baseline.model}`,
    reason: decision.reason,
  });
  return decision;
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
