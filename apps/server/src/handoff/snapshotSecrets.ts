// @effect-diagnostics nodeBuiltinImport:off - file heads are read with no-follow descriptors.
/**
 * The content check of a snapshot (1390 AC-14): untracked files are read for
 * well-known token formats before they travel. Only the first 64 KB of a file
 * is read, whatever its size, and at most 2,000 files per snapshot. A token
 * further into a file, or in a tracked file, is not found: callers say what
 * was checked, never that a snapshot holds no secret.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_SYNC_CONTENT_CHECK_BYTES,
  PROJECT_SYNC_CONTENT_CHECK_FILES,
} from "@specweave-studio/contracts";

import { tokenKind } from "../fleet/folderTransfer/secretContent.ts";

export interface SnapshotContentFinding {
  readonly path: string;
  /** `content`: a token in its first 64 KB. `not-checked`: past the files one snapshot reads. */
  readonly reason: "content" | "not-checked";
  /** The kind of token found, such as "GitHub token". */
  readonly kind: string | null;
}

/**
 * The first `bytes` of a regular file as text, without following a link. Unlike
 * `readSmallText`, a file larger than `bytes` is still read: its head is what
 * gets checked. Null for a link, a folder, a file that is gone, or a binary one
 * (a NUL in its first kilobyte).
 */
export async function readFileHead(
  absolute: string,
  bytes: number = PROJECT_SYNC_CONTENT_CHECK_BYTES,
): Promise<string | null> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
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
    const head = buffer.subarray(0, filled);
    if (head.subarray(0, 1024).includes(0)) return null;
    return head.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Checks untracked files by content, in the order given. `allow` names files
 * the person chose to send anyway: they are neither read nor counted. Past the
 * file cap, `leave-out` (a dialog can show them) reports the rest as
 * `not-checked`; `name-only` (a standby checkpoint has no dialog) lets them
 * through on the name check alone and only counts them.
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
  /** Files past the cap that travel on the name check alone (`name-only`). */
  readonly notCheckedCount: number;
}> {
  const maxFiles = input.maxFiles ?? PROJECT_SYNC_CONTENT_CHECK_FILES;
  const leftOut: Array<SnapshotContentFinding> = [];
  let read = 0;
  let notCheckedCount = 0;
  for (const path of input.untracked) {
    if (input.allow?.has(path)) continue;
    if (read >= maxFiles) {
      if (input.pastLimit === "leave-out") leftOut.push({ path, reason: "not-checked", kind: null });
      else notCheckedCount += 1;
      continue;
    }
    read += 1;
    const head = await readFileHead(NodePath.join(input.root, path));
    const kind = head === null ? null : tokenKind(head);
    if (kind !== null) leftOut.push({ path, reason: "content", kind });
  }
  return { leftOut, notCheckedCount };
}
