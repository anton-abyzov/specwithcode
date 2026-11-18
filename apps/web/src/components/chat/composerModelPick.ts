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
