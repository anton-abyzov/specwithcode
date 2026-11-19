// @effect-diagnostics nodeBuiltinImport:off - file heads are read with no-follow descriptors.
/**
 * The content check of a snapshot (1390 AC-14): untracked files are read for
 * well-known token formats before they travel. Only the first 64 KB of a file
 * is read, whatever its size and whether it is text, UTF-16 or binary, and at
 * most 2,000 files per snapshot. A token further into a file, or in a tracked
 * file, is not found, and a file that could not be read is reported as not
 * checked: callers say what was checked, never that a snapshot holds no secret.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_SYNC_CONTENT_CHECK_BYTES,
  PROJECT_SYNC_CONTENT_CHECK_FILES,
} from "@specweave-studio/contracts";

import { runGit } from "../fleet/folderTransfer/git.ts";
import { tokenKind } from "../fleet/folderTransfer/secretContent.ts";

export interface SnapshotContentFinding {
  readonly path: string;
  /** `content`: a token in its first 64 KB. `not-checked`: unreadable, or past the files one snapshot reads. */
  readonly reason: "content" | "not-checked";
  /** The kind of token found, such as "GitHub token". */
  readonly kind: string | null;
}

/**
 * The kind of token in a file's head, or null. The head is read as text, and
 * once more with its NUL bytes taken out: that is how the same characters look
 * in a UTF-16 file, and how a token sits between the bytes of a binary one.
 */
export function tokenKindInHead(head: Buffer | string): string | null {
  const text = typeof head === "string" ? head : head.toString("utf8");
  const direct = tokenKind(text);
  if (direct !== null || !text.includes("\0")) return direct;
  return tokenKind(text.replaceAll("\0", ""));
}

/**
 * The first `bytes` of a regular file, without following a link. Unlike
 * `readSmallText`, a file larger than `bytes` is still read: its head is what
 * gets checked, text or not. Null for what has no content of its own to check
 * (a link, a folder, a file that is gone); "unreadable" for a file that is
 * there and could not be read, which is never the same as nothing found.
 */
export async function readFileHead(
  absolute: string,
  bytes: number = PROJECT_SYNC_CONTENT_CHECK_BYTES,
): Promise<Buffer | "unreadable" | null> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    // Looked at before it is opened: opening a pipe waits for its other end, and Git
    // stages nothing for a pipe, a socket or a device.
    if (!(await NodeFSP.lstat(absolute)).isFile()) return null;
    handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        // Should a pipe take the file's place after the look above, the open still returns.
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(bytes, stat.size));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    // Gone, a link (not followed), or a folder: nothing of its own to read.
    if (code === "ENOENT" || code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR")
      return null;
    if (code === "EMLINK") return null;
    return "unreadable";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Checks untracked files by content, in the order given. `allow` names files
 * the person chose to send anyway: they are neither read nor counted. Past the
 * file cap, and for a file that could not be read, `leave-out` (a dialog can
 * show them) reports the file as `not-checked`; `name-only` (a standby
 * checkpoint has no dialog) lets it through on the name check alone and only
 * counts it.
 */
export async function checkSnapshotContent(input: {
  readonly root: string;
  readonly untracked: ReadonlyArray<string>;
  readonly allow?: ReadonlySet<string>;
  readonly pastLimit: "leave-out" | "name-only";
  readonly maxFiles?: number;
}): Promise<{
  /** Files to leave out of the snapshot. */
  readonly leftOut: ReadonlyArray<SnapshotContentFinding>;
  /** Files that travel on the name check alone (`name-only`): past the cap, or unreadable. */
  readonly notCheckedCount: number;
}> {
  const maxFiles = input.maxFiles ?? PROJECT_SYNC_CONTENT_CHECK_FILES;
  const leftOut: Array<SnapshotContentFinding> = [];
  let read = 0;
  let notCheckedCount = 0;
  const notChecked = (path: string) => {
    if (input.pastLimit === "leave-out") leftOut.push({ path, reason: "not-checked", kind: null });
    else notCheckedCount += 1;
  };
  for (const path of input.untracked) {
    if (input.allow?.has(path)) continue;
    if (read >= maxFiles) {
      notChecked(path);
      continue;
    }
    read += 1;
    const head = await readFileHead(NodePath.join(input.root, path));
    if (head === "unreadable") {
      notChecked(path);
      continue;
    }
    const kind = head === null ? null : tokenKindInHead(head);
    if (kind !== null) leftOut.push({ path, reason: "content", kind });
  }
  return { leftOut, notCheckedCount };
}

const STAGED_PARALLEL = 8;

/**
 * The same check on what a snapshot will carry: the blobs staged in its private
 * index, read after `write-tree`. A file a running thread rewrote between the
 * check above and the staging is judged by what was staged, so what is checked
 * is what travels. Of the tree's entries that differ from the base commit,
 * every file the base does not have (an untracked file, also one that appeared
 * in a folder swapped in for a checked file) is checked by name and read for
 * tokens (first 64 KB of the blob; past the files one snapshot reads, a file is
 * reported as not checked), and every changed file is measured against
 * the per-file limit and counted against the file limit.
 */
export async function checkStagedContent(input: {
  readonly root: string;
  readonly baseCommit: string;
  readonly tree: string;
  /** Whether a new file is a secret by its name: such a file never travels in a snapshot. */
  readonly secretName: (path: string) => boolean;
  readonly allow?: ReadonlySet<string>;
  readonly maxFileBytes: number;
  /** How many changed files one snapshot carries. */
  readonly maxChangedFiles: number;
  readonly maxFiles?: number;
}): Promise<{
  readonly flagged: ReadonlyArray<SnapshotContentFinding>;
  /** New files that are secrets by name. */
  readonly secretNames: ReadonlyArray<string>;
  /** The first staged file over the per-file limit. */
  readonly tooLarge: { readonly path: string; readonly bytes: number } | null;
  /** The first changed file past the file limit. */
  readonly tooMany: { readonly path: string } | null;
}> {
  const { root } = input;
  const diff = await runGit(root, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    input.baseCommit,
    input.tree,
  ]);
  const fields = diff.stdout.split("\0");
  const changed: Array<{ path: string; oid: string; added: boolean }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!.split(" ");
    const path = fields[index + 1]!;
    // Regular files only: a deletion, a link and a nested repository carry no blob to read.
    if (meta[1] !== "100644" && meta[1] !== "100755") continue;
    const oid = meta[3];
    if (oid !== undefined && path.length > 0)
      changed.push({ path, oid, added: meta[4] === "A" || meta[0] === ":000000" });
  }
  if (changed.length === 0) return { flagged: [], secretNames: [], tooLarge: null, tooMany: null };
  const secretNames = changed
    .filter(({ path, added }) => added && input.secretName(path))
    .map(({ path }) => path)
    .toSorted();
  const named = new Set(secretNames);
  const sizes = new Map<string, number>();
  const listed = await runGit(root, ["ls-tree", "-r", "-l", "-z", input.tree]);
  for (const entry of listed.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
    if (Number.isFinite(size)) sizes.set(entry.slice(tab + 1), size);
  }
  let tooLarge: { path: string; bytes: number } | null = null;
  for (const { path } of changed.toSorted((a, b) => a.path.localeCompare(b.path))) {
    const bytes = sizes.get(path) ?? 0;
    if (bytes > input.maxFileBytes) {
      tooLarge = { path, bytes };
      break;
    }
  }
  const unread = changed
    .filter(
      ({ path, added }) =>
        added &&
        !named.has(path) &&
        input.allow?.has(path) !== true &&
        (sizes.get(path) ?? 0) <= input.maxFileBytes,
    )
    .toSorted((a, b) => a.path.localeCompare(b.path));
  // Past the files one snapshot reads, a file is not checked and says so, as in the check
  // before staging: it never travels unread.
  const flagged: Array<SnapshotContentFinding> = unread
    .splice(input.maxFiles ?? PROJECT_SYNC_CONTENT_CHECK_FILES)
    .map(({ path }) => ({ path, reason: "not-checked", kind: null }));
  const toRead = unread;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(STAGED_PARALLEL, toRead.length) }, async () => {
      while (next < toRead.length) {
        const { path, oid } = toRead[next++]!;
        const blob = await runGit(root, ["cat-file", "blob", oid], { allowFailure: true });
        if (blob.code !== 0) {
          flagged.push({ path, reason: "not-checked", kind: null });
          continue;
        }
        // The first 64 KB of the blob, counted in bytes as for a file on disk.
        const kind = tokenKindInHead(
          Buffer.from(blob.stdout, "utf8").subarray(0, PROJECT_SYNC_CONTENT_CHECK_BYTES),
        );
        if (kind !== null) flagged.push({ path, reason: "content", kind });
      }
    }),
  );
  return {
    flagged: flagged.toSorted((a, b) => a.path.localeCompare(b.path)),
    secretNames,
    tooLarge,
    tooMany:
      changed
        .filter(({ path }) => !named.has(path))
        .toSorted((a, b) => a.path.localeCompare(b.path))
        .slice(input.maxChangedFiles, input.maxChangedFiles + 1)
        .map(({ path }) => ({ path }))[0] ?? null,
  };
}
