/**
 * How a worker's message to its coordinator reads in the coordinator view.
 * Folded, it shows its opening sentences and the sentence that asks for a
 * decision (a question or a `Blockers:` line), cut from the text itself; the
 * whole message stays one click away. Nothing here rewrites, re-spaces or
 * summarizes the text: words a sender ran together stay run together.
 */

import type { TimelineDetail } from "@specweave-studio/contracts";

/** The fold a long message already gets on a thread page. */
export const WORKER_MESSAGE_FOLD_CHARACTERS = 600;
export const WORKER_MESSAGE_FOLD_LINES = 8;
/** Whole opening sentences fit in this many characters; one sentence always shows. */
const LEAD_CHARACTERS = 280;

/** When a message folds and how long its lead may be, by timeline detail. */
interface FoldBudget {
  readonly characters: number;
  readonly lines: number;
  readonly lead: number;
}

const NORMAL_FOLD: FoldBudget = {
  characters: WORKER_MESSAGE_FOLD_CHARACTERS,
  lines: WORKER_MESSAGE_FOLD_LINES,
  lead: LEAD_CHARACTERS,
};

/**
 * Concise promises about a line per finished turn, so a message folds sooner
 * and leads with less. Verbose folds as Normal does; its body opens instead.
 */
const FOLD_BUDGETS: Record<TimelineDetail, FoldBudget> = {
  concise: { characters: 280, lines: 3, lead: 160 },
  normal: NORMAL_FOLD,
  verbose: NORMAL_FOLD,
};
/** A question or Blockers excerpt, in whole sentences where they fit. */
const DECISION_CHARACTERS = 400;
/** Where a sentence too long to show whole is cut, at a space. */
const CUT_CHARACTERS = 240;
/** Folding saves nothing when the excerpt is already most of the message. */
const MOST_OF_MESSAGE = 0.8;
/** Nor when it hides less than its own footer row of controls would show. */
const LEAST_HIDDEN = 100;

export const ELLIPSIS = "…";
/** Keeps the ellipsis on the line of the word before it. */
const NO_BREAK_SPACE = "\u00A0";

export interface WorkerMessagePresentation {
  /**
   * Verbatim excerpts shown while folded, joined with an ellipsis where text
   * is left out; null when the message shows whole.
   */
  readonly excerpt: string | null;
  /**
   * Over the fold with no verbatim opening to show (only JSON or a code fence,
   * or an opening that cannot be cut at a space): folded, the message's top is
   * clipped instead. The text is still never rewritten.
   */
  readonly clamp: boolean;
  readonly characters: number;
  readonly lines: number;
  /** Characters of the message the folded view leaves out. */
  readonly hidden: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Block extends Span {
  readonly kind: "prose" | "heading" | "json";
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s/;
const BLOCKERS = /^(?:\*\*|__)?blockers?:/i;
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/i;
const QUESTION = /\?["'”’)*_]*$/;
/**
 * A line that starts its own paragraph inside a run of lines: a list item at
 * any depth of nesting, a table row, a quote or a heading.
 */
const OWN_PARAGRAPH_LINE = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}[|>#])/;
const CLOSERS = new Set(['"', "'", "”", "’", ")", "*", "_"]);

function isJsonText(text: string): boolean {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

/** Runs of non-blank lines outside code fences, with fences left out entirely. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let fence: string | null = null;
  let start = -1;
  let end = -1;
  const close = () => {
    if (start === -1) return;
    const body = text.slice(start, end);
    blocks.push({ start, end, kind: isJsonText(body) ? "json" : "prose" });
    start = -1;
  };
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      close();
      fence = marker;
      continue;
    }
    if (line.trim() === "") {
      close();
      continue;
    }
    if (HEADING.test(line)) {
      close();
      blocks.push({ start: lineStart, end: lineEnd, kind: "heading" });
      continue;
    }
    if (start === -1) start = lineStart;
    end = lineEnd;
  }
  close();
  return blocks;
}

/**
 * For each offset in the block, how far brackets still close after it: the
 * most closings net of openings from there to the block's end. A line break
 * at `depth` with at least that much still to close sits inside a bracket
 * that closes later. One pass each way, however long the block.
 */
function closingsAhead(text: string, block: Span): Int32Array {
  const length = block.end - block.start;
  const balance = new Int32Array(length + 1);
  let code = false;
  for (let offset = 0; offset < length; offset++) {
    const char = text[block.start + offset]!;
    if (char === "`") code = !code;
    const step = code
      ? 0
      : char === "]" || char === ")"
        ? 1
        : char === "[" || char === "("
          ? -1
          : 0;
    balance[offset + 1] = balance[offset]! + step;
  }
  const ahead = new Int32Array(length + 1);
  let highest = balance[length]!;
  for (let offset = length; offset >= 0; offset--) {
    highest = Math.max(highest, balance[offset]!);
    ahead[offset] = highest - balance[offset]!;
  }
  return ahead;
}

/**
 * Sentences of one block: they end at `.`, `!` or `?` before a space, or at a
 * line end, never inside brackets, parentheses or code, so a link or a code
 * span is never cut, even where its label wraps onto the next line.
 */
function sentencesOf(text: string, block: Span): Span[] {
  const sentences: Span[] = [];
  const ahead = closingsAhead(text, block);
  let depth = 0;
  let code = false;
  let start = block.start;
  const push = (end: number) => {
    let from = start;
    while (from < end && /\s/.test(text[from]!)) from++;
    if (from < end) sentences.push({ start: from, end });
    start = end;
  };
  for (let index = block.start; index < block.end; index++) {
    const char = text[index]!;
    if (char === "`") code = !code;
    if (code) continue;
    if (char === "[" || char === "(") depth++;
    else if ((char === "]" || char === ")") && depth > 0) depth--;
    else if (char === "\n") {
      if (depth > 0 && ahead[index - block.start]! >= depth) continue;
      push(index);
      depth = 0;
    } else if (depth === 0 && (char === "." || char === "!" || char === "?")) {
      let end = index + 1;
      while (end < block.end && CLOSERS.has(text[end]!)) end++;
      const next = text[end];
      if (end < block.end && next !== " " && next !== "\t" && next !== "\n") continue;
      if (char === "." && ABBREVIATION.test(text.slice(start, index + 1))) continue;
      push(end);
      index = end - 1;
    }
  }
  push(block.end);
  return sentences;
}

/**
 * The bold runs of a paragraph, each from its opening `**` or `__` to the end
 * of its closer, paired as CommonMark pairs them. A run with no closer (a glob
 * `src/**`, `**kwargs`, `__dirname`) or one that cannot open (`2 ** n`,
 * `gate__runner`) is literal text and pairs with nothing.
 */
function boldRunsOf(text: string, block: Span): Span[] {
  const runs: Span[] = [];
  // Open delimiters by kind, each list in text order.
  const openers: Record<"*" | "_", number[]> = { "*": [], _: [] };
  const space = (char: string | undefined) => char === undefined || /\s/.test(char);
  const mark = (char: string | undefined) => char !== undefined && /[\p{P}\p{S}]/u.test(char);
  let code = false;
  for (let index = block.start; index < block.end - 1; index++) {
    // A list item, table row, quote or heading line is a paragraph of its own; bold never crosses into it.
    if (
      (index === block.start || text[index - 1] === "\n") &&
      OWN_PARAGRAPH_LINE.test(text.slice(index, lineEnd(text, index, block.end)))
    ) {
      openers["*"].length = 0;
      openers._.length = 0;
      code = false;
    }
    const char = text[index]!;
    if (char === "`") code = !code;
    if (code || (char !== "*" && char !== "_") || text[index + 1] !== char) continue;
    const before = index > block.start ? text[index - 1] : undefined;
    const after = index + 2 < block.end ? text[index + 2] : undefined;
    // CommonMark's flanking rules, where a start or end of text counts as a space.
    const left = !space(after) && (!mark(after) || space(before) || mark(before));
    const right = !space(before) && (!mark(before) || space(after) || mark(after));
    const canOpen = char === "*" ? left : left && (!right || mark(before));
    const canClose = char === "*" ? right : right && (!left || mark(after));
    const own = openers[char];
    const other = openers[char === "*" ? "_" : "*"];
    if (canClose && own.length > 0) {
      const start = own.pop()!;
      runs.push({ start, end: index + 2 });
      // Delimiters opened inside the run can no longer close past it.
      while (other.length > 0 && other[other.length - 1]! > start) other.pop();
    } else if (canOpen) own.push(index);
    index++;
  }
  return runs;
}

/** The end of the line `index` is on, within `end`. */
function lineEnd(text: string, index: number, end: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 || newline > end ? end : newline;
}

/**
 * A message's bold runs, and the outermost of them in text order. Runs nest
 * or stay apart, so a point inside any run is inside an outermost one.
 */
interface Bold {
  readonly runs: readonly Span[];
  readonly outer: readonly Span[];
}

const NO_BOLD: Bold = { runs: [], outer: [] };

function boldOf(runs: readonly Span[]): Bold {
  const outer: Span[] = [];
  for (const run of [...runs].sort((a, b) => a.start - b.start || b.end - a.end))
    if (outer.length === 0 || run.start >= outer[outer.length - 1]!.end) outer.push(run);
  return { runs, outer };
}

/** Whether `index` falls strictly inside a bold run, so cutting there would leave it open. */
function insideBold(bold: Bold, index: number): boolean {
  let low = 0;
  let high = bold.outer.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bold.outer[middle]!.start < index) low = middle + 1;
    else high = middle;
  }
  return low > 0 && index < bold.outer[low - 1]!.end;
}

/**
 * The last space before `limit` outside brackets, code and bold, or -1, so a
 * cut never leaves a link, code span or bold run open.
 */
function safeCut(text: string, span: Span, limit: number, bold: Bold): number {
  let depth = 0;
  let code = false;
  let cut = -1;
  for (let index = span.start; index < Math.min(span.end, span.start + limit); index++) {
    const char = text[index]!;
    if (char === "`") code = !code;
    if (code) continue;
    if (char === "[" || char === "(") depth++;
    else if ((char === "]" || char === ")") && depth > 0) depth--;
    else if (depth === 0 && /\s/.test(char) && !insideBold(bold, index)) cut = index;
  }
  return cut;
}

/**
 * Whole sentences from `first` that fit `limit` (only the first one unless
 * `more`), ending outside any bold run; a longer first sentence is cut at a
 * space. Nothing before `floor`, the end of an earlier piece, shows again.
 */
function excerptFrom(
  text: string,
  sentences: readonly Span[],
  first: number,
  limit: number,
  bold: Bold,
  more = true,
  floor = 0,
): (Span & { readonly cut: boolean }) | null {
  // A bold run across sentences reads as one: the head starts at its opener
  // and runs to the sentence that closes it.
  let headStart = sentences[first]!.start;
  for (const run of bold.runs)
    if (floor <= run.start && run.start < headStart && headStart < run.end) headStart = run.start;
  let next = first + 1;
  let headEnd = sentences[first]!.end;
  while (insideBold(bold, headEnd) && next < sentences.length) headEnd = sentences[next++]!.end;
  const head = { start: headStart, end: headEnd };
  if (head.end - head.start > limit) {
    const window = Math.min(CUT_CHARACTERS, limit);
    // The last space in the window it may cut at; a short lead (Concise) that
    // would keep under half its window looks as far as Normal does.
    const cutAt = (runs: Bold) => {
      const cut = safeCut(text, head, window, runs);
      return limit < CUT_CHARACTERS && cut - head.start < limit / 2
        ? Math.max(cut, safeCut(text, head, CUT_CHARACTERS, runs))
        : cut;
    };
    // A short lead that would fold to a word shows the whole head when it fits Normal's window.
    if (
      limit < CUT_CHARACTERS &&
      head.end - head.start <= CUT_CHARACTERS &&
      safeCut(text, head, window, bold) - head.start < limit / 2
    )
      return { ...head, cut: false };
    let cut = cutAt(bold);
    // Bold that leaves under half the window gives way to the plain cut:
    // one literal `**` reads better than a lead of a word.
    if (cut - head.start < window / 2) cut = Math.max(cut, cutAt(NO_BOLD));
    return cut <= head.start ? null : { start: head.start, end: cut, cut: true };
  }
  let end = head.end;
  for (let index = next; more && index < sentences.length; index++) {
    if (sentences[index]!.end - head.start > limit) break;
    if (!insideBold(bold, sentences[index]!.end)) end = sentences[index]!.end;
  }
  return { start: head.start, end, cut: false };
}

export function workerMessagePresentation(
  original: string,
  text: string = original,
  detail: TimelineDetail = "normal",
): WorkerMessagePresentation {
  const budget = FOLD_BUDGETS[detail];
  const characters = Array.from(original).length;
  const lines = original.split("\n").length;
  const whole = { excerpt: null, clamp: false, characters, lines, hidden: 0 };
  // Blank lines between paragraphs take no reading, so they do not count.
  const textLines = original.split("\n").filter((line) => line.trim() !== "").length;
  if (characters <= budget.characters && textLines <= budget.lines) return whole;
  // Clipping is for a long message: a short JSON object or log stays whole.
  const clipped = characters > budget.characters ? { ...whole, clamp: true } : whole;
  const blocks = blocksOf(text);
  const sentences = blocks
    .filter((block) => block.kind === "prose")
    .flatMap((block) => sentencesOf(text, block));
  const bold = boldOf(
    blocks.filter((block) => block.kind === "prose").flatMap((block) => boldRunsOf(text, block)),
  );
  const leadBlock = blocks.find((block) => block.kind === "prose");
  if (leadBlock === undefined || sentences.length === 0) return clipped;
  const leadSentences = sentences.filter((sentence) => sentence.end <= leadBlock.end);
  const lead = excerptFrom(text, leadSentences, 0, budget.lead, bold);
  if (lead === null) return clipped;
  const pieces = [lead];
  // The sentence asking for a decision shows too: a Blockers line, else the first question.
  const decision = sentences.findIndex((sentence) =>
    BLOCKERS.test(text.slice(sentence.start, sentence.end)),
  );
  const question = sentences.findIndex(
    (sentence) =>
      sentence.start >= lead.end && QUESTION.test(text.slice(sentence.start, sentence.end)),
  );
  const asked = decision !== -1 ? decision : question;
  if (asked !== -1 && sentences[asked]!.start >= lead.end) {
    const block = blocks.find(
      (candidate) =>
        candidate.start <= sentences[asked]!.start && sentences[asked]!.end <= candidate.end,
    )!;
    // A Blockers line keeps the rest of its paragraph (the options); a question is one sentence.
    const own = sentences.filter((sentence) => sentence.end <= block.end);
    const piece = excerptFrom(
      text,
      own,
      own.indexOf(sentences[asked]!),
      DECISION_CHARACTERS,
      bold,
      asked === decision,
      lead.end,
    );
    if (piece !== null) pieces.push(piece);
  }
  let excerpt = "";
  let shown = 0;
  let previous: (Span & { readonly cut: boolean }) | null = null;
  for (const piece of pieces) {
    const gap = previous === null ? "" : text.slice(previous.end, piece.start);
    if (previous !== null)
      excerpt +=
        !previous.cut && gap.trim() === "" && !gap.includes("\n\n")
          ? gap
          : `${NO_BREAK_SPACE}${ELLIPSIS} `;
    excerpt += text.slice(piece.start, piece.end);
    shown += Array.from(text.slice(piece.start, piece.end)).length;
    previous = piece;
  }
  if (text.slice(previous!.end).trim() !== "")
    excerpt += previous!.cut ? ELLIPSIS : `${NO_BREAK_SPACE}${ELLIPSIS}`;
  const total = Array.from(text.trim()).length;
  if (shown >= total * MOST_OF_MESSAGE || total - shown < LEAST_HIDDEN) return whole;
  // Counted against the message as sent; display links can make `text` longer.
  return { excerpt, clamp: false, characters, lines, hidden: Math.max(0, characters - shown) };
}

/**
 * The message with each block that parses as JSON shown as a `json` code
 * block, its bytes unchanged. Text that only looks like an object
 * (`{type:'worktree'}`) is not JSON and stays prose, as do fences the sender
 * already wrote.
 */
export function formatJsonBlocks(text: string): string {
  const json = blocksOf(text).filter((block) => block.kind === "json");
  if (json.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const block of json) {
    out += `${text.slice(cursor, block.start)}\`\`\`json\n${text.slice(block.start, block.end)}\n\`\`\``;
    cursor = block.end;
  }
  return out + text.slice(cursor);
}

/** How much a folded message leaves out, as its fold says it. */
export function workerMessageSizeLabel(presentation: WorkerMessagePresentation): string {
  // A clipped message hides an unknown part of itself: name its whole size.
  if (presentation.clamp) {
    const count = presentation.characters;
    return `${count.toLocaleString("en-US")} ${count === 1 ? "character" : "characters"}`;
  }
  const hidden = presentation.hidden;
  return `${hidden.toLocaleString("en-US")} more ${hidden === 1 ? "character" : "characters"}`;
}
