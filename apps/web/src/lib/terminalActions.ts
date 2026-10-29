/**
 * Links and one-time codes in terminal output. Output stays inert text: this
 * only finds well-formed http(s) URLs to offer as links and sign-in codes to
 * offer for copying. Nothing here opens, runs or sends anything.
 */

export type TerminalTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly text: string; readonly url: string }
  | { readonly kind: "code"; readonly text: string };

export interface TerminalActions {
  /** URLs on a line that asks the reader to open them, such as a device sign-in page. */
  readonly links: readonly string[];
  readonly codes: readonly string[];
}

// RFC 3986 characters plus letters and digits of any script (a Cyrillic wiki path):
// a control picture, quote mark or space ends the URL.
const URL_PATTERN = /https?:\/\/[\p{L}\p{N}\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
// What is left of an escape sequence whose ESC byte was lost upstream, as in "...a[0m".
const ESCAPE_REMNANT = /\[[0-9;]*m$/u;
// Sentence punctuation after a URL belongs to the sentence.
const TRAILING_PUNCTUATION = /[.,;:!?'*]+$/u;
// Also matches JSON keys such as user_code and verification_uri.
const CODE_LINE =
  /(?<![A-Za-z0-9])(?:code|one[- ]time|device|verification|passcode|otp)(?![A-Za-z0-9])/iu;
// GitHub, Google and most device flows: XXXX-XXXX. Others print one group after "code".
// Never part of a longer hyphenated token, such as the middle of a UUID.
const GROUPED_CODE = /(?<![A-Za-z0-9-])[A-Z0-9]{4,5}(?:-[A-Z0-9]{4,5}){1,2}(?![A-Za-z0-9-])/gu;
const CODE_AFTER_KEYWORD =
  /(?<![A-Za-z0-9])(?:[Cc]ode|CODE)(?:\s+is)?\s*[:=]?\s*["'`]?([A-Z0-9]{6,12}|[0-9]{6,8})["'`]?(?=[\s.,;!)]|$)/gu;
const PROMPT_LINE =
  /\b(?:open|visit|go to|navigate|browser|log ?in|sign ?in|authori[sz]e|authenticate|verify|activate|enter)\b/iu;
const SIGN_IN_LINE =
  /(?:one[- ]time|user[_ ]code|device ?login|authenticat|sign ?in|log ?in|activat)/iu;
const MAX_ACTIONS = 3;
// Bounds the scan of a huge output; codes and sign-in links come early in a run's output.
const MAX_SCAN = 200_000;
// Bounds the work on one long line, such as minified JSON, and the links one output mounts.
const MAX_LINE_MATCHES = 50;
const MAX_SEGMENTS = 400;

function balancedUrl(raw: string): string {
  let url = raw.replace(ESCAPE_REMNANT, "").replace(TRAILING_PUNCTUATION, "");
  // A URL in parentheses, as in "(see https://x.y/z)", ends before the closing one.
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
      url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
    }
  }
  return url;
}

/** The URL when it parses as an absolute http(s) URL with a host, else null. */
export function safeTerminalUrl(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

function isCode(token: string, line: string): boolean {
  const letters = /[A-Z]/u.test(token);
  const digits = /[0-9]/u.test(token);
  if (token.includes("-")) {
    // A group of digits only is a range or a version, as in "8000-9000".
    if (!letters) return false;
    // GitHub's WDJB-MJHT form is all letters; a sign-in line says so, "READ-ONLY" does not.
    return digits || SIGN_IN_LINE.test(line);
  }
  // A single group: a code has a digit, or is an all-letter code a sign-in line asks for.
  return digits || SIGN_IN_LINE.test(line);
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly segment: TerminalTextSegment;
}

function lineMatches(line: string, offset: number): Match[] {
  const matches: Match[] = [];
  for (const found of line.matchAll(URL_PATTERN)) {
    if (matches.length >= MAX_LINE_MATCHES) break;
    const text = balancedUrl(found[0]);
    const url = safeTerminalUrl(text);
    if (!url) continue;
    const start = offset + found.index;
    matches.push({ start, end: start + text.length, segment: { kind: "url", text, url } });
  }
  if (CODE_LINE.test(line)) {
    const taken = (start: number, end: number) =>
      matches.some((match) => start < match.end && end > match.start);
    const addCode = (text: string, start: number) => {
      if (matches.length >= MAX_LINE_MATCHES) return;
      if (!isCode(text, line) || taken(start, start + text.length)) return;
      matches.push({ start, end: start + text.length, segment: { kind: "code", text } });
    };
    for (const found of line.matchAll(GROUPED_CODE)) addCode(found[0], offset + found.index);
    for (const found of line.matchAll(CODE_AFTER_KEYWORD)) {
      const code = found[1]!;
      addCode(code, offset + found.index + found[0].indexOf(code));
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Splits shown terminal text into plain text, links and codes, keeping every character. */
export function terminalTextSegments(text: string): TerminalTextSegment[] {
  const segments: TerminalTextSegment[] = [];
  // A cut inside a line could match a cut URL, so the scan ends at a whole line.
  const scanned =
    text.length > MAX_SCAN ? text.slice(0, text.lastIndexOf("\n", MAX_SCAN) + 1) : text;
  let cursor = 0;
  let lineStart = 0;
  for (const line of scanned.split("\n")) {
    for (const match of lineMatches(line, lineStart)) {
      if (match.start < cursor || segments.length >= MAX_SEGMENTS) continue;
      if (match.start > cursor)
        segments.push({ kind: "text", text: text.slice(cursor, match.start) });
      segments.push(match.segment);
      cursor = match.end;
    }
    lineStart += line.length + 1;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** The sign-in links and codes worth a button above the output, newest last, at most three each. */
export function terminalActions(text: string): TerminalActions {
  const links: string[] = [];
  const codes: string[] = [];
  // The tail starts at a whole line; a single huge line is not scanned at all.
  const tailStart = text.length > MAX_SCAN ? text.indexOf("\n", text.length - MAX_SCAN) : -1;
  const scanned =
    text.length <= MAX_SCAN ? text : tailStart === -1 ? "" : text.slice(tailStart + 1);
  for (const line of scanned.split("\n")) {
    const prompt = PROMPT_LINE.test(line) || CODE_LINE.test(line);
    for (const match of lineMatches(line, 0)) {
      if (match.segment.kind === "code") codes.push(match.segment.text);
      else if (match.segment.kind === "url" && prompt) links.push(match.segment.url);
    }
  }
  // The newest copy of each, in the order they appeared.
  const latest = (values: string[]) =>
    [...new Set(values.toReversed())].slice(0, MAX_ACTIONS).toReversed();
  return { links: latest(links), codes: latest(codes) };
}
