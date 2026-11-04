/**
 * The user's own words for speech recognition: product names, tools, people.
 * It is local user data on this machine, never sent to a server, so the only
 * things that read it are the speech engine here and the Voice settings editor.
 */
export type VocabularyTerm = {
  readonly phrase: string;
  /** Written instead of `phrase` when the transcript contains it. */
  readonly replacement?: string;
};

export const VOCABULARY_MAX_TERMS = 2_000;
const TERM_MAX_LENGTH = 80;
/** Whisper allows 224 prompt tokens; unusual words cost about three characters a token. */
const WHISPER_PROMPT_MAX_CHARACTERS = 500;
/** Apple recommends at most 100 contextual strings. */
const CONTEXTUAL_STRINGS_MAX = 100;
const REPLACEMENT_SEPARATOR = /\s*=>\s*/;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)[-_](?:[a-z]{2,8}[-_])*[A-Za-z0-9_-]{12,}/,
  /\b(?:gh[oprsu]_|github_pat_|glpat-|xox[abprs]-|ya29\.)[A-Za-z0-9_.-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}/,
  /-----BEGIN /,
  /\b(?:password|passwd|passphrase|secret|api[ _-]?key|token|bearer)\b\s*[:=]/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/i,
  /\b[0-9a-fA-F]{16,}\b/,
  // Phone, card and account numbers.
  /(?<![\p{L}\p{N}-])(?:\+?\(?\d[\s().-]{0,2}){9,}/u,
];

function characterClass(character: string): number {
  if (/\d/.test(character)) return 0;
  return character === character.toLowerCase() ? 1 : 2;
}

/**
 * Generated strings flip between digits and cases more than every other character
 * (about 0.6 of the time for base62); names like iPhone15ProMax flip less, and are
 * shorter than a key.
 */
function looksRandom(word: string): boolean {
  if (word.length < 12 || !/^[A-Za-z0-9+/=]+$/.test(word)) return false;
  const hasDigit = /\d/.test(word);
  const hasBothCases = /[a-z]/.test(word) && /[A-Z]/.test(word);
  if (word.length >= 24 && hasDigit && hasBothCases) return true;
  if (!hasDigit && !hasBothCases) return false;
  let changes = 0;
  for (let index = 1; index < word.length; index += 1) {
    if (characterClass(word[index]!) !== characterClass(word[index - 1]!)) changes += 1;
  }
  return changes / word.length >= 0.55;
}

export function looksSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (text.split(/[\s_-]+/).some(looksRandom)) return true;
  // A long token cut into short pieces by its separators is still one token.
  return text
    .split(/\s+/)
    .some(
      (word) =>
        word.length >= 24 &&
        /^[\w-]+$/.test(word) &&
        /\d/.test(word) &&
        /[a-z]/.test(word) &&
        /[A-Z]/.test(word),
    );
}

function validTerm(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= TERM_MAX_LENGTH &&
    !/[\r\n\t]/.test(text) &&
    /[\p{L}\p{N}]/u.test(text)
  );
}

export type ParsedVocabulary = {
  readonly terms: readonly VocabularyTerm[];
  /** Lines refused because they look like a secret or are too long. Never echoed. */
  readonly refused: number;
};

/** One term per line, or `heard => written`. A line starting with # is a comment. */
export function parseVocabulary(text: string): ParsedVocabulary {
  const terms: VocabularyTerm[] = [];
  const seen = new Set<string>();
  let refused = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [phrase = "", replacement, ...rest] = line.split(REPLACEMENT_SEPARATOR);
    const ok =
      rest.length === 0 &&
      validTerm(phrase) &&
      (replacement === undefined || validTerm(replacement)) &&
      !looksSecret(line);
    if (!ok) {
      refused += 1;
      continue;
    }
    const key = phrase.toLocaleLowerCase();
    if (seen.has(key) || terms.length >= VOCABULARY_MAX_TERMS) continue;
    seen.add(key);
    terms.push(replacement === undefined ? { phrase } : { phrase, replacement });
  }
  return { terms, refused };
}

export function formatVocabulary(terms: readonly VocabularyTerm[]): string {
  return terms
    .map((term) => (term.replacement ? `${term.phrase} => ${term.replacement}` : term.phrase))
    .join("\n");
}

/** Reads the stored file; anything unreadable is treated as no vocabulary. */
export function decodeStoredVocabulary(json: string): readonly VocabularyTerm[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  const stored = (value as { terms?: unknown } | null)?.terms;
  if (!Array.isArray(stored)) return [];
  const lines = stored.flatMap((entry) => {
    const term = entry as { phrase?: unknown; replacement?: unknown } | null;
    if (typeof term?.phrase !== "string") return [];
    return [
      typeof term.replacement === "string" && term.replacement
        ? `${term.phrase} => ${term.replacement}`
        : term.phrase,
    ];
  });
  // Stored files can be edited by hand, so they pass the same filter as the editor.
  return parseVocabulary(lines.join("\n")).terms;
}

export function encodeStoredVocabulary(terms: readonly VocabularyTerm[]): string {
  return `${JSON.stringify({ version: 1, terms }, null, 2)}\n`;
}

/** The words written in the transcript, earliest first: the list is in priority order. */
function writtenForms(terms: readonly VocabularyTerm[]): string[] {
  return [...new Set(terms.map((term) => term.replacement ?? term.phrase))];
}

/** Hint text for Whisper, cut to its token budget without splitting a term. */
export function whisperPrompt(terms: readonly VocabularyTerm[]): string {
  const included: string[] = [];
  let length = 0;
  for (const word of writtenForms(terms)) {
    if (length + word.length + 2 > WHISPER_PROMPT_MAX_CHARACTERS) break;
    included.push(word);
    length += word.length + 2;
  }
  return included.length > 0 ? `${included.join(", ")}.` : "";
}

export function contextualStrings(terms: readonly VocabularyTerm[]): string[] {
  return writtenForms(terms).slice(0, CONTEXTUAL_STRINGS_MAX);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "SpecWeave" also matches "spec weave" and "spec-weave", which is how recognizers hear it. */
function termParts(phrase: string): string[] {
  return phrase.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|[\s-]+/u).filter(Boolean);
}

function termPattern(phrase: string): string {
  return termParts(phrase).map(escapeRegExp).join("[\\s-]?");
}

/**
 * Applies the vocabulary to a transcript. A two-letter term is too likely to be
 * an ordinary word to rewrite by case alone, so it needs an explicit replacement.
 */
export function correctTranscript(text: string, terms: readonly VocabularyTerm[]): string {
  // Runs on the main process for every phrase, so the pattern holds only terms that can match.
  const lowered = text.toLowerCase();
  const usable = terms
    .filter(
      (term) =>
        (term.replacement !== undefined || term.phrase.length >= 3) &&
        lowered.includes(termParts(term.phrase)[0]?.toLowerCase() ?? ""),
    )
    .toSorted((a, b) => b.phrase.length - a.phrase.length);
  if (usable.length === 0) return text;
  // One pass over one pattern, so a term's written form is never rewritten by another term.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${usable.map((term) => `(${termPattern(term.phrase)})`).join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return text.replace(pattern, (match, ...groups: unknown[]) => {
    const term = usable[groups.findIndex((group) => typeof group === "string")];
    return term ? (term.replacement ?? term.phrase) : match;
  });
}

/** What Whisper invents on silence; real speech is judged by the recording's level instead. */
const SILENCE_INVENTIONS =
  /^(?:\[[^\]]*\]|\([^)]*\)|\.+|you|thank you|thanks|thanks for watching|thank you for watching|bye|спасибо|продолжение следует)[.!]?$/iu;
/** Below this peak (16-bit full scale is 1.0) a recording has no speech to transcribe. */
const SPEECH_PEAK = 0.02;

export function wavPeak(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let peak = 0;
  for (let offset = 44; offset + 1 < wav.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  }
  return peak / 0x8000;
}

/** Drops a transcript that only a silent recording or an echoed prompt could produce. */
export function acceptTranscript(
  text: string,
  prompt: string,
  peak: number,
  terms: readonly VocabularyTerm[] = [],
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (peak < SPEECH_PEAK && SILENCE_INVENTIONS.test(trimmed)) return "";
  // Whisper can repeat its hint list on noise; ordinary speech is not a run of it.
  const unpunctuated = (value: string) => value.trim().replace(/[.!]+$/, "");
  const bare = unpunctuated(trimmed);
  if (
    prompt &&
    !(peak >= SPEECH_PEAK && writtenForms(terms).some((word) => unpunctuated(word) === bare)) &&
    (bare === unpunctuated(prompt) || (bare.length >= 20 && prompt.includes(bare)))
  ) {
    return "";
  }
  return trimmed;
}
