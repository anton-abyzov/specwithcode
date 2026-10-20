/**
 * Brain and padlock artwork is retired from SpecWithCode. Projects that saved
 * one as their icon keep their stored value; it is drawn as a replacement
 * when read, so no user data is rewritten.
 */
const RETIRED_ICON_NAME_REPLACEMENTS: Readonly<Record<string, string>> = {
  brain: "lightbulb",
  "brain-circuit": "cpu",
  "brain-cog": "cpu",
  lock: "shield",
  "lock-open": "shield",
  "lock-keyhole": "shield",
  "lock-keyhole-open": "shield",
};

const RETIRED_ICON_NAME_SEGMENTS = new Set(["brain", "lock", "locked", "unlock"]);

const RETIRED_EMOJI_REPLACEMENTS: Readonly<Record<string, string>> = {
  "\u{1F9E0}": "\u{1F4A1}",
  "\u{1F512}": "\u{1F6E1}\u{FE0F}",
  "\u{1F513}": "\u{1F6E1}\u{FE0F}",
  "\u{1F510}": "\u{1F511}",
  "\u{1F50F}": "\u{1F58B}\u{FE0F}",
};

/** True for a Lucide name that draws a brain or a padlock ("user-lock", "unlock", not "clock"). */
export function isRetiredProjectIconName(name: string): boolean {
  return name.split("-").some((segment) => RETIRED_ICON_NAME_SEGMENTS.has(segment));
}

/** The Lucide name to draw for a saved project icon name. */
export function projectIconNameForDisplay(name: string): string {
  const replacement = RETIRED_ICON_NAME_REPLACEMENTS[name];
  if (replacement) return replacement;
  if (!isRetiredProjectIconName(name)) return name;
  return name.split("-").includes("brain") ? "lightbulb" : "shield";
}

/** The emoji to draw for a saved project emoji. */
export function projectEmojiForDisplay(emoji: string): string {
  return (
    RETIRED_EMOJI_REPLACEMENTS[emoji] ??
    RETIRED_EMOJI_REPLACEMENTS[emoji.replace(/\u{FE0F}/gu, "")] ??
    emoji
  );
}
