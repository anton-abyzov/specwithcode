import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  buildOpenModelEnvironment,
  type OpenModelPreset,
  openModelPresetModelIds,
} from "@specweave-studio/shared/openModelPresets";

import { deriveAvailableInstanceId } from "./AddProviderInstanceDialog.logic";

/**
 * Whether a preset needs the person to name a model: a keyed vendor with no
 * fixed ids in its guide (OpenRouter serves hundreds). Local runtimes list
 * their own models, so naming one there is optional.
 */
export function openModelPresetNeedsModel(preset: OpenModelPreset): boolean {
  return preset.kind === "key" && preset.models === undefined;
}

/** Whether the dialog has what the preset needs: a key, and a model id where required. */
export function canCreateOpenModelInstance(input: {
  readonly preset: OpenModelPreset;
  readonly key: string;
  readonly model: string;
}): boolean {
  if (input.preset.kind === "key" && input.key.trim().length === 0) return false;
  return !openModelPresetNeedsModel(input.preset) || input.model.trim().length > 0;
}

/**
 * The provider instance for one open-model preset: Claude Code on its default
 * home, pointed at the vendor's Anthropic-compatible endpoint or a local
 * runtime. The environment carries the preset marker row, and the key as a
 * sensitive row the server moves into its secret store. Settings keep only a
 * redaction marker for it.
 */
export function openModelInstance(input: {
  readonly preset: OpenModelPreset;
  /** The person's key; ignored for local presets. */
  readonly key?: string;
  /** Another address for a local runtime; ignored for keyed presets. */
  readonly baseUrl?: string;
  readonly model?: string;
  readonly existingIds: ReadonlySet<string>;
}): { readonly instanceId: ProviderInstanceId; readonly instance: ProviderInstanceConfig } {
  const { preset } = input;
  const local = preset.kind === "local";
  const environment = buildOpenModelEnvironment({
    preset,
    ...(local ? {} : { key: input.key ?? "" }),
    ...(local && input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  const customModels = openModelPresetModelIds(preset, input.model);
  const instanceId = deriveAvailableInstanceId(
    (value) => `claudeAgent_${value}`,
    preset.id,
    input.existingIds,
  );
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    instance: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      displayName: preset.label,
      environment,
      ...(customModels.length > 0 ? { config: { customModels: [...customModels] } } : {}),
    },
  };
}
