import type {
  ModelLane,
  ModelSelection,
  OrchestrationV2ThreadLaunchInput,
  Project,
  ProjectId,
  ServerProvider,
  TaskRoutingDecision,
} from "@specweave-studio/contracts";
import { isHeldSource, withoutTrackUltracode } from "@specweave-studio/shared/modelTracks";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { routedSelection, routeWorkerTask } from "./TaskRouting.ts";

/** The part of a launch request the tracks read. */
export type UnnamedLaunchInput = Pick<
  OrchestrationV2ThreadLaunchInput,
  "commandId" | "modelUnnamed" | "projectId" | "modelSelection" | "title" | "initialMessage"
>;

export interface UnnamedLaunchModel {
  readonly modelSelection: ModelSelection;
  /** The decision that chose it, kept on the thread; null when nothing routed. */
  readonly routing: TaskRoutingDecision | null;
  /**
   * Why the thread must not start: nothing on the tracks can run and the model
   * it would keep is billed per use, which nobody chose for it. Null otherwise.
   */
  readonly refused: string | null;
}

/**
 * The model a thread starts on when nobody picked one for it: in a project on
 * Tracks, the first entry of the Daily or Complex track that can run now,
 * judged from the first message. Any other project, and a track with nothing
 * that can run, keeps `modelSelection`, unless that model is billed per use
 * (`refused`). Never fails: a launch is not lost to a routing problem.
 */
export const routeUnnamedLaunch = Effect.fn("project.routeUnnamedLaunch")(function* (input: {
  /** The stored project, as the project store returns it. */
  readonly project: { readonly projectId: ProjectId } | undefined;
  readonly modelSelection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly title: string;
  readonly text: string;
  readonly settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
  /** The caller's judgement of the work; without it the first message decides. */
  readonly laneHint?: ModelLane | undefined;
  readonly runnableInstanceIds?: ReadonlySet<string> | undefined;
  /**
   * False for a launch a track row's Ultracode does not apply to (a routine's
   * own thread, which runs unattended and repeatedly). The model and effort
   * still come from the track.
   */
  readonly rowUltracode?: boolean | undefined;
  /**
   * True for a composer draft nobody picked a model or options for: what it
   * carries is the first Daily row's, so its Ultracode is that row's and not
   * a choice. The row the task is routed to decides instead.
   */
  readonly seededFromTrack?: boolean | undefined;
}) {
  const kept: UnnamedLaunchModel = {
    modelSelection: input.modelSelection,
    routing: null,
    refused: null,
  };
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
  const baseline =
    input.seededFromTrack === true
      ? withoutTrackUltracode(input.modelSelection)
      : input.modelSelection;
  const decision = yield* routeWorkerTask({
    project,
    baseline,
    providers: input.providers,
    task: { text: input.text, title: input.title },
    settings: input.settings,
    laneHint: input.laneHint,
    ...(input.runnableInstanceIds === undefined
      ? {}
      : { runnableInstanceIds: input.runnableInstanceIds }),
  }).pipe(
    Effect.map((routed) => ({ routed, failure: null as string | null })),
    Effect.catch((cause) =>
      Effect.logWarning("project.tracks-launch.kept-model", {
        projectId: project.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      }).pipe(
        Effect.as({
          routed: null,
          failure: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    ),
  );
  // Routing refused and the model the launch would keep is billed per use:
  // starting on it would be a spend nobody chose.
  const shown = input.providers.find(
    (provider) => provider.instanceId === input.modelSelection.instanceId,
  );
  if (
    decision.failure !== null &&
    shown !== undefined &&
    isHeldSource(shown, input.modelSelection.model)
  )
    return { ...kept, refused: decision.failure };
  const routed = decision.routed;
  if (routed === null) return kept;
  // An unmoved decision is the launch's own model with the row's Ultracode
  // where the launch set none (`resolveLaneRouting`).
  const modelSelection =
    input.rowUltracode === false
      ? routed.moved
        ? routedSelection(routed, withoutTrackUltracode(routed.selection), input.providers)
        : // Its own model, as it was: an Ultracode the routine saved itself stays.
          input.modelSelection
      : routed.moved
        ? routedSelection(routed, routed.selection, input.providers)
        : routed.selection;
  return {
    modelSelection,
    routing:
      input.rowUltracode === false
        ? { ...routed, selection: withoutTrackUltracode(routed.selection) }
        : routed,
    refused: null,
  } satisfies UnnamedLaunchModel;
});
