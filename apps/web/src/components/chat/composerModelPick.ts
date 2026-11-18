import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProvider,
} from "@specweave-studio/contracts";
import { withTrackEffort } from "@specweave-studio/shared/modelTracks";

/**
 * The selection a model picked in the composer starts with: the options the
 * person last used on that model, else Medium, or the nearest level the model
 * offers. Without this a fresh pick sent no effort and ran at whatever the
 * provider defaults to, such as Max for Muse Wonder Full.
 */
export function composerPickSelection(input: {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly remembered: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection {
  const { instanceId, model, remembered } = input;
  return remembered !== undefined && remembered.length > 0
    ? { instanceId, model, options: [...remembered] }
    : withTrackEffort({ instanceId, model }, input.providers);
}

/**
 * The options a new draft runs on before anyone picks a level: its own, else
 * Medium or the nearest level the model offers. A thread already on the
 * server keeps what it has, so an existing thread with no saved effort still
 * runs at its provider's default.
 */
export function composerDraftStartOptions(input: {
  readonly isDraft: boolean;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!input.isDraft || input.model === "") return input.options;
  const selection: ModelSelection = {
    instanceId: input.instanceId,
    model: input.model,
    ...(input.options === undefined ? {} : { options: [...input.options] }),
  };
  const filled = withTrackEffort(selection, input.providers);
  return filled === selection ? input.options : filled.options;
}
