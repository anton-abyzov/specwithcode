/**
 * The model a thread on another machine starts on when its caller names none.
 *
 * It is picked here, on the machine that asks, by the rules a thread started
 * here follows: the project's own model first, else the project's tracks or
 * lanes with the caller's `taskLane` and `taskClass`, else what the caller
 * would inherit. The other machine then maps it to its own sign-ins, and uses
 * its default when it has no such model.
 *
 * Two things a launch here does are left out on purpose, because they read
 * this machine's sign-ins and say nothing about the other machine's: a quota
 * boost, and moving off a provider that has no room left.
 */
import type {
  ModelLane,
  ModelSelection,
  Project,
  ServerProvider,
  TaskClass,
} from "@specweave-studio/contracts";
import { defaultWorkerModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import {
  modelSelectionEffortValue,
  resolveEffort,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { projectUsesTracks, projectWorkerModel } from "../../../project/ProjectDelegation.ts";
import {
  autoRoutingApplies,
  routedSelection,
  routeWorkerTask,
} from "../../../project/TaskRouting.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";

/** The routed model at the effort its track entry saved, else the one the baseline ran at. */
function withCarriedEffort(
  routed: ModelSelection,
  baseline: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  if (modelSelectionEffortValue(routed) !== undefined) return routed;
  const effort = modelSelectionEffortValue(baseline);
  if (effort === undefined) return routed;
  const descriptors = providers
    .find((provider) => provider.instanceId === routed.instanceId)
    ?.models.find((model) => model.slug === routed.model)?.capabilities?.optionDescriptors;
  const resolved = resolveEffort(effort, descriptors);
  return resolved.ok
    ? { ...routed, options: withEffortSelection(routed.options, resolved) }
    : routed;
}

export const remoteInheritedModel = Effect.fn("mcp.remoteInheritedModel")(function* (input: {
  /** The project here the launch is for; undefined for a scratch launch. */
  readonly project: Project | undefined;
  readonly callerModel: ModelSelection | undefined;
  readonly isCoordinator: boolean;
  readonly title: string;
  readonly message: string | undefined;
  readonly taskClass: TaskClass | undefined;
  readonly taskLane: ModelLane | undefined;
}) {
  const { project } = input;
  // What a remote launch inherited before it followed the project's models.
  const inherited =
    (input.isCoordinator
      ? project?.defaultModelSelection
      : (input.callerModel ?? project?.defaultModelSelection)) ?? undefined;
  if (project === undefined) return inherited;
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  if (Option.isNone(settingsService) || Option.isNone(registry)) return inherited;
  const settings = yield* settingsService.value.getSettings.pipe(Effect.orElseSucceed(() => null));
  if (settings === null) return inherited;
  const providers = yield* registry.value.getProviders;
  const projectModel = projectWorkerModel(settings, project);
  const baseline =
    projectModel ??
    inherited ??
    (input.isCoordinator ? (defaultWorkerModelSelection(providers) ?? undefined) : undefined);
  if (baseline === undefined) return undefined;
  if (
    !autoRoutingApplies({
      // A project's own model is not moved by lanes or Auto.
      pinned: projectModel !== null,
      tracks: projectUsesTracks(settings, project),
      isCoordinator: input.isCoordinator,
      taskClass: input.taskClass,
      taskLane: input.taskLane,
    })
  )
    return baseline;
  // Routing judges this machine's sign-ins. One with no room here says nothing
  // about the other machine, so a refusal keeps the baseline and never stops the launch.
  const decision = yield* routeWorkerTask({
    project,
    baseline,
    providers,
    task: {
      text: input.message ?? "",
      title: input.title,
      hint: input.taskClass,
      attachments: [],
    },
    laneHint: input.taskLane,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Remote launch keeps its baseline model: routing refused here", {
        projectId: project.id,
        reason: error.message,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (decision?.moved !== true) return baseline;
  return withCarriedEffort(
    routedSelection(decision, decision.selection, providers),
    baseline,
    providers,
  );
});
