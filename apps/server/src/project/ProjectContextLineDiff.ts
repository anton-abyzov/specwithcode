/**
 * Line diffs for long project-context sections (the memory index and the
 * memory file list), so an edit to one line of MEMORY.md resends that line,
 * not the whole index. The format is unified diff without context lines:
 * `@@ -a,b +c,d @@`, then `-` lines removed from the previous value and `+`
 * lines added. For `b = 0` the added lines go after old line `a`.
 */

/** Above this many cells the middle of a change is sent as one replacement. */
const MAX_DIFF_CELLS = 4_000_000;

type Hunk = {
  readonly oldStart: number;
  readonly removed: ReadonlyArray<string>;
  readonly newStart: number;
  readonly added: ReadonlyArray<string>;
};

function middleHunks(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  offset: number,
): Hunk[] {
  const n = before.length;
  const m = after.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS)
    return [{ oldStart: offset, removed: before, newStart: offset, added: after }];
  // Longest common subsequence, filled from the end so the walk goes forward.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] =
        before[i] === after[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    const oldStart = offset + i;
    const newStart = offset + j;
    const removed: string[] = [];
    const added: string[] = [];
    while ((i < n || j < m) && !(i < n && j < m && before[i] === after[j])) {
      if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!))
        removed.push(before[i++]!);
      else added.push(after[j++]!);
    }
    hunks.push({ oldStart, removed, newStart, added });
  }
  return hunks;
}

/** The diff from `previous` to `next`, or "" when they are equal. */
export function projectContextLineDiff(previous: string, next: string): string {
  if (previous === next) return "";
  const before = previous.split("\n");
  const after = next.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const hunks = middleHunks(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
    head,
  );
  return hunks
    .map((hunk) => {
      // Unified diff numbers from 1; an empty side names the line before it.
      const oldFrom = hunk.removed.length === 0 ? hunk.oldStart : hunk.oldStart + 1;
      const newFrom = hunk.added.length === 0 ? hunk.newStart : hunk.newStart + 1;
      return [
        `@@ -${oldFrom},${hunk.removed.length} +${newFrom},${hunk.added.length} @@`,
        ...hunk.removed.map((line) => `-${line}`),
        ...hunk.added.map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}

/** Applies a diff made by projectContextLineDiff; throws on one that does not fit. */
export function applyProjectContextLineDiff(previous: string, diff: string): string {
  if (diff === "") return previous;
  const before = previous.split("\n");
  const result: string[] = [];
  let cursor = 0;
  const lines = diff.split("\n");
  for (let index = 0; index < lines.length; ) {
    const header = /^@@ -(\d+),(\d+) \+\d+,(\d+) @@$/.exec(lines[index]!);
    if (!header) throw new Error(`Not a hunk header: ${lines[index]}`);
    const removedCount = Number(header[2]);
    const addedCount = Number(header[3]);
    const start = removedCount === 0 ? Number(header[1]) : Number(header[1]) - 1;
    if (start < cursor || start > before.length) throw new Error("Hunk out of order");
    result.push(...before.slice(cursor, start));
    index++;
    for (let k = 0; k < removedCount; k++, index++) {
      if (lines[index] !== `-${before[start + k]}`) throw new Error("Removed line differs");
    }
    for (let k = 0; k < addedCount; k++, index++) {
      const line = lines[index];
      if (line === undefined || !line.startsWith("+")) throw new Error("Missing added line");
      result.push(line.slice(1));
    }
    cursor = start + removedCount;
  }
  result.push(...before.slice(cursor));
  return result.join("\n");
}
