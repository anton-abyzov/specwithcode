/**
 * The name an installed page gets in Finder, the Start menu or the app
 * launcher. It is a file name on every OS, so it is sanitized for every OS at
 * once, and it must never pass for SpecWithCode, the operating system or
 * another app: a look-alike gets " (Page)" so the person can tell them apart.
 */

export const ARTIFACT_APP_NAME_MAX = 64;
export const ARTIFACT_APP_UNTITLED = "Untitled page";
export const ARTIFACT_APP_LOOKALIKE_SUFFIX = " (Page)";

const ARTIFACT_APP_COUNTER_MAX = 99;

export const ARTIFACT_APP_RESERVED_NAMES: ReadonlyArray<string> = [
  "SpecWithCode",
  "SpecWithCode Dev",
  "Apple",
  "Microsoft",
  "Finder",
  "System Settings",
  "System Preferences",
  "Safari",
  "Terminal",
  "Settings",
  "Windows",
  "File Explorer",
  "Google Chrome",
  "Claude",
  "Anthropic",
];

// Unpaired surrogates cannot be encoded in a file name on any OS.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Format characters (zero-width joiners, bidi overrides) are invisible spoofing tools: drop them.
const INVISIBLE = /[\p{Cf}]/gu;
// Control characters, line separators and characters no file system accepts become spaces.
const SEPARATING = /[\p{Cc}\p{Zl}\p{Zp}/\\:*?"<>|]/gu;
const WHITESPACE = /[\s\p{Zs}]+/gu;
// Windows refuses device names as file names, with or without an extension.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(?=\.|$)/iu;

function trimToFixpoint(value: string): string {
  let current = value;
  for (;;) {
    const next = current
      .trim()
      .replace(/^[.\s]+/u, "")
      .replace(/\.app$/iu, "")
      .replace(/[.\s]+$/u, "");
    if (next === current) return current;
    current = next;
  }
}

function capCodePoints(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join("");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function sanitizeArtifactAppName(title: string): string {
  // Invisible characters go before normalizing, or a base and mark they separate would only
  // compose on a second pass and the result would not sanitize to itself.
  let name = title
    .replace(LONE_SURROGATE, "")
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SEPARATING, " ")
    .replace(WHITESPACE, " ");
  name = trimToFixpoint(name);
  name = name.replace(WINDOWS_DEVICE_NAME, `$1${ARTIFACT_APP_LOOKALIKE_SUFFIX}`);
  name = trimToFixpoint(capCodePoints(name, ARTIFACT_APP_NAME_MAX));
  return name.length === 0 ? ARTIFACT_APP_UNTITLED : name;
}

// Characters that look like Latin letters in common UI fonts, mapped to the letter they imitate.
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a",
  в: "b",
  ь: "b",
  с: "c",
  ԁ: "d",
  е: "e",
  ё: "e",
  һ: "h",
  н: "h",
  і: "l",
  ї: "l",
  ј: "j",
  к: "k",
  ӏ: "l",
  м: "m",
  п: "n",
  о: "o",
  р: "p",
  ԛ: "q",
  г: "r",
  ѕ: "s",
  т: "t",
  у: "y",
  ү: "y",
  х: "x",
  ԝ: "w",
  // Greek
  α: "a",
  β: "b",
  ϲ: "c",
  ε: "e",
  η: "n",
  ι: "l",
  κ: "k",
  μ: "u",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  γ: "y",
  // Latin variants and digits
  ı: "l",
  i: "l",
  ł: "l",
  ɡ: "g",
  ɑ: "a",
  "0": "o",
  "1": "l",
};

/**
 * A comparison key: case, accents, look-alike letters, spaces and punctuation
 * folded away. Both sides of a comparison are folded, so mapping `i` and `l`
 * to one letter only widens what counts as a look-alike.
 */
export function foldArtifactAppName(name: string): string {
  const mapped = Array.from(
    name.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, ""),
    (character) => HOMOGLYPHS[character] ?? character,
  ).join("");
  return mapped
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replaceAll("rn", "m")
    .replaceAll("vv", "w");
}

// Shortens the base so the suffix always survives the length cap.
function withSuffix(base: string, suffix: string): string {
  const room = ARTIFACT_APP_NAME_MAX - codePointLength(suffix);
  const trimmed = trimToFixpoint(capCodePoints(base, room));
  return `${trimmed.length === 0 ? ARTIFACT_APP_UNTITLED : trimmed}${suffix}`;
}

function comparisonKey(name: string): string {
  // macOS can hand file names back decomposed; compare composed.
  return name.normalize("NFC").toLowerCase();
}

/**
 * The name for a new install. `reservedNames` adds to the built-in reserved
 * list (for example apps already installed on the computer); `takenNames` are
 * the names of existing installs, compared case-insensitively.
 */
export function resolveArtifactAppName(input: {
  readonly title: string;
  readonly reservedNames?: ReadonlyArray<string>;
  readonly takenNames: ReadonlyArray<string>;
}): string {
  let name = sanitizeArtifactAppName(input.title);
  const reserved = new Set(
    [...ARTIFACT_APP_RESERVED_NAMES, ...(input.reservedNames ?? [])]
      .map(foldArtifactAppName)
      .filter((folded) => folded.length > 0),
  );
  if (reserved.has(foldArtifactAppName(name))) {
    name = withSuffix(name, ARTIFACT_APP_LOOKALIKE_SUFFIX);
  }
  const taken = new Set(input.takenNames.map(comparisonKey));
  if (!taken.has(comparisonKey(name))) return name;
  for (let counter = 2; counter <= ARTIFACT_APP_COUNTER_MAX; counter += 1) {
    const candidate = withSuffix(name, ` ${counter}`);
    if (!taken.has(comparisonKey(candidate))) return candidate;
  }
  throw new Error("No free app name");
}
