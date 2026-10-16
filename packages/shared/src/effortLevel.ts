import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@specweave-studio/contracts";

/**
 * Reasoning effort across providers. Each provider names the knob differently
 * (Claude `effort`, Codex and Grok `reasoningEffort`, Copilot ACP
 * `reasoning_effort`, Pi `thinking`, OpenCode `variant`) and offers a different
 * subset of levels, so a requested effort such as "extra high" is matched to
 * the model's own descriptor here, falling back to the nearest level it offers.
 */

const EFFORT_OPTION_IDS = new Set([
  "effort",
  "reasoning",
  "reasoningeffort",
  "thinking",
  "thinkinglevel",
  "thoughtlevel",
  "variant",
]);
const EFFORT_LABEL = /effort|reasoning|thinking|thought/i;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const LADDER: ReadonlyArray<
  readonly [rank: number, label: string, aliases: ReadonlyArray<string>]
> = [
  [0, "Off", ["off", "none", "no", "disabled", "disable", "zero"]],
  [1, "Minimal", ["minimal", "min", "minimum", "lowest", "verylow"]],
  [2, "Low", ["low"]],
  [3, "Medium", ["medium", "med", "mid", "moderate", "normal", "balanced", "standard"]],
  [4, "High", ["high"]],
  [5, "Extra High", ["xhigh", "extrahigh", "xhi", "veryhigh", "superhigh"]],
  [6, "Max", ["max", "maximum", "highest"]],
  [7, "Ultra", ["ultra"]],
];

/** Position on the shared effort ladder, or undefined for a value off it. */
export function effortRank(value: string): number | undefined {
  const key = normalize(value);
  return LADDER.find(([, , aliases]) => aliases.includes(key))?.[0];
}

const choiceRank = (choice: { readonly id: string; readonly label: string }) =>
  effortRank(choice.id) ?? effortRank(choice.label);

function isEffortId(id: string): boolean {
  return EFFORT_OPTION_IDS.has(normalize(id));
}

/** The select descriptor that controls reasoning effort, when the model has one. */
export function findEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | undefined {
  const candidates = (descriptors ?? []).filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" &&
      (isEffortId(descriptor.id) || EFFORT_LABEL.test(descriptor.label)) &&
      descriptor.options.some((choice) => choiceRank(choice) !== undefined),
  );
  return candidates.find((descriptor) => isEffortId(descriptor.id)) ?? candidates[0];
}

export type EffortResolution =
  | {
      readonly ok: true;
      readonly optionId: string;
      readonly value: string;
      readonly label: string;
      /** False when the model lacks the requested level and the nearest one was used. */
      readonly exact: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Match a requested effort ("xhigh", "Extra High", "extra-high", "max") to one
 * of the descriptor's levels: an exact id or label first, otherwise the
 * closest level on the ladder, preferring the higher one on a tie.
 */
export function resolveEffort(
  requested: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): EffortResolution {
  const descriptor = findEffortDescriptor(descriptors);
  if (descriptor === undefined) {
    return { ok: false, message: "This model has no reasoning effort setting." };
  }
  const levels = descriptor.options.map((choice) => choice.id).join(", ");
  const key = normalize(requested);
  const exact = descriptor.options.find(
    (choice) => normalize(choice.id) === key || normalize(choice.label) === key,
  );
  if (exact !== undefined) {
    return {
      ok: true,
      optionId: descriptor.id,
      value: exact.id,
      label: exact.label,
      exact: true,
    };
  }
  const wanted = effortRank(requested);
  if (wanted === undefined) {
    return {
      ok: false,
      message: `Effort "${requested}" is not a known level; this model offers: ${levels}.`,
    };
  }
  let best: { choice: (typeof descriptor.options)[number]; rank: number } | undefined;
  for (const choice of descriptor.options) {
    const rank = choiceRank(choice);
    if (rank === undefined) continue;
    if (rank === wanted) {
      best = { choice, rank };
      break;
    }
    const distance = Math.abs(rank - wanted);
    const bestDistance = best === undefined ? Infinity : Math.abs(best.rank - wanted);
    if (distance < bestDistance || (distance === bestDistance && rank > best!.rank)) {
      best = { choice, rank };
    }
  }
  if (best === undefined) {
    return { ok: false, message: `This model offers no comparable effort levels (${levels}).` };
  }
  return {
    ok: true,
    optionId: descriptor.id,
    value: best.choice.id,
    label: best.choice.label,
    exact: best.rank === wanted,
  };
}

/** Set the resolved effort on option selections, replacing any earlier value for that option. */
export function withEffortSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
  resolved: { readonly optionId: string; readonly value: string },
): ReadonlyArray<ProviderOptionSelection> {
  return [
    ...(selections ?? []).filter((selection) => selection.id !== resolved.optionId),
    { id: resolved.optionId, value: resolved.value },
  ];
}

/** The raw effort option value a model selection sets explicitly, if any. */
export function modelSelectionEffortValue(
  selection: Pick<ModelSelection, "options"> | null | undefined,
): string | undefined {
  const value = selection?.options?.find((option) => isEffortId(option.id))?.value;
  return typeof value === "string" ? value : undefined;
}
