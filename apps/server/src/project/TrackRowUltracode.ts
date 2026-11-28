import type { ModelSelection, Project, TaskClass } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { withProjectTrackRowUltracode } from "./ProjectDelegation.ts";

/**
 * A model a launch named, with the Ultracode of the Tracks row it matches
 * (`withProjectTrackRowUltracode`), for `studio_thread_launch` and a launch on
 * another machine. A review launch takes only its model and effort, as an
 * unnamed one does (1441). Never fails: without settings or providers, or on
 * any read error, the selection is kept as named.
 */
export const namedLaunchOnTrackRow = Effect.fn("project.namedLaunchOnTrackRow")(function* (input: {
  readonly project: Pick<Project, "id" | "defaultModelSelection"> | undefined;
  readonly selection: ModelSelection | undefined;
  readonly taskClass?: TaskClass | undefined;
}) {
  const { project, selection } = input;
  if (project === undefined || selection === undefined || input.taskClass === "review")
    return selection;
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  if (Option.isNone(settingsService) || Option.isNone(registry)) return selection;
  return yield* Effect.all([settingsService.value.getSettings, registry.value.getProviders]).pipe(
    Effect.map(([settings, providers]) =>
      withProjectTrackRowUltracode(settings, project, selection, providers),
    ),
    Effect.orElseSucceed(() => selection),
  );
});
