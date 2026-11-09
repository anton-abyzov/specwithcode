import type {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@specweave-studio/contracts";

import { findEffortDescriptor, isEffortId, resolveEffort } from "./effortLevel.ts";
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
// Codex tier ids, for a previous model whose catalog is no longer listed.
const FAST_TIER_IDS = new Set(["priority", "fast", "ultrafast"]);

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
  /** The next model has not listed its options, so nothing could be carried. */
  readonly unknown?: true;
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
  if (!input.nextDescriptors) {
    return previous.length > 0
      ? { options: [], dropped: [], adjusted: [], unknown: true }
      : { options: [], dropped: [], adjusted: [] };
  }
  const next = input.nextDescriptors;
  const options: Array<ProviderOptionSelection> = [];
  const dropped: Array<string> = [];
  const adjusted: Array<string> = [];
  const handled = new Set<string>();

  const previousEffort = findEffortDescriptor(input.previousDescriptors);
  const effortSelection = previous.find((selection) =>
    previousEffort
      ? selection.id === previousEffort.id
      : typeof selection.value === "string" && isEffortId(selection.id),
  );
  if (effortSelection) handled.add(effortSelection.id);
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
  const tierValue = typeof tier?.value === "string" ? tier.value : null;
  if (tierValue !== null && (FAST_TIER_LABELS.has(tierLabel ?? "") || FAST_TIER_IDS.has(tierValue)))
    handled.add("serviceTier");
  const wantsUltrafast = tierLabel === "ultrafast" || tierValue === "ultrafast";
  const wantsFast = fastMode?.value === true || handled.has("serviceTier");
  if (wantsFast) {
    const nextTier = fastTierChoice(next, wantsUltrafast);
    if (hasBoolean(next, "fastMode")) {
      options.push({ id: "fastMode", value: true });
      if (wantsUltrafast) adjusted.push("Ultrafast → Fast mode");
    } else if (nextTier) {
      options.push({ id: nextTier.optionId, value: nextTier.value });
      if (
        wantsUltrafast &&
        choiceLabel(next, nextTier.optionId, nextTier.value).toLowerCase() !== "ultrafast"
      )
        adjusted.push("Ultrafast → Fast");
    } else dropped.push("Fast mode");
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
    if (!isDefault) dropped.push(before?.label ?? optionIdLabel(selection.id));
  }

  return { options, dropped, adjusted };
}

/** "contextWindow" → "Context window", for an option whose descriptor is gone. */
function optionIdLabel(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One sentence for a toast, or null when nothing changed. */
export function describeCarriedOptions(
  carried: Pick<CarriedModelOptions, "dropped" | "adjusted" | "unknown">,
  modelLabel: string,
): string | null {
  if (carried.unknown)
    return `${modelLabel} has not listed its options yet, so effort and speed start at its defaults.`;
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

/**
 * Options the current model cannot express, kept from earlier models so a
 * round trip (Opus with Fast and Ultracode → Haiku → Opus) brings them back.
 * Anything the current model can express is its own setting and wins.
 */
export function heldModelOptions(
  held: Selections,
  current: Selections,
  currentDescriptors: Descriptors,
): ReadonlyArray<ProviderOptionSelection> {
  const own = new Set((current ?? []).map((selection) => selection.id));
  return (held ?? []).filter((selection) => {
    if (own.has(selection.id)) return false;
    if (selection.id === "ultracode") return !hasUltracode(currentDescriptors);
    if (selection.id === "fastMode" || selection.id === "serviceTier")
      return !hasFast(currentDescriptors);
    if (typeof selection.value === "string" && isEffortId(selection.id))
      return !findEffortDescriptor(currentDescriptors);
    return !currentDescriptors?.some((descriptor) => descriptor.id === selection.id);
  });
}

export function joinLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}
