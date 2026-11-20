/**
 * A project's saved model with its options carried onto another model.
 *
 * Picking another model in a project's pickers used to start it with no
 * options, so the effort, Ultracode, context window and Fast mode the person
 * had saved were dropped without a word. The options the new model offers are
 * kept, and the ones it does not are named.
 *
 * @module projectModelCarry
 */
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@specweave-studio/contracts";
import { createModelSelection, resolveSelectableModel } from "@specweave-studio/shared/model";
import {
  carryModelOptions,
  describeCarriedOptions,
  heldModelOptions,
} from "@specweave-studio/shared/modelOptionCarry";

import { getProviderModelCapabilities } from "../../providerModels";

/** The part of a provider instance entry the carry reads. */
export interface ModelCarryEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * Options a model along the way could not run, remembered by the picker so
 * going back (Fable with Ultracode → a model without it → Fable) restores them.
 */
export interface HeldProjectModelOptions {
  /** The selection the picker produced; the options apply only while it is still the saved one. */
  readonly after: ModelSelection;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
}

export interface CarriedProjectModel {
  readonly selection: ModelSelection;
  /** One sentence naming what the new model could not keep, or null when nothing was lost. */
  readonly note: string | null;
  /** What the picker keeps for the next change. */
  readonly held: HeldProjectModelOptions;
}

/** The same provider, model and option values, in any order. */
function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  const a = left.options ?? [];
  const b = right.options ?? [];
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    a.length === b.length &&
    a.every((option) => b.some((other) => other.id === option.id && other.value === option.value))
  );
}

/**
 * The option descriptors of a listed model, or undefined for a custom or not
 * yet listed one: its options are unknown, not missing.
 */
function descriptorsFor(
  entries: ReadonlyArray<ModelCarryEntry>,
  instanceId: ProviderInstanceId,
  model: string,
  planModeEnabled: boolean,
) {
  const entry = entries.find((candidate) => candidate.instanceId === instanceId);
  if (!entry) return undefined;
  const slug = resolveSelectableModel(entry.driverKind, model, entry.models);
  if (!entry.models.some((candidate) => candidate.slug === slug)) return undefined;
  return getProviderModelCapabilities(entry.models, model, entry.driverKind, planModeEnabled)
    .optionDescriptors;
}

/**
 * "GPT-6.2-Astra on GitHub Copilot": the same model can be listed by several
 * providers with different options, so a note about missing options names
 * the provider unless the model's name already starts with it.
 */
function modelName(
  entries: ReadonlyArray<ModelCarryEntry>,
  instanceId: ProviderInstanceId,
  model: string,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === instanceId);
  const slug = entry ? resolveSelectableModel(entry.driverKind, model, entry.models) : null;
  const name = entry?.models.find((candidate) => candidate.slug === slug)?.name || model;
  const provider = entry?.displayName.trim();
  return provider && !name.toLowerCase().startsWith(provider.split(" ")[0]!.toLowerCase())
    ? `${name} on ${provider}`
    : name;
}

/**
 * The selection a project picker saves when the person picks another model:
 * that model with every option of the saved choice it can run.
 */
export function carriedProjectModelSelection(input: {
  /** The project's saved choice, or what it follows while it has none. */
  readonly previous: ModelSelection | null | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly entries: ReadonlyArray<ModelCarryEntry>;
  readonly planModeEnabled?: boolean;
  /** What the last change through this picker returned as `held`, if any. */
  readonly held?: HeldProjectModelOptions | null;
}): CarriedProjectModel {
  const { previous, instanceId, model, entries } = input;
  const planModeEnabled = input.planModeEnabled ?? true;
  const previousDescriptors = previous
    ? descriptorsFor(entries, previous.instanceId, previous.model, planModeEnabled)
    : undefined;
  const current = previous?.options ?? [];
  // Held options belong to the choice this picker made; a choice saved elsewhere starts clean.
  const held =
    previous && input.held && sameSelection(input.held.after, previous)
      ? heldModelOptions(input.held.options, current, previousDescriptors)
      : [];
  const options = [...current, ...held];
  if (options.length === 0) {
    const selection = createModelSelection(instanceId, model);
    return { selection, note: null, held: { after: selection, options } };
  }
  const carried = carryModelOptions({
    previous: options,
    previousDescriptors,
    nextDescriptors: descriptorsFor(entries, instanceId, model, planModeEnabled),
  });
  const selection = createModelSelection(instanceId, model, carried.options);
  return {
    selection,
    note: describeCarriedOptions(carried, modelName(entries, instanceId, model)),
    held: { after: selection, options },
  };
}
