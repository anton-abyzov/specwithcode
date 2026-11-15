import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchInput,
  Project,
  ProjectId,
  ServerProvider,
  TaskRoutingDecision,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { routedSelection, routeWorkerTask } from "./TaskRouting.ts";

/** The part of a launch request the tracks read. */
export type UnnamedLaunchInput = Pick<
  OrchestrationV2ThreadLaunchInput,
  "modelUnnamed" | "projectId" | "modelSelection" | "title" | "initialMessage"
>;

export interface UnnamedLaunchModel {
  readonly modelSelection: ModelSelection;
  /** The decision that chose it, kept on the thread; null when nothing routed. */
  readonly routing: TaskRoutingDecision | null;
}

/**
 * The model a thread starts on when nobody picked one for it: in a project on
 * Tracks, the first entry of the Daily or Complex track that can run now,
 * judged from the first message. Any other project, and a track with nothing
 * that can run, keeps `modelSelection`. Never fails: a launch is not lost to
 * a routing problem.
 */
export const routeUnnamedLaunch = Effect.fn("project.routeUnnamedLaunch")(function* (input: {
  /** The stored project, as the project store returns it. */
  readonly project: { readonly projectId: ProjectId } | undefined;
  readonly modelSelection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly title: string;
  readonly text: string;
  readonly settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
  readonly runnableInstanceIds?: ReadonlySet<string> | undefined;
}) {
  const kept: UnnamedLaunchModel = { modelSelection: input.modelSelection, routing: null };
  if (input.project === undefined || Option.isNone(input.settings)) return kept;
  // Routing reads the project by `id`; the stored record carries the same fields.
  const project = { ...input.project, id: input.project.projectId } as unknown as Project;
  const preferences = yield* input.settings.value.getSettings.pipe(
    Effect.orElseSucceed(() => null),
  );
  if (
    preferences === null ||
    resolveProjectSettings(preferences, project.id, project).settings.threadModelMode !== "tracks"
  )
    return kept;
  const decision = yield* routeWorkerTask({
    project,
    baseline: input.modelSelection,
    providers: input.providers,
    task: { text: input.text, title: input.title },
    settings: input.settings,
    ...(input.runnableInstanceIds === undefined
      ? {}
      : { runnableInstanceIds: input.runnableInstanceIds }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("project.tracks-launch.kept-model", {
        projectId: project.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  if (decision === null) return kept;
  return {
    modelSelection: decision.moved
      ? routedSelection(decision, decision.selection, input.providers)
      : input.modelSelection,
    routing: decision,
  } satisfies UnnamedLaunchModel;
});
