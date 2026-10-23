import type { ServerProviderModel } from "@specweave-studio/contracts";

/** Whether the selected model reports it cannot read images. Unset allows. */
export function modelRejectsImages(
  model: string,
  models: ReadonlyArray<ServerProviderModel>,
): boolean {
  return models.find((entry) => entry.slug === model)?.imageInput === false;
}

/**
 * Why the selected model cannot take this message's images, or null when it
 * can. Only a model that reports `imageInput: false` blocks; unset allows.
 */
export function imageInputBlockReason(input: {
  readonly model: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly imageCount: number;
}): string | null {
  if (input.imageCount === 0 || !modelRejectsImages(input.model, input.models)) return null;
  const name = input.models.find((model) => model.slug === input.model)?.name ?? input.model;
  return `${name} can't read images. Remove the image or pick another model.`;
}
