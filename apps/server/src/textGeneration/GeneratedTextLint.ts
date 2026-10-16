/**
 * A cheap, deterministic style pass over text the app writes itself: commit
 * messages, pull request titles and bodies, and thread titles. No model runs.
 * `cleanGeneratedText` removes agent credits, chatbot sign-offs and robot
 * emoji, straightens curly quotes and replaces em and en dashes.
 * `lintGeneratedText` reports what is left, such as chatbot phrasing inside a
 * sentence, which a regex cannot rewrite safely.
 *
 * Code fences, indented code, inline code, URLs and block quotes are never changed.
 *
 * The checks follow rules 13, 18, 19, 20 and 22 of unslop by Lauren Tan
 * (pstack, MIT). See third-party-licenses.config.json.
 *
 * @module textGeneration/GeneratedTextLint
 */
import {
  isAgentCreditLine,
  literalMarkdownLines,
  removeAgentCredits,
} from "../pullRequest/mergeMessage.ts";

export type GeneratedTextIssueKind =
  | "ai-attribution"
  | "em-dash"
  | "en-dash"
  | "curly-quote"
  | "chatbot-phrase";

export interface GeneratedTextIssue {
  readonly kind: GeneratedTextIssueKind;
  /** The text that matched. */
  readonly text: string;
  /** 1-based line number. */
  readonly line: number;
}

const ROBOT = /\u{1F916}️?[ \t]*/gu;
const PICTOGRAPH = /\p{Extended_Pictographic}️?/gu;
const CURLY_SINGLE = /[‘’‚‛]/g;
const CURLY_DOUBLE = /[“”„‟]/g;
const EM_DASH = /[—―]/g;
const EN_DASH = /–/g;
const BULLET_DASH = /^([ \t]*)[–—―](?=[ \t])/;
const NUMERIC_RANGE = /(\d)[ \t]*[–—][ \t]*(?=\d)/g;
const SENTENCE_DASH = /[ \t]*[—―][ \t]*|[ \t]+–[ \t]+/g;
// Inline code spans and URLs, which keep every character, including an en dash in a link.
const LITERAL_SPAN = /(?<!`)(`+)(?!`)(.*?[^`])\1(?!`)|\bhttps?:\/\/[^\s<>()[\]]+/g;
const BLOCK_QUOTE = /^ {0,3}>/;

const CHATBOT_PHRASE =
  /\b(?:I hope (?:this|that) helps|hope (?:this|that) helps|let me know if|happy coding|great question|you(?:'|’| a)re absolutely right|as an AI\b(?: language model)?|as a large language model|I(?:'|’)d be happy to|I(?:'|’)m happy to help)|\b(?:certainly|of course|absolutely)!/gi;
// A whole line that only signs off, such as "I hope this helps!" or "Let me know if you have questions."
const SIGN_OFF_LINE =
  /^(?:(?:i hope (?:this|that) helps|hope (?:this|that) helps|happy coding|let me know if (?:you (?:have|need|want|would like|(?:'|’)d like)|there(?:(?:'|’)s| is) anything|anything else)[^.!?;:]*|certainly|of course|absolutely|sure|great question)[.!?]*[ \t]*)+$/i;
// An opener such as "Certainly! " in front of the real content.
const OPENER =
  /^([ \t]*(?:[-*][ \t]+)?)(?:certainly|of course|absolutely|sure|great question)![ \t]+/i;

interface Segment {
  readonly text: string;
  readonly code: boolean;
}

/** Splits a line into prose and literal spans (inline code, URLs), so literals stay byte for byte. */
function splitLiteralSpans(line: string): ReadonlyArray<Segment> {
  const segments: Array<Segment> = [];
  let last = 0;
  for (const match of line.matchAll(LITERAL_SPAN)) {
    if (match.index > last) segments.push({ text: line.slice(last, match.index), code: false });
    segments.push({ text: match[0], code: true });
    last = match.index + match[0].length;
  }
  if (last < line.length || segments.length === 0) {
    segments.push({ text: line.slice(last), code: false });
  }
  return segments;
}

/** Replaces a sentence dash with the punctuation a person would type. */
function replaceSentenceDash(
  match: string,
  offset: number,
  whole: string,
  edges: { readonly lineStart: boolean; readonly lineEnd: boolean },
): string {
  const before = whole.slice(0, offset);
  const after = whole.slice(offset + match.length);
  const nothingBefore = before.trim() === "";
  const nothingAfter = after.trim() === "";
  if (nothingBefore && edges.lineStart) return "";
  if (nothingAfter && edges.lineEnd) return "";
  // A table cell: a lone dash is an empty-value placeholder; at a cell edge it is dropped.
  const cellStart = before.endsWith("|");
  const cellEnd = after.startsWith("|");
  if (cellStart && cellEnd) return " - ";
  if (cellStart || cellEnd) return " ";
  if (/^[,.;:!?)\]]/.test(after)) return "";
  if (/[([]$/.test(before)) return "";
  if (/[,.;:!?]$/.test(before)) return " ";
  return ", ";
}

function normalizeProse(
  text: string,
  edges: { readonly lineStart: boolean; readonly lineEnd: boolean },
): string {
  let result = text
    .replace(ROBOT, "")
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(NUMERIC_RANGE, "$1-");
  if (edges.lineStart) result = result.replace(BULLET_DASH, "$1-");
  result = result.replace(SENTENCE_DASH, (match: string, offset: number, whole: string) =>
    replaceSentenceDash(match, offset, whole, edges),
  );
  return result.replace(EN_DASH, "-");
}

function normalizeLine(line: string): string {
  const segments = splitLiteralSpans(line.replace(OPENER, "$1"));
  return segments
    .map((segment, index) =>
      segment.code
        ? segment.text
        : normalizeProse(segment.text, {
            lineStart: index === 0,
            lineEnd: index === segments.length - 1,
          }),
    )
    .join("");
}

function isProseLine(line: string, literal: boolean | undefined): boolean {
  return literal !== true && !BLOCK_QUOTE.test(line);
}

function isSignOffLine(line: string): boolean {
  const text = line
    .replace(PICTOGRAPH, "")
    .trim()
    .replace(/^(?:[-*][ \t]+)/, "");
  return text.length > 0 && SIGN_OFF_LINE.test(text);
}

/**
 * Removes agent credits and chatbot sign-off lines, straightens curly quotes
 * and replaces em and en dashes in prose. Returns `text` unchanged when there
 * is nothing to fix.
 */
export function cleanGeneratedText(text: string): string {
  const credited = removeAgentCredits(text);
  const newline = credited.includes("\r\n") ? "\r\n" : "\n";
  const lines = credited.split(/\r?\n/);
  const literal = literalMarkdownLines(lines);
  const kept: Array<string> = [];
  let removedLine = credited !== text;
  let skipBlank = false;
  lines.forEach((line, index) => {
    if (!isProseLine(line, literal[index])) {
      kept.push(line);
      skipBlank = false;
      return;
    }
    if (isSignOffLine(line)) {
      removedLine = true;
      skipBlank = kept.length === 0 || kept[kept.length - 1]!.trim() === "";
      return;
    }
    const normalized = normalizeLine(line);
    if (normalized.trim() === "" && line.trim() !== "") {
      // The line held only a robot emoji or a dash.
      removedLine = true;
      skipBlank = kept.length === 0 || kept[kept.length - 1]!.trim() === "";
      return;
    }
    if (skipBlank && normalized.trim() === "") return;
    skipBlank = false;
    kept.push(normalized);
  });
  const joined = kept.join(newline);
  return removedLine
    ? joined.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "")
    : joined;
}

/**
 * Reports agent credits, em and en dashes, curly quotes and chatbot phrases in
 * prose. Run it after `cleanGeneratedText` to see what the cleanup could not fix.
 */
export function lintGeneratedText(text: string): ReadonlyArray<GeneratedTextIssue> {
  const issues: Array<GeneratedTextIssue> = [];
  const lines = text.split(/\r?\n/);
  const literal = literalMarkdownLines(lines);
  lines.forEach((line, index) => {
    if (!isProseLine(line, literal[index])) return;
    const number = index + 1;
    if (isAgentCreditLine(line) || line.includes("\u{1F916}")) {
      issues.push({ kind: "ai-attribution", text: line.trim(), line: number });
    }
    const prose = splitLiteralSpans(line)
      .filter((segment) => !segment.code)
      .map((segment) => segment.text)
      .join(" ");
    const checks: ReadonlyArray<readonly [GeneratedTextIssueKind, RegExp]> = [
      ["em-dash", EM_DASH],
      ["en-dash", EN_DASH],
      ["curly-quote", CURLY_SINGLE],
      ["curly-quote", CURLY_DOUBLE],
      ["chatbot-phrase", CHATBOT_PHRASE],
    ];
    for (const [kind, pattern] of checks) {
      for (const match of prose.matchAll(pattern)) {
        issues.push({ kind, text: match[0], line: number });
      }
    }
  });
  return issues;
}
