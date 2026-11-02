import { diffArrays } from "diff";

/**
 * Three-way merge of one memory file, line by line. Edits that do not touch the
 * same lines merge on their own, and two insertions at one place keep both. A
 * real clash stays in the one file between conflict markers for the coordinator
 * to tidy. The sides are always passed in the same order (`canonicalSides`), so
 * both machines of a pair write the same bytes.
 */
export interface MemorySide {
  readonly label: string;
  readonly content: string;
}

interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: ReadonlyArray<string>;
}

/** Past this many edits a file is treated as rewritten, which keeps a merge fast. */
const MAX_EDITS = 4_000;
const CLASH_MARKERS = /^<{7} [^\n]*\n(?:[^\n]*\n)*?={7}\r?\n(?:[^\n]*\n)*?>{7} /m;

const toLines = (text: string): ReadonlyArray<string> =>
  text === "" ? [] : text.split(/(?<=\n)/u);
const endLine = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

export const hasClashMarkers = (content: string) => CLASH_MARKERS.test(content);

const clash = (left: MemorySide, right: MemorySide) =>
  `<<<<<<< ${left.label}\n${endLine(left.content)}=======\n${endLine(right.content)}>>>>>>> ${right.label}\n`;

function hunksOf(
  base: ReadonlyArray<string>,
  side: ReadonlyArray<string>,
): ReadonlyArray<Hunk> | null {
  const changes = diffArrays([...base], [...side], { maxEditLength: MAX_EDITS });
  if (!changes) return null;
  const hunks: Hunk[] = [];
  let index = 0;
  let open: { start: number; end: number; lines: string[] } | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (open) hunks.push(open);
      open = null;
      index += change.count ?? change.value.length;
      continue;
    }
    open ??= { start: index, end: index, lines: [] };
    if (change.added) open.lines.push(...change.value);
    else {
      index += change.count ?? change.value.length;
      open.end = index;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

/** `hunks` applied to the base lines from `start` up to `end`. */
function applied(
  base: ReadonlyArray<string>,
  start: number,
  end: number,
  hunks: ReadonlyArray<Hunk>,
): string {
  const out: string[] = [];
  let at = start;
  for (const hunk of hunks) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out.join("");
}

/** With no base to compare against (`null`), differing sides are one clash. */
export function mergeThreeWay(base: string | null, left: MemorySide, right: MemorySide): string {
  if (left.content === right.content) return left.content;
  if (base === null) return clash(left, right);
  const baseLines = toLines(base);
  const leftHunks = hunksOf(baseLines, toLines(left.content));
  const rightHunks = hunksOf(baseLines, toLines(right.content));
  if (!leftHunks || !rightHunks) return clash(left, right);
  const tagged = [
    ...leftHunks.map((hunk) => ({ hunk, side: "left" as const })),
    ...rightHunks.map((hunk) => ({ hunk, side: "right" as const })),
  ].toSorted((a, b) => a.hunk.start - b.hunk.start || a.hunk.end - b.hunk.end);
  const out: string[] = [];
  let at = 0;
  for (let index = 0; index < tagged.length;) {
    const first = tagged[index]!;
    const start = first.hunk.start;
    let end = first.hunk.end;
    let next = index + 1;
    // A region grows while the next edit overlaps it, or inserts at the same empty place.
    while (next < tagged.length) {
      const candidate = tagged[next]!.hunk;
      if (candidate.start < end || (candidate.start === start && end === start)) {
        end = Math.max(end, candidate.end);
        next += 1;
      } else break;
    }
    const region = tagged.slice(index, next);
    const lefts = region.filter((item) => item.side === "left").map((item) => item.hunk);
    const rights = region.filter((item) => item.side === "right").map((item) => item.hunk);
    out.push(...baseLines.slice(at, start));
    const leftText = applied(baseLines, start, end, lefts);
    const rightText = applied(baseLines, start, end, rights);
    if (lefts.length === 0) out.push(rightText);
    else if (rights.length === 0 || leftText === rightText) out.push(leftText);
    else if (start === end) out.push(endLine(leftText), rightText);
    else out.push(clash({ ...left, content: leftText }, { ...right, content: rightText }));
    at = end;
    index = next;
  }
  out.push(...baseLines.slice(at));
  // An edit ending without a newline must not run into whatever comes after it.
  const parts = out.filter((part) => part !== "");
  return parts.map((part, at) => (at < parts.length - 1 ? endLine(part) : part)).join("");
}

/** The pair's sides in one order, whichever machine runs the merge. */
export const canonicalSides = <A extends { readonly environmentId: string }>(
  a: A,
  b: A,
): readonly [A, A] => (a.environmentId <= b.environmentId ? [a, b] : [b, a]);

/**
 * The versions both sides have had, newest first, which is what a merge compares them to.
 * "Newest" follows the first history, so pass the sides in `canonicalSides` order:
 * two histories can hold the same versions in a different order.
 */
export const commonAncestors = (
  first: ReadonlyArray<string>,
  second: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(second);
  return first.toReversed().filter((hash) => known.has(hash));
};
