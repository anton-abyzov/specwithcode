/**
 * Splits knowledge text into search passages. Markdown splits at headings
 * outside fenced code and keeps each passage's heading breadcrumb; short
 * sections merge into the next one and long ones split at paragraph, then
 * line boundaries. Offsets index the original string, so a passage is always
 * `content.slice(start, end)`.
 */

export type KnowledgeChunk = {
  /** Heading breadcrumb such as `Approach > Storage`; empty before the first heading. */
  readonly heading: string;
  readonly start: number;
  readonly end: number;
};

const TARGET = 1_600;
const MAX = 2_400;
const MIN = 300;

type Section = { path: string; start: number; end: number };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Only the opening `#` run is matched by pattern; the rest of the line is cut by hand, so no line backtracks. */
const HEADING_START = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
/** Longest heading text kept for a breadcrumb or a title. */
const HEADING_TEXT = 180;

/** `text` cut to at most `max` UTF-16 units, never inside a surrogate pair. */
function cutText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, safeCut(text, max));
}

/** A line without its line break; CRLF files keep a carriage return before each `\n`. */
function lineText(content: string, start: number, end: number): string {
  return content.charCodeAt(end - 1) === 13
    ? content.slice(start, end - 1)
    : content.slice(start, end);
}

/** An ATX heading's level and text, without its optional closing `#` run; null for other lines. */
function parseHeading(line: string): { level: number; text: string } | null {
  const opening = HEADING_START.exec(line);
  if (!opening) return null;
  let text = line.slice(opening[0].length).trim();
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 35) end -= 1;
  // A closing run counts only when it stands alone or after a space, as in `# C#` it does not.
  if (end === 0) text = "";
  else if (end < text.length && /[ \t]/.test(text[end - 1]!)) text = text.slice(0, end).trim();
  return { level: opening[1]!.length, text: cutText(text, HEADING_TEXT) };
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1))
    starts.push(index + 1);
  return starts;
}

function markdownSections(content: string): Section[] {
  const starts = lineStarts(content);
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let fence: string | null = null;
  let current: Section = { path: "", start: 0, end: content.length };
  for (const start of starts) {
    const newline = content.indexOf("\n", start);
    const line = lineText(content, start, newline === -1 ? content.length : newline);
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = parseHeading(line);
    if (!heading?.text) continue;
    const { level, text } = heading;
    if (start > current.start) {
      sections.push({ ...current, end: start });
    }
    while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop();
    stack.push({ level, text });
    current = { path: stack.map((entry) => entry.text).join(" > "), start, end: content.length };
  }
  sections.push({ ...current, end: content.length });
  return sections.filter((section) => content.slice(section.start, section.end).trim() !== "");
}

/** Paragraph boundaries outside fenced code, as offsets where a new block starts. */
function blockStarts(content: string, start: number, end: number, markdown: boolean): number[] {
  const boundaries: number[] = [];
  let fence: string | null = null;
  let blank = false;
  for (let lineStart = start; lineStart < end;) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline >= end ? end : newline + 1;
    const line = content.slice(lineStart, lineEnd);
    const fenceMatch = markdown ? FENCE.exec(line) : null;
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) {
        if (blank && lineStart > start) boundaries.push(lineStart);
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      blank = false;
    } else if (fence === null) {
      const isBlank = line.trim() === "";
      if (!isBlank && blank && lineStart > start) boundaries.push(lineStart);
      blank = isBlank;
    }
    lineStart = lineEnd;
  }
  return boundaries;
}

function lineBoundaries(content: string, start: number, end: number): number[] {
  const boundaries: number[] = [];
  for (
    let index = content.indexOf("\n", start);
    index !== -1 && index + 1 < end;
    index = content.indexOf("\n", index + 1)
  )
    boundaries.push(index + 1);
  return boundaries;
}

/** A cut that never separates a UTF-16 surrogate pair. */
function safeCut(content: string, at: number): number {
  const code = content.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/** Greedy packing of [start, end) at the given boundaries into pieces of at most MAX. */
function pack(start: number, end: number, boundaries: readonly number[]): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let pieceStart = start;
  let lastCut = start;
  for (const boundary of [...boundaries, end]) {
    if (boundary - pieceStart > MAX && lastCut > pieceStart) {
      pieces.push([pieceStart, lastCut]);
      pieceStart = lastCut;
    }
    lastCut = boundary;
    if (lastCut - pieceStart >= TARGET && lastCut < end) {
      pieces.push([pieceStart, lastCut]);
      pieceStart = lastCut;
    }
  }
  if (end > pieceStart) {
    const last = pieces.at(-1);
    // A short tail joins the piece before it rather than standing alone.
    if (last && end - pieceStart < MIN && end - last[0] <= MAX) last[1] = end;
    else pieces.push([pieceStart, end]);
  }
  return pieces;
}

function split(content: string, section: Section, markdown: boolean): KnowledgeChunk[] {
  if (section.end - section.start <= MAX) return [{ heading: section.path, ...section }];
  const chunks: KnowledgeChunk[] = [];
  for (const [start, end] of pack(
    section.start,
    section.end,
    blockStarts(content, section.start, section.end, markdown),
  )) {
    if (end - start <= MAX) {
      chunks.push({ heading: section.path, start, end });
      continue;
    }
    for (const [lineStart, lineEnd] of pack(start, end, lineBoundaries(content, start, end))) {
      // A single line longer than MAX (minified text, a data URI) is cut hard.
      for (let cut = lineStart; cut < lineEnd;) {
        const next = lineEnd - cut <= MAX ? lineEnd : safeCut(content, cut + MAX);
        chunks.push({ heading: section.path, start: cut, end: next });
        cut = next;
      }
    }
  }
  return chunks;
}

export function chunkKnowledgeText(content: string, markdown: boolean): KnowledgeChunk[] {
  if (content.trim() === "") return [];
  const sections = markdown
    ? markdownSections(content)
    : [{ path: "", start: 0, end: content.length }];
  // Short sections (a title line, a two-line note) merge into the section after them.
  const merged: Section[] = [];
  for (const section of sections) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.end - previous.start < MIN &&
      section.end - previous.start <= MAX &&
      previous.end === section.start
    ) {
      merged[merged.length - 1] = { path: section.path, start: previous.start, end: section.end };
    } else merged.push({ ...section });
  }
  return merged.flatMap((section) => split(content, section, markdown));
}

/** The first top-level heading, used as a document title when the file has one. */
export function markdownTitle(content: string): string | null {
  let fence: string | null = null;
  const lines = content.slice(0, 16_384).split("\n");
  for (const raw of lines.slice(0, 80)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = parseHeading(line);
    if (heading?.level === 1 && heading.text) return heading.text;
  }
  return null;
}
