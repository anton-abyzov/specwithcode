/**
 * Pure helpers that turn provider edit data into headed unified patches the
 * diff renderer can parse, count their lines and split them by file. Servers
 * use them while ingesting and projecting edits; clients use them for older
 * items stored before the conversion existed.
 */

/** One hunk of a structured patch: ranges plus lines prefixed with `+`, `-` or a space. */
export interface StructuredPatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

export interface PatchLineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/** One file's block in a multi-file patch. Paths are as the patch names them, unquoted. */
export interface PatchFileBlock {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The hunks of a structured patch, or null when the value is not one. */
export function readStructuredPatchHunks(
  value: unknown,
): ReadonlyArray<StructuredPatchHunk> | null {
  if (!Array.isArray(value)) return null;
  const hunks: StructuredPatchHunk[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isCount(candidate.oldStart) ||
      !isCount(candidate.oldLines) ||
      !isCount(candidate.newStart) ||
      !isCount(candidate.newLines) ||
      !Array.isArray(candidate.lines) ||
      !candidate.lines.every((line) => typeof line === "string")
    ) {
      return null;
    }
    hunks.push({
      oldStart: candidate.oldStart,
      oldLines: candidate.oldLines,
      newStart: candidate.newStart,
      newLines: candidate.newLines,
      lines: candidate.lines as ReadonlyArray<string>,
    });
  }
  return hunks;
}

function headerPath(prefix: "a" | "b", path: string | null): string {
  return path === null ? "/dev/null" : `${prefix}/${path}`;
}

/** File headers git would write for this change. Paths are used as given. */
function fileHeader(oldPath: string | null, newPath: string | null): string {
  const left = oldPath ?? newPath ?? "file";
  const right = newPath ?? oldPath ?? "file";
  const lines = [`diff --git a/${left} b/${right}`];
  if (oldPath === null) lines.push("new file mode 100644");
  else if (newPath === null) lines.push("deleted file mode 100644");
  else if (oldPath !== newPath) lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  lines.push(`--- ${headerPath("a", oldPath)}`, `+++ ${headerPath("b", newPath)}`);
  return `${lines.join("\n")}\n`;
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function joinLines(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** A headed unified patch from structured hunks. Null path sides mean create or delete. */
export function formatStructuredPatch(input: {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: ReadonlyArray<StructuredPatchHunk>;
}): string {
  const body = input.hunks
    .map(
      (hunk) =>
        `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@\n${joinLines(hunk.lines)}`,
    )
    .join("");
  return `${fileHeader(input.oldPath, input.newPath)}${body}`;
}

function contentLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A patch that adds every line of `content` to a new file. */
export function allAddedPatch(path: string, content: string): string {
  const lines = contentLines(content);
  return formatStructuredPatch({
    oldPath: null,
    newPath: path,
    hunks:
      lines.length === 0
        ? []
        : [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lines.length,
              lines: lines.map((line) => `+${line}`),
            },
          ],
  });
}

/** A patch that removes every line of `content` from a deleted file. */
export function allDeletedPatch(path: string, content: string): string {
  const lines = contentLines(content);
  return formatStructuredPatch({
    oldPath: path,
    newPath: null,
    hunks:
      lines.length === 0
        ? []
        : [
            {
              oldStart: 1,
              oldLines: lines.length,
              newStart: 0,
              newLines: 0,
              lines: lines.map((line) => `-${line}`),
            },
          ],
  });
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** True when the text holds at least one hunk, so it can render as a diff. */
export function isUnifiedPatch(text: string): boolean {
  return /^@@ /m.test(text) || /^@@$/m.test(text);
}

/** True when the text already starts with file headers. */
function hasFileHeader(text: string): boolean {
  return /^(diff --git |--- )/m.test(text.slice(0, 4096));
}

/**
 * Gives a bare provider hunk body file headers, and counted ranges where its
 * `@@` lines carry none. `synthesizedLineNumbers` is true when any range was
 * invented: those line numbers count from 1 and are not the file's.
 * An add or delete whose body is plain content becomes an all-added or
 * all-deleted patch.
 */
export function headedPatch(input: {
  readonly operation: "add" | "delete" | "update" | "move";
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly body: string;
}): { readonly patch: string; readonly synthesizedLineNumbers: boolean } {
  if (hasFileHeader(input.body)) return { patch: input.body, synthesizedLineNumbers: false };
  const oldPath =
    input.operation === "add"
      ? null
      : input.operation === "move"
        ? (input.oldPath ?? input.path)
        : input.path;
  const newPath = input.operation === "delete" ? null : input.path;
  if (!isUnifiedPatch(input.body)) {
    if (input.operation === "add")
      return { patch: allAddedPatch(input.path, input.body), synthesizedLineNumbers: false };
    if (input.operation === "delete") {
      return {
        patch: allDeletedPatch(input.oldPath ?? input.path, input.body),
        synthesizedLineNumbers: false,
      };
    }
    // An update without hunks cannot be shown as a diff; keep the body under headers.
    return { patch: `${fileHeader(oldPath, newPath)}${input.body}`, synthesizedLineNumbers: false };
  }
  const lines = contentLines(input.body);
  const output: string[] = [];
  let synthesizedLineNumbers = false;
  let oldCursor = 1;
  let newCursor = 1;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith("@@")) {
      // Text before the first hunk is not part of any hunk; keep it out of the patch.
      index += 1;
      continue;
    }
    const body: string[] = [];
    let next = index + 1;
    while (next < lines.length && !lines[next]!.startsWith("@@")) {
      body.push(lines[next]!);
      next += 1;
    }
    const ranged = HUNK_HEADER.exec(line);
    if (ranged) {
      output.push(line, ...body);
      oldCursor = Number(ranged[1]) + Number(ranged[2] ?? 1);
      newCursor = Number(ranged[3]) + Number(ranged[4] ?? 1);
    } else {
      synthesizedLineNumbers = true;
      let oldLines = 0;
      let newLines = 0;
      for (const bodyLine of body) {
        if (bodyLine.startsWith("\\")) continue;
        if (bodyLine.startsWith("+")) newLines += 1;
        else if (bodyLine.startsWith("-")) oldLines += 1;
        else {
          oldLines += 1;
          newLines += 1;
        }
      }
      const oldStart = oldLines === 0 ? Math.max(0, oldCursor - 1) : oldCursor;
      const newStart = newLines === 0 ? Math.max(0, newCursor - 1) : newCursor;
      output.push(
        `@@ -${hunkRange(oldStart, oldLines)} +${hunkRange(newStart, newLines)} @@`,
        ...body,
      );
      oldCursor += oldLines;
      newCursor += newLines;
    }
    index = next;
  }
  return { patch: `${fileHeader(oldPath, newPath)}${joinLines(output)}`, synthesizedLineNumbers };
}

/**
 * Lines added and removed in a unified patch, excluding file headers. Null
 * when the text has no hunk, so a failure message is never counted as a patch.
 */
export function countPatchLines(patch: string): PatchLineCounts | null {
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;
  // Lines still owed by a hunk whose header gave its ranges; null for a bare `@@`.
  let oldRemaining: number | null = null;
  let newRemaining: number | null = null;
  let inHunk = false;
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("@@")) {
      sawHunk = true;
      inHunk = true;
      const ranged = HUNK_HEADER.exec(line);
      oldRemaining = ranged ? Number(ranged[2] ?? 1) : null;
      newRemaining = ranged ? Number(ranged[4] ?? 1) : null;
      continue;
    }
    if (!inHunk) continue;
    if (oldRemaining !== null && newRemaining !== null) {
      if (oldRemaining <= 0 && newRemaining <= 0) {
        inHunk = false;
        continue;
      }
    } else if (
      line.startsWith("diff --git ") ||
      (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "))
    ) {
      // A bare hunk ends where the next file's headers start.
      inHunk = false;
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      if (newRemaining !== null) newRemaining -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      if (oldRemaining !== null) oldRemaining -= 1;
    } else if (line.startsWith("\\")) {
      continue;
    } else if (oldRemaining !== null && newRemaining !== null) {
      oldRemaining -= 1;
      newRemaining -= 1;
    }
  }
  return sawHunk ? { additions, deletions } : null;
}

const OCTAL_ESCAPE = /^[0-7]{3}/;
const C_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
};

/** Reads a path git wrote in C-style quotes (`"a/\303\251.txt"`), decoding octal bytes as UTF-8. */
export function unquoteGitPath(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const inner = value.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const character = String.fromCodePoint(inner.codePointAt(index)!);
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      index += character.length - 1;
      continue;
    }
    const rest = inner.slice(index + 1);
    const octal = OCTAL_ESCAPE.exec(rest);
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const escaped = C_ESCAPES[rest[0] ?? ""];
    bytes.push(...encoder.encode(escaped ?? rest[0] ?? ""));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripSidePrefix(path: string, prefix: "a/" | "b/"): string | null {
  if (path === "/dev/null") return null;
  const unquoted = unquoteGitPath(path);
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

/** The old and new path of a `diff --git` line when both sides are the same path. */
function pathsFromGitLine(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) {
    return {
      oldPath: stripSidePrefix(quoted[1]!, "a/"),
      newPath: stripSidePrefix(quoted[2]!, "b/"),
    };
  }
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const left = rest.slice(2, 2 + half);
    if (rest.startsWith("a/") && rest.slice(2 + half) === ` b/${left}`) {
      return { oldPath: left, newPath: left };
    }
  }
  const split = /^a\/(.+) b\/(.+)$/.exec(rest);
  return split ? { oldPath: split[1]!, newPath: split[2]! } : { oldPath: null, newPath: null };
}

function headerLinePath(line: string, prefix: "a/" | "b/"): string | null {
  // Git ends the name at a tab when it writes one (names with spaces).
  return stripSidePrefix(line.slice(4).replace(/\t.*$/, ""), prefix);
}

/**
 * Splits a git patch at its `diff --git` lines. Each block keeps its text
 * exactly, so joining the blocks gives back the patch after any preamble.
 * Paths come from rename/copy lines and `---`/`+++` headers when present,
 * which name files with spaces unambiguously.
 */
export function splitPatchByFile(patch: string): ReadonlyArray<PatchFileBlock> {
  const starts: number[] = [];
  const pattern = /^diff --git /gm;
  for (let match = pattern.exec(patch); match !== null; match = pattern.exec(patch)) {
    starts.push(match.index);
  }
  return starts.map((start, index) => {
    const text = patch.slice(start, starts[index + 1] ?? patch.length);
    const lines = text.split("\n");
    let { oldPath, newPath } = pathsFromGitLine(lines[0]!);
    let renamed = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@") || line.startsWith("Binary files ")) break;
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        oldPath = unquoteGitPath(line.slice(line.indexOf(" from ") + 6));
        renamed = true;
      } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        newPath = unquoteGitPath(line.slice(line.indexOf(" to ") + 4));
        renamed = true;
      } else if (line.startsWith("--- ") && !renamed) {
        oldPath = headerLinePath(line, "a/");
      } else if (line.startsWith("+++ ") && !renamed) {
        newPath = headerLinePath(line, "b/");
      } else if (line.startsWith("new file mode")) {
        oldPath = null;
      } else if (line.startsWith("deleted file mode")) {
        newPath = null;
      }
    }
    return { oldPath, newPath, text };
  });
}

/**
 * The patch for an edit tool's structured result: Claude's Edit or Write
 * output (`structuredPatch` hunks, an optional `gitDiff.patch`, Write's `type`
 * and `content`). Accepts the value itself or its JSON text, as older items
 * stored it. Hunks win; the git patch is the fallback and is labelled, because
 * it diffs the whole file and may include changes this edit did not make.
 * A Write update without hunks carries no patch at all.
 */
export function structuredEditResultPatch(
  value: unknown,
  fallbackPath?: string,
):
  | { readonly patch: string; readonly diffNote?: "git_patch" }
  | { readonly patch?: undefined; readonly diffNote: "overwrite_without_diff" }
  | null {
  let result = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      result = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!isRecord(result)) return null;
  const path =
    typeof result.filePath === "string" && result.filePath.trim()
      ? result.filePath.trim()
      : fallbackPath?.trim();
  if (!path) return null;
  const hunks = readStructuredPatchHunks(result.structuredPatch);
  // Write says create; an Edit that created its file has no original and only added lines.
  const isCreate =
    result.type === "create" ||
    (result.type === undefined &&
      result.originalFile === null &&
      hunks !== null &&
      hunks.every((hunk) => hunk.oldLines === 0));
  if (hunks !== null && hunks.length > 0) {
    return {
      patch: formatStructuredPatch({ oldPath: isCreate ? null : path, newPath: path, hunks }),
    };
  }
  const gitPatch =
    isRecord(result.gitDiff) && typeof result.gitDiff.patch === "string"
      ? result.gitDiff.patch
      : "";
  if (isUnifiedPatch(gitPatch)) {
    return {
      patch: hasFileHeader(gitPatch)
        ? gitPatch
        : `${fileHeader(path, path)}${gitPatch.endsWith("\n") ? gitPatch : `${gitPatch}\n`}`,
      diffNote: "git_patch",
    };
  }
  if (result.type === "create" && typeof result.content === "string") {
    return { patch: allAddedPatch(path, result.content) };
  }
  if (result.type === "update") return { diffNote: "overwrite_without_diff" };
  return null;
}
