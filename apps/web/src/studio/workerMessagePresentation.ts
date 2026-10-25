/**
 * How a worker's message to its coordinator reads in the coordinator view.
 * Folded, it shows its opening sentences and the sentence that asks for a
 * decision (a question or a `Blockers:` line), cut from the text itself; the
 * whole message stays one click away. Nothing here rewrites, re-spaces or
 * summarizes the text: words a sender ran together stay run together.
 */

/** The fold a long message already gets on a thread page. */
export const WORKER_MESSAGE_FOLD_CHARACTERS = 600;
export const WORKER_MESSAGE_FOLD_LINES = 8;
/** Whole opening sentences fit in this many characters; one sentence always shows. */
const LEAD_CHARACTERS = 280;
/** A question or Blockers excerpt, in whole sentences where they fit. */
const DECISION_CHARACTERS = 400;
/** Where a sentence too long to show whole is cut, at a space. */
const CUT_CHARACTERS = 240;
/** Folding saves nothing when the excerpt is already most of the message. */
const MOST_OF_MESSAGE = 0.8;

export const ELLIPSIS = "…";

export interface WorkerMessagePresentation {
  /**
   * Verbatim excerpts shown while folded, joined with an ellipsis where text
   * is left out; null when the message shows whole.
   */
  readonly excerpt: string | null;
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

/** The last space before `limit` outside brackets and code, or -1. */
function safeCut(text: string, span: Span, limit: number): number {
  let depth = 0;
  let code = false;
  let cut = -1;
  for (let index = span.start; index < Math.min(span.end, span.start + limit); index++) {
    const char = text[index]!;
    if (char === "`") code = !code;
    if (code) continue;
    if (char === "[" || char === "(") depth++;
    else if ((char === "]" || char === ")") && depth > 0) depth--;
    else if (depth === 0 && /\s/.test(char)) cut = index;
  }
  return cut;
}

/** Whole sentences from `first` that fit `limit`; a longer first sentence is cut at a space. */
function excerptFrom(
  text: string,
  sentences: readonly Span[],
  first: number,
  limit: number,
): (Span & { readonly cut: boolean }) | null {
  const head = sentences[first]!;
  if (head.end - head.start > limit) {
    const cut = safeCut(text, head, CUT_CHARACTERS);
    return cut <= head.start ? null : { start: head.start, end: cut, cut: true };
  }
  let end = head.end;
  for (let index = first + 1; index < sentences.length; index++) {
    if (sentences[index]!.end - head.start > limit) break;
    end = sentences[index]!.end;
  }
  return { start: head.start, end, cut: false };
}

export function workerMessagePresentation(
  original: string,
  text: string = original,
): WorkerMessagePresentation {
  const characters = Array.from(original).length;
  const lines = original.split("\n").length;
  const whole = { excerpt: null, characters, lines, hidden: 0 };
  if (characters <= WORKER_MESSAGE_FOLD_CHARACTERS && lines <= WORKER_MESSAGE_FOLD_LINES)
    return whole;
  const blocks = blocksOf(text);
  const sentences = blocks
    .filter((block) => block.kind === "prose")
    .flatMap((block) => sentencesOf(text, block));
  const leadBlock = blocks.find((block) => block.kind === "prose");
  if (leadBlock === undefined || sentences.length === 0) return whole;
  const leadSentences = sentences.filter((sentence) => sentence.end <= leadBlock.end);
  const lead = excerptFrom(text, leadSentences, 0, LEAD_CHARACTERS);
  if (lead === null) return whole;
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
    const own =
      asked === decision
        ? sentences.filter((sentence) => sentence.end <= block.end)
        : [sentences[asked]!];
    const piece = excerptFrom(text, own, own.indexOf(sentences[asked]!), DECISION_CHARACTERS);
    if (piece !== null) pieces.push(piece);
  }
  let excerpt = "";
  let shown = 0;
  let previous: (Span & { readonly cut: boolean }) | null = null;
  for (const piece of pieces) {
    const gap = previous === null ? "" : text.slice(previous.end, piece.start);
    if (previous !== null)
      excerpt +=
        !previous.cut && gap.trim() === "" && !gap.includes("\n\n") ? gap : ` ${ELLIPSIS} `;
    excerpt += text.slice(piece.start, piece.end);
    shown += Array.from(text.slice(piece.start, piece.end)).length;
    previous = piece;
  }
  if (text.slice(previous!.end).trim() !== "") excerpt += previous!.cut ? ELLIPSIS : ` ${ELLIPSIS}`;
  if (shown >= Array.from(text.trim()).length * MOST_OF_MESSAGE) return whole;
  // Counted against the message as sent; display links can make `text` longer.
  return { excerpt, characters, lines, hidden: Math.max(0, characters - shown) };
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
  const hidden = presentation.hidden;
  return `${hidden.toLocaleString("en-US")} more ${hidden === 1 ? "character" : "characters"}`;
}
