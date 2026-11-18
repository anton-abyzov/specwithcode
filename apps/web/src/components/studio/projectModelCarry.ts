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
  ServerProviderModel,
} from "@specweave-studio/contracts";
import { createModelSelection, resolveSelectableModel } from "@specweave-studio/shared/model";
import {
  carryModelOptions,
  describeCarriedOptions,
} from "@specweave-studio/shared/modelOptionCarry";

import { getProviderModelCapabilities } from "../../providerModels";

/** The part of a provider instance entry the carry reads. */
export interface ModelCarryEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

export interface CarriedProjectModel {
  readonly selection: ModelSelection;
  /** One sentence naming what the new model could not keep, or null when nothing was lost. */
  readonly note: string | null;
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

function modelName(
  entries: ReadonlyArray<ModelCarryEntry>,
  instanceId: ProviderInstanceId,
  model: string,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === instanceId);
  const slug = entry ? resolveSelectableModel(entry.driverKind, model, entry.models) : null;
  return entry?.models.find((candidate) => candidate.slug === slug)?.name || model;
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
}): CarriedProjectModel {
  const { previous, instanceId, model, entries } = input;
  const planModeEnabled = input.planModeEnabled ?? true;
  if (!previous || (previous.options ?? []).length === 0)
    return { selection: createModelSelection(instanceId, model), note: null };
  const carried = carryModelOptions({
    previous: previous.options,
    previousDescriptors: descriptorsFor(
      entries,
      previous.instanceId,
      previous.model,
      planModeEnabled,
    ),
    nextDescriptors: descriptorsFor(entries, instanceId, model, planModeEnabled),
  });
  return {
    selection: createModelSelection(instanceId, model, carried.options),
    note: describeCarriedOptions(carried, modelName(entries, instanceId, model)),
  };
}
