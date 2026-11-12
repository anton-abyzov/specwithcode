/**
 * The user's own words for speech recognition: product names, tools, people.
 * It is local user data on this machine, never sent to a server, so the only
 * things that read it are the speech engine here and the Voice settings editor.
 */
import { PRODUCT_VOCABULARY } from "./productVocabulary.ts";

export type VocabularyTerm = {
  readonly phrase: string;
  /** Written instead of `phrase` when the transcript contains it. */
  readonly replacement?: string;
  /** Offered to the recognizer but never rewritten. Built-in terms only; never stored. */
  readonly hintOnly?: true;
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
  const seen = new Set<string>();
  return terms.flatMap((term) => {
    const word = term.replacement ?? term.phrase;
    const key = word.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [word];
  });
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

/** "SpecWeave", "spec weave" and "spec-weave" are one term. */
function termKey(phrase: string): string {
  return termParts(phrase).join("").toLowerCase();
}

function isLowercase(text: string): boolean {
  return text === text.toLowerCase();
}

/**
 * The person's list with the product's own words ahead of it, which is the
 * order the recognizer's hints are cut in. Their line wins over a built-in one
 * for the same term when it says something: a replacement, or its own capitals.
 * An all-lowercase copy (an imported "specweave") says nothing about casing, so
 * the product's spelling stands.
 */
export function withProductVocabulary(
  user: readonly VocabularyTerm[],
  product: readonly VocabularyTerm[] = PRODUCT_VOCABULARY,
): readonly VocabularyTerm[] {
  const own = new Map(user.map((term) => [termKey(term.phrase), term]));
  const settled = new Set<string>();
  const lead = product.map((term) => {
    const key = termKey(term.phrase);
    const mine = own.get(key);
    if (mine === undefined) return term;
    settled.add(key);
    if (mine.replacement === undefined && isLowercase(mine.phrase)) return term;
    // Their spelling, on the built-in term's pattern, so its split forms still match.
    const written = mine.replacement ?? mine.phrase;
    return written === term.phrase
      ? { phrase: term.phrase }
      : { phrase: term.phrase, replacement: written };
  });
  return [...lead, ...user.filter((term) => !settled.has(termKey(term.phrase)))];
}

/** The built-in words as the editor shows them, read-only. */
export function productWords(product: readonly VocabularyTerm[] = PRODUCT_VOCABULARY): string[] {
  return writtenForms(product);
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
        term.hintOnly !== true &&
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
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    const term =
      usable[rest.findIndex((group, index) => index < usable.length && group !== undefined)];
    if (!term) return match;
    const written = term.replacement ?? term.phrase;
    if (!isLowercase(written)) return written;
    // A lowercase term has no capitals of its own, so an ordinary capital is the
    // sentence's and stays: "Kubernetes" is kept, and "Work tree" opening a
    // sentence becomes "Worktree". Other casing is still fixed: "NPM" becomes "npm".
    const capital = match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
    if (match !== capital || match === match.toLowerCase()) return written;
    if (term.replacement === undefined && match.toLowerCase() === written) return match;
    const before = text.slice(0, rest[usable.length] as number);
    return /(?:^|[.!?]\s+)$/.test(before)
      ? written.charAt(0).toUpperCase() + written.slice(1)
      : written;
  });
}

/** Below this peak (16-bit full scale is 1.0) a recording has no speech to transcribe. */
export const SPEECH_PEAK = 0.02;

/**
 * What Whisper writes when nobody spoke: sound tags, a lone "you", and the
 * sign-offs of the videos it learned from. Nobody dictates these as a whole phrase.
 */
const INVENTIONS =
  /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[\p{P}\p{S}\s]+|you|(?:thanks|thank you)(?: so much)? for watching|(?:(?:we|i)(?:'ll| will) )?see you (?:in the next (?:video|one)|next time)|subtitles by .*|(?:please |don't forget to )?(?:like and )?subscribe(?: to (?:my|the|our) channel)?|спасибо за просмотр|продолжение следует|субтитры .*)[.!…]*$/iu;

/** Real words when spoken, and what a recognizer makes of a near-silent recording. */
const QUIET_WORDS = /^(?:thank you|thanks|bye|спасибо)[.!]?$/iu;

const LATIN_LANGUAGES = new Set(
  (
    "en de es fr pt tr pl ca nl sv it id fi vi ms cs ro da hu no hr lt la mi cy sk lv az sl et br eu " +
    "is bs sq sw gl sn yo so af oc uz fo ht tk nn mt lb tl mg haw ln ha jw su"
  ).split(" "),
);
const CYRILLIC_LANGUAGES = new Set("ru uk be bg sr mk kk mn tg ba tt".split(" "));

/**
 * Noise heard in a pinned language can still come back in another alphabet. Latin
 * is allowed everywhere, because names and code words are written in it.
 */
function inForeignScript(text: string, language: string | undefined): boolean {
  const code = language?.split(/[-_]/)[0]?.toLowerCase() ?? "";
  const own = LATIN_LANGUAGES.has(code)
    ? /\p{Script=Latin}/u
    : CYRILLIC_LANGUAGES.has(code)
      ? /[\p{Script=Latin}\p{Script=Cyrillic}]/u
      : null;
  if (own === null) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  const foreign = letters.filter((letter) => !own.test(letter)).length;
  return foreign * 2 > letters.length;
}

export function wavPeak(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let peak = 0;
  for (let offset = 44; offset + 1 < wav.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  }
  return peak / 0x8000;
}

/** Length of the 16-bit PCM recording the renderer sends, from its own header. */
export function wavSeconds(wav: Uint8Array): number {
  if (wav.byteLength <= 44) return 0;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const bytesPerSecond = view.getUint32(28, true);
  return bytesPerSecond > 0 ? (wav.byteLength - 44) / bytesPerSecond : 0;
}

export type TranscriptVerdict = {
  readonly text: string;
  /** Why the engine's text was thrown away, for the log. */
  readonly dropped: "quiet" | "invented" | "echo" | "script" | null;
};

/** Keeps what was said and drops what only silence, noise or an echoed hint could produce. */
export function judgeTranscript(
  text: string,
  recording: {
    /** Whisper invents text on noise; Apple's recognizer does not. Whisper when not given. */
    readonly engine?: "whisper" | "apple";
    readonly prompt: string;
    readonly peak: number;
    readonly terms?: readonly VocabularyTerm[];
    /** The language the engine was told to listen for; none when it detected one. */
    readonly language?: string;
  },
): TranscriptVerdict {
  const { prompt, peak, terms = [], language } = recording;
  const trimmed = text.trim();
  if (!trimmed) return { text: "", dropped: null };
  if (recording.engine === "apple") {
    // A soft voice is still speech here; only a stock word from a near-silent recording goes.
    const stock = peak < SPEECH_PEAK && (INVENTIONS.test(trimmed) || QUIET_WORDS.test(trimmed));
    return stock ? { text: "", dropped: "quiet" } : { text: trimmed, dropped: null };
  }
  if (peak < SPEECH_PEAK) return { text: "", dropped: "quiet" };
  if (INVENTIONS.test(trimmed)) return { text: "", dropped: "invented" };
  if (inForeignScript(trimmed, language)) return { text: "", dropped: "script" };
  // Whisper can repeat its hint list on noise; ordinary speech is not a run of it.
  const unpunctuated = (value: string) => value.trim().replace(/[.!]+$/, "");
  const bare = unpunctuated(trimmed);
  if (
    prompt &&
    !writtenForms(terms).some((word) => unpunctuated(word) === bare) &&
    (bare === unpunctuated(prompt) ||
      // Two names said together are speech; a run of three or more is the hint list.
      (bare.length >= 20 && bare.split(", ").length >= 3 && prompt.includes(bare)))
  ) {
    return { text: "", dropped: "echo" };
  }
  return { text: trimmed, dropped: null };
}

export function acceptTranscript(
  text: string,
  prompt: string,
  peak: number,
  terms: readonly VocabularyTerm[] = [],
  language?: string,
): string {
  return judgeTranscript(text, { prompt, peak, terms, ...(language ? { language } : {}) }).text;
}
