import { MACHINE_SHORT_NAME_MAX_LENGTH } from "@specweave-studio/contracts";

/**
 * The label a machine chip keeps when it runs out of room: never the icon
 * alone, always at least two characters a person can tell machines apart by.
 *
 * - A short label set on the machine card wins.
 * - A name of two or three characters is its own label ("M4", "m3").
 * - Otherwise two capitals that no other machine in the fleet uses: the
 *   initials of the first two words ("linux-mini" is "LM"), then the first
 *   letter with each later one ("LI", "LN", ...), then the first letter and a
 *   digit.
 *
 * Machines are settled in sorted id order, so every device that knows the same
 * fleet gives every machine the same label.
 */
export interface MachineShortLabelInput {
  readonly environmentId: string;
  readonly name: string;
  /** The label set on the machine card; empty or absent derives one. */
  readonly short?: string | undefined;
}

/** Fewer characters than this do not tell machines apart. */
export const MACHINE_SHORT_LABEL_MIN_LENGTH = 2;

// Locale-free, so every device folds a name the same way.
const fold = (value: string) => value.toUpperCase();

/** A string's visible characters, so "é" written as e plus an accent is one. */
export function graphemes(value: string): ReadonlyArray<string> {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter === undefined) return [...value.normalize("NFC")];
  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );
}

export function graphemeLength(value: string): number {
  return graphemes(value).length;
}

function ownLabel(name: string): string | null {
  const trimmed = name.trim().normalize("NFC");
  const length = graphemeLength(trimmed);
  return length >= MACHINE_SHORT_LABEL_MIN_LENGTH &&
    length <= MACHINE_SHORT_NAME_MAX_LENGTH &&
    !/\s/.test(trimmed)
    ? trimmed
    : null;
}

/** Two-letter abbreviations of a name, most telling first. */
export function machineShortLabelCandidates(name: string): ReadonlyArray<string> {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => [...word]);
  const letters = words.flat();
  if (letters.length === 0) return ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"];
  const first = letters[0]!;
  const out: string[] = [];
  for (const word of words.slice(1)) out.push(first + word[0]!);
  for (const letter of letters.slice(1)) out.push(first + letter);
  for (let digit = 1; digit <= 9; digit += 1) out.push(first + String(digit));
  const seen = new Set<string>();
  return out
    .map(fold)
    .filter((candidate) => (seen.has(candidate) ? false : (seen.add(candidate), true)));
}

export function assignMachineShortLabels(
  machines: Iterable<MachineShortLabelInput>,
): ReadonlyMap<string, string> {
  const byId = new Map<string, MachineShortLabelInput>();
  for (const machine of machines) byId.set(machine.environmentId, machine);
  const ids = [...byId.keys()].sort();
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  const claim = (id: string, label: string) => {
    labels.set(id, label);
    taken.add(fold(label));
  };
  // A chosen label always shows, even when two machines were given the same one.
  for (const id of ids) {
    const chosen = byId.get(id)!.short?.trim().normalize("NFC") ?? "";
    if (graphemeLength(chosen) >= MACHINE_SHORT_LABEL_MIN_LENGTH) claim(id, chosen);
  }
  for (const id of ids) {
    if (labels.has(id)) continue;
    const own = ownLabel(byId.get(id)!.name);
    if (own !== null && !taken.has(fold(own))) claim(id, own);
  }
  for (const id of ids) {
    if (labels.has(id)) continue;
    claim(id, pickMachineShortLabel(byId.get(id)!.name, undefined, taken));
  }
  return labels;
}

/**
 * One machine's label against labels already in use (folded to capitals), for a
 * machine the fleet map does not hold or a name it holds differently. The other
 * machines keep theirs, so the result never duplicates one already showing.
 */
export function pickMachineShortLabel(
  name: string,
  short: string | undefined,
  taken: ReadonlySet<string>,
): string {
  const chosen = short?.trim().normalize("NFC") ?? "";
  if (graphemeLength(chosen) >= MACHINE_SHORT_LABEL_MIN_LENGTH) return chosen;
  const own = ownLabel(name);
  if (own !== null && !taken.has(fold(own))) return own;
  const candidates = machineShortLabelCandidates(name);
  return candidates.find((candidate) => !taken.has(candidate)) ?? candidates[0]!;
}

/** The folded form `pickMachineShortLabel` compares against. */
export const foldMachineShortLabel = fold;
