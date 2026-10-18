import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type Project,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { resolveWorkerLaunchSelection } from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { simulatedUsageLimitInstances } from "../orchestration-v2/ProviderFailure.ts";
import { ProviderFallbackEnv } from "../orchestration-v2/ProviderFallbackWorker.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectCompatibleProviders } from "./ProjectProviderCompatibility.ts";

/**
 * Where a coordinator's new worker starts when the coordinator names no
 * model: the preferred worker model while its provider has room, else the
 * coordinator's own model, else another provider with room (see
 * resolveWorkerLaunchSelection). Without server settings the project rule
 * falls back to the built-in defaults. Each move is logged, since the worker
 * then runs somewhere other than the project's worker model.
 */
export const workerLaunchWithRoom = Effect.fn("project.workerLaunchWithRoom")(function* (input: {
  readonly project: Project;
  readonly preferred: ModelSelection;
  readonly coordinator: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The modes the worker runs with: agents behind an ACP bridge need full access for project folders. */
  readonly runtimePolicy: { readonly runtimeMode: string; readonly interactionMode: string };
}) {
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const preferences = Option.isSome(settings)
    ? yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS))
    : DEFAULT_SERVER_SETTINGS;
  const rule = resolveProjectSettings(preferences, input.project.id, input.project).settings;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const limited = new Set<string>(simulatedUsageLimitInstances(yield* ProviderFallbackEnv));
  const providers = projectCompatibleProviders({
    project: input.project,
    providers: input.providers,
    cwd: input.project.workspaceRoot,
    runtimePolicy: input.runtimePolicy,
  });
  const decision = resolveWorkerLaunchSelection({
    preferred: input.preferred,
    coordinator: input.coordinator,
    providers,
    rule,
    nowMs,
    limitedInstanceIds: limited,
  });
  if (decision.selection !== input.preferred)
    yield* Effect.logInfo("project.worker-launch.moved", {
      projectId: input.project.id,
      reason: decision.reason,
      preferred: input.preferred.instanceId,
      selected: decision.selection.instanceId,
      model: decision.selection.model,
    });
  return decision.selection;
});
