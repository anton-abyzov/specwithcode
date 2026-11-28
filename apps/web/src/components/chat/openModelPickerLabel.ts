/**
 * How the model picker names an open-model route (increment 1513): "Your key"
 * or "Local" in place of a plan, with the preset's list-price note for its
 * tooltip. Only instances carrying the preset marker qualify, so an instance
 * built by hand with a base URL, or a Pi or OpenCode route, shows as before.
 */
import type { ServerProvider } from "@specweave-studio/contracts";
import {
  openModelPresetById,
  openModelPriceNote,
  openModelRouteLabel,
} from "@specweave-studio/shared/openModelPresets";

export interface OpenModelPickerLabel {
  readonly label: "Your key" | "Local";
  readonly note: string;
}

/** The pill label and price note for an open-model route; null for any other provider. */
export function openModelPickerLabel(
  provider: Pick<ServerProvider, "openModelPreset"> | null | undefined,
): OpenModelPickerLabel | null {
  const preset = openModelPresetById(provider?.openModelPreset);
  return preset ? { label: openModelRouteLabel(preset), note: openModelPriceNote(preset) } : null;
}
