/**
 * Which icon a personal assistant gets, so two assistants in one list never
 * look the same. Every client and server computes the same answer from the
 * same assistants, which keeps windows on different machines from undoing
 * each other.
 */
export interface AssistantIcon {
  readonly kind: "lucide";
  readonly name: string;
  readonly color: string;
}

type AnyIcon =
  | { readonly kind: "lucide"; readonly name: string; readonly color?: string }
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color?: string };

/**
 * The icons setup offers, first one being the icon every assistant had before
 * icons were chosen. Each has its own glyph and its own colour, none of them a
 * purple that reads as the bell's violet, and each draws as a different symbol
 * in the iPhone and Android apps.
 */
export const ASSISTANT_ICON_SUGGESTIONS: ReadonlyArray<AssistantIcon> = [
  { kind: "lucide", name: "concierge-bell", color: "violet" },
  { kind: "lucide", name: "sparkles", color: "amber" },
  { kind: "lucide", name: "compass", color: "teal" },
  { kind: "lucide", name: "feather", color: "rose" },
  { kind: "lucide", name: "coffee", color: "orange" },
  { kind: "lucide", name: "star", color: "sky" },
  { kind: "lucide", name: "lightbulb", color: "yellow" },
  { kind: "lucide", name: "rocket", color: "blue" },
  { kind: "lucide", name: "leaf", color: "green" },
  { kind: "lucide", name: "gem", color: "cyan" },
  { kind: "lucide", name: "crown", color: "red" },
  { kind: "lucide", name: "smile", color: "pink" },
];

/** The icon assistants had before one was chosen at setup. */
export const LEGACY_ASSISTANT_ICON: AssistantIcon = ASSISTANT_ICON_SUGGESTIONS[0]!;

/** What makes two icons look the same: the glyph, whatever its colour. */
export function assistantIconGlyph(icon: AnyIcon | null | undefined): string | null {
  if (!icon) return null;
  if (icon.kind === "lucide") return `lucide:${icon.name}`;
  if (icon.kind === "emoji") return `emoji:${icon.emoji}`;
  return `monogram:${icon.text.toLowerCase()}`;
}

const colorOf = (icon: AnyIcon | null | undefined) =>
  icon && icon.kind !== "emoji" ? (icon.color ?? null) : null;

/** Whether the icon is still the one every assistant used to start with. */
export function isLegacyAssistantIcon(icon: AnyIcon | null | undefined): boolean {
  return (
    icon?.kind === "lucide" &&
    icon.name === LEGACY_ASSISTANT_ICON.name &&
    icon.color === LEGACY_ASSISTANT_ICON.color
  );
}

function seedOffset(seed: string | undefined): number {
  if (!seed) return 0;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % ASSISTANT_ICON_SUGGESTIONS.length;
}

/**
 * An icon no other assistant uses. With nothing taken it is the familiar bell;
 * otherwise the search starts at a place the seed picks, so different people
 * get different suggestions, and prefers a colour nobody uses either.
 */
export function suggestAssistantIcon(input: {
  readonly taken: ReadonlyArray<AnyIcon | null | undefined>;
  readonly seed?: string | undefined;
}): AssistantIcon {
  const glyphs = new Set(input.taken.map(assistantIconGlyph));
  const colors = new Set(input.taken.map(colorOf));
  if (glyphs.size === 0 || (glyphs.size === 1 && glyphs.has(null))) return LEGACY_ASSISTANT_ICON;
  const start = seedOffset(input.seed);
  const ordered = ASSISTANT_ICON_SUGGESTIONS.map(
    (_, index) => ASSISTANT_ICON_SUGGESTIONS[(start + index) % ASSISTANT_ICON_SUGGESTIONS.length]!,
  );
  const free = ordered.filter((icon) => !glyphs.has(assistantIconGlyph(icon)));
  return free.find((icon) => !colors.has(icon.color)) ?? free[0] ?? ordered[0]!;
}

/** The setup choices in order: the suggested one first, then the rest, used ones last. */
export function assistantIconChoices(input: {
  readonly taken: ReadonlyArray<AnyIcon | null | undefined>;
  readonly seed?: string | undefined;
}): ReadonlyArray<AssistantIcon & { readonly taken: boolean }> {
  const glyphs = new Set(input.taken.map(assistantIconGlyph));
  const suggested = suggestAssistantIcon(input);
  const rest = ASSISTANT_ICON_SUGGESTIONS.filter((icon) => icon.name !== suggested.name);
  const isTaken = (icon: AssistantIcon) => glyphs.has(assistantIconGlyph(icon));
  return [
    { ...suggested, taken: isTaken(suggested) },
    ...rest.filter((icon) => !isTaken(icon)).map((icon) => ({ ...icon, taken: false })),
    ...rest.filter(isTaken).map((icon) => ({ ...icon, taken: true })),
  ];
}

export interface AssistantIconHolder {
  readonly id: string;
  readonly environmentId: string;
  readonly createdAt: string;
  readonly icon: AnyIcon | null | undefined;
}

/**
 * The icon changes that make assistants from before icon choice tell apart.
 * Only an assistant still on the starting bell changes, and only when another
 * assistant shows the same bell; the earliest keeps it. An icon somebody chose
 * is never touched, even when two people chose the same one.
 */
export function distinctAssistantIconPlan(
  assistants: ReadonlyArray<AssistantIconHolder>,
): ReadonlyArray<{
  readonly id: string;
  readonly environmentId: string;
  readonly icon: AssistantIcon;
}> {
  const ordered = assistants.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
  const legacy = ordered.filter((assistant) => isLegacyAssistantIcon(assistant.icon));
  if (legacy.length < 2) return [];
  const taken: Array<AnyIcon | null | undefined> = ordered
    .filter((assistant) => !isLegacyAssistantIcon(assistant.icon))
    .map((assistant) => assistant.icon);
  taken.push(LEGACY_ASSISTANT_ICON);
  return legacy.slice(1).map((assistant) => {
    const icon = suggestAssistantIcon({ taken });
    taken.push(icon);
    return { id: assistant.id, environmentId: assistant.environmentId, icon };
  });
}
