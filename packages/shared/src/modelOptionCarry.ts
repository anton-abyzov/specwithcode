import type {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@specweave-studio/contracts";

import { findEffortDescriptor, resolveEffort } from "./effortLevel.ts";
import { upgradeLegacyUltracodeEffort } from "./model.ts";

/**
 * Model options across a provider or model change. Providers name the same
 * idea differently (Claude `effort`, Codex `reasoningEffort`, Claude `fastMode`,
 * Codex's Fast service tier), and some have no equivalent at all (GitHub
 * Copilot has no Ultracode), so a change keeps what the new model can run and
 * names the rest instead of dropping it silently.
 */

type Descriptors = ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
type Selections = ReadonlyArray<ProviderOptionSelection> | null | undefined;

const FAST_TIER_LABELS = new Set(["fast", "ultrafast"]);

function fastTierChoice(descriptors: Descriptors, ultrafast = false) {
  const tier = descriptors?.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.id === "serviceTier" && descriptor.type === "select",
  );
  const wanted = ultrafast ? "ultrafast" : "fast";
  const choice =
    tier?.options.find((option) => option.label.toLowerCase() === wanted) ??
    tier?.options.find((option) => FAST_TIER_LABELS.has(option.label.toLowerCase()));
  return tier && choice ? { optionId: tier.id, value: choice.id } : undefined;
}

function hasBoolean(descriptors: Descriptors, id: string): boolean {
  return (
    descriptors?.some((descriptor) => descriptor.id === id && descriptor.type === "boolean") ===
    true
  );
}

function hasUltracode(descriptors: Descriptors): boolean {
  return (
    hasBoolean(descriptors, "ultracode") ||
    findEffortDescriptor(descriptors)?.options.some((option) => option.id === "ultracode") === true
  );
}

function hasFast(descriptors: Descriptors): boolean {
  return hasBoolean(descriptors, "fastMode") || fastTierChoice(descriptors) !== undefined;
}

/** Which of Effort, Fast mode and Ultracode a model does not offer, in that order. */
export function missingCommonOptions(descriptors: Descriptors): ReadonlyArray<string> {
  return [
    findEffortDescriptor(descriptors) ? null : "Effort",
    hasFast(descriptors) ? null : "Fast mode",
    hasUltracode(descriptors) ? null : "Ultracode",
  ].filter((label): label is string => label !== null);
}

export interface CarriedModelOptions {
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  /** Options the new model has no equivalent for, by label. */
  readonly dropped: ReadonlyArray<string>;
  /** Options kept at a different value, e.g. "Effort Max → High". */
  readonly adjusted: ReadonlyArray<string>;
}

function choiceLabel(descriptors: Descriptors, optionId: string, value: string): string {
  const descriptor = descriptors?.find((candidate) => candidate.id === optionId);
  return descriptor?.type === "select"
    ? (descriptor.options.find((option) => option.id === value)?.label ?? value)
    : value;
}

/** The previous model's options moved onto the next model's descriptors. */
export function carryModelOptions(input: {
  readonly previous: Selections;
  readonly previousDescriptors: Descriptors;
  readonly nextDescriptors: Descriptors;
}): CarriedModelOptions {
  const previous =
    (input.previousDescriptors
      ? upgradeLegacyUltracodeEffort(input.previousDescriptors, input.previous)
      : input.previous) ?? [];
  const next = input.nextDescriptors ?? [];
  const options: Array<ProviderOptionSelection> = [];
  const dropped: Array<string> = [];
  const adjusted: Array<string> = [];
  const handled = new Set<string>();

  const previousEffort = findEffortDescriptor(input.previousDescriptors);
  const effortSelection = previous.find((selection) =>
    previousEffort ? selection.id === previousEffort.id : false,
  );
  if (previousEffort && effortSelection) handled.add(effortSelection.id);
  if (typeof effortSelection?.value === "string") {
    let resolved = resolveEffort(effortSelection.value, next);
    // An Ultracode effort level on a model without Ultracode keeps its Extra High.
    if (!resolved.ok && effortSelection.value === "ultracode") {
      resolved = resolveEffort("xhigh", next);
      dropped.push("Ultracode");
    }
    if (resolved.ok) {
      options.push({ id: resolved.optionId, value: resolved.value });
      if (resolved.ultracode) {
        options.push({ id: "ultracode", value: true });
        handled.add("ultracode");
      } else if (!resolved.exact && effortSelection.value !== "ultracode")
        adjusted.push(
          `Effort ${choiceLabel(input.previousDescriptors, effortSelection.id, effortSelection.value)} → ${resolved.label}`,
        );
    } else {
      dropped.push("Effort");
    }
  }

  const ultracode = previous.find((selection) => selection.id === "ultracode");
  if (ultracode && !handled.has("ultracode")) {
    handled.add("ultracode");
    if (ultracode.value === true) {
      if (hasBoolean(next, "ultracode")) options.push({ id: "ultracode", value: true });
      else dropped.push("Ultracode");
    } else if (hasBoolean(next, "ultracode")) {
      options.push(ultracode);
    }
  }

  const fastMode = previous.find((selection) => selection.id === "fastMode");
  const tier = previous.find((selection) => selection.id === "serviceTier");
  const tierLabel =
    typeof tier?.value === "string"
      ? choiceLabel(input.previousDescriptors, "serviceTier", tier.value).toLowerCase()
      : null;
  if (fastMode) handled.add("fastMode");
  if (tier && tierLabel !== null && FAST_TIER_LABELS.has(tierLabel)) handled.add("serviceTier");
  const wantsFast = fastMode?.value === true || handled.has("serviceTier");
  if (wantsFast) {
    const nextTier = fastTierChoice(next, tierLabel === "ultrafast");
    if (hasBoolean(next, "fastMode")) options.push({ id: "fastMode", value: true });
    else if (nextTier) options.push({ id: nextTier.optionId, value: nextTier.value });
    else dropped.push("Fast mode");
  } else if (fastMode && hasBoolean(next, "fastMode")) {
    options.push(fastMode);
  }

  for (const selection of previous) {
    if (handled.has(selection.id) || options.some((option) => option.id === selection.id)) continue;
    const descriptor = next.find((candidate) => candidate.id === selection.id);
    const fits =
      descriptor?.type === "boolean"
        ? typeof selection.value === "boolean"
        : descriptor?.type === "select" &&
          descriptor.options.some((option) => option.id === selection.value);
    if (fits) {
      options.push(selection);
      continue;
    }
    // A switched-off toggle or a default choice loses nothing.
    const before = input.previousDescriptors?.find((candidate) => candidate.id === selection.id);
    const isDefault =
      selection.value === false ||
      (before?.type === "select" &&
        before.options.some((option) => option.id === selection.value && option.isDefault));
    if (!isDefault) dropped.push(before?.label ?? selection.id);
  }

  return { options, dropped, adjusted };
}

/** One sentence for a toast, or null when nothing changed. */
export function describeCarriedOptions(
  carried: Pick<CarriedModelOptions, "dropped" | "adjusted">,
  modelLabel: string,
): string | null {
  const parts = [
    carried.dropped.length > 0
      ? `${modelLabel} has no ${joinLabels(carried.dropped)}, so ${
          carried.dropped.length > 1 ? "they were" : "it was"
        } left off.`
      : null,
    carried.adjusted.length > 0 ? `${carried.adjusted.join(", ")}.` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function joinLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}
