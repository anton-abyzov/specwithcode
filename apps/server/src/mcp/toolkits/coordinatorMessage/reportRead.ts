/** Bounded report pages. Only a path already named in an outgoing message reaches here. */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Numeric O_NOFOLLOW flags and opened-inode validation require Node file handles.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Numeric O_NOFOLLOW flags and opened-inode validation require Node file handles.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Canonical native paths are checked against the opened file handle.
import * as NodePath from "node:path";
import { COORDINATOR_MESSAGE_REPORT_PATH } from "@specweave-studio/contracts";
export const REPORT_MAX_BYTES = 256 * 1024;
export const REPORT_PAGE_CHARS = 8000;
export async function readReportPage(root: string, namedPath: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid report offset.");
  const base = await NodeFSP.realpath(root);
  const target = NodePath.resolve(base, namedPath);
  const relative = NodePath.relative(base, target);
  // Reports live in an increment's reports folder; refs never expose arbitrary project files.
  if (
    relative.startsWith("..") ||
    NodePath.isAbsolute(relative) ||
    !COORDINATOR_MESSAGE_REPORT_PATH.test(relative.split(NodePath.sep).join("/")) ||
    /(?:^|[/\\])(?:\.git|userdata|secrets?)(?:[/\\]|$)|statev2\.sqlite/i.test(relative)
  )
    throw new Error("Only a named project report may be read.");
  const resolved = await NodeFSP.realpath(target);
  if (resolved !== target) throw new Error("A report reference cannot follow symbolic links.");
  const before = await NodeFSP.lstat(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n)
    throw new Error("A report reference must name one regular file without links.");
  // O_NONBLOCK: a FIFO swapped in after the check cannot hold a worker thread open.
  const file = await NodeFSP.open(
    target,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat({ bigint: true });
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1n)
      throw new Error("The report changed while it was opened.");
    if (!stat.isFile() || stat.size > BigInt(REPORT_MAX_BYTES))
      throw new Error("A report may contain at most 256 KB.");
    const bytes = Buffer.alloc(REPORT_MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const chunk = await file.read(bytes, count, bytes.length - count, count);
      if (chunk.bytesRead === 0) break;
      count += chunk.bytesRead;
    }
    if (count > REPORT_MAX_BYTES) throw new Error("A report may contain at most 256 KB.");
    // Validate the opened inode against the named file again before releasing any content.
    const after = await NodeFSP.lstat(target, { bigint: true });
    const finished = await file.stat({ bigint: true });
    if (
      (await NodeFSP.realpath(target)) !== target ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      finished.size !== stat.size ||
      finished.mtimeNs !== stat.mtimeNs ||
      finished.ctimeNs !== stat.ctimeNs
    )
      throw new Error("The report changed while it was read.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    if (offset > text.length) throw new Error("Invalid report offset.");
    let end = Math.min(offset + REPORT_PAGE_CHARS, text.length);
    // Never end a page between the two halves of a surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - 1 > offset && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const content = text.slice(offset, end);
    return {
      content,
      offset,
      nextOffset: offset + content.length < text.length ? offset + content.length : null,
    };
  } finally {
    await file.close();
  }
}
