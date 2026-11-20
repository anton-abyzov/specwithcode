/**
 * The model this project's settings pick for a thread on another machine
 * whose caller names none.
 *
 * It is picked here, on the machine that asks, by the rules a thread started
 * here follows: the project's own model first, else the project's tracks or
 * lanes with the caller's `taskLane` and `taskClass`, else what the caller
 * would inherit. The other machine then maps it to its own sign-ins.
 *
 * The pick is the app's choice, not the caller's, so RemoteWorkers never
 * starts it there on a sign-in that machine's grant excludes or holds back
 * (billed per use, or billing unknown; see `translateModel`). The model the
 * caller itself runs on is sent beside it and is tried next, exactly as
 * before this pick existed, so a launch that ran then still runs.
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
import { isHeldSource } from "@specweave-studio/shared/modelTracks";
import {
  modelSelectionEffortValue,
  resolveEffort,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  projectUsesTracks,
  projectWorkerModel,
  workerModelUnderGrant,
} from "../../../project/ProjectDelegation.ts";
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

export const remotePickedModel = Effect.fn("mcp.remotePickedModel")(function* (input: {
  /** The project here the launch is for; undefined for a scratch launch. */
  readonly project: Project | undefined;
  readonly callerModel: ModelSelection | undefined;
  readonly isCoordinator: boolean;
  readonly title: string;
  readonly message: string | undefined;
  readonly taskClass: TaskClass | undefined;
  readonly taskLane: ModelLane | undefined;
  /** The accounts the caller's work grant allows here; undefined without a grant. */
  readonly grantAccounts?: Parameters<typeof workerModelUnderGrant>[2];
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
  // Under a grant that excludes its sign-in, a non-coordinator keeps its own model.
  const projectModel = workerModelUnderGrant(
    projectWorkerModel(settings, project),
    input.isCoordinator,
    input.grantAccounts,
  );
  const tracks = projectUsesTracks(settings, project);
  const baseline =
    projectModel ??
    inherited ??
    (input.isCoordinator ? (defaultWorkerModelSelection(providers) ?? undefined) : undefined);
  if (baseline === undefined) return undefined;
  if (
    // As here: work under a grant that lists accounts is never routed.
    (input.grantAccounts !== undefined && input.grantAccounts.kind !== "all") ||
    !autoRoutingApplies({
      // A project's own model is not moved by lanes or Auto.
      pinned: projectModel !== null,
      tracks,
      isCoordinator: input.isCoordinator,
      taskClass: input.taskClass,
      taskLane: input.taskLane,
    })
  )
    return baseline;
  // Routing judges this machine's sign-ins. One with no room here says nothing
  // about the other machine, so a refusal keeps the baseline and never stops the
  // launch. The one exception: on tracks, a baseline held back here is never the
  // app's pick, so only the caller's own model is sent.
  const baselineProvider = providers.find(
    (provider) => provider.instanceId === baseline.instanceId,
  );
  const refused =
    tracks && baselineProvider !== undefined && isHeldSource(baselineProvider, baseline.model)
      ? undefined
      : baseline;
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
      Effect.logWarning("Remote launch is not routed: routing refused here", {
        projectId: project.id,
        reason: error.message,
      }),
    ),
    Effect.orElseSucceed(() => "refused" as const),
  );
  if (decision === "refused") return refused;
  if (decision?.moved !== true) return baseline;
  return withCarriedEffort(
    routedSelection(decision, decision.selection, providers),
    baseline,
    providers,
  );
});
