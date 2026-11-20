/** Bounded report pages. Only a path already named in an outgoing message reaches here. */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Numeric O_NOFOLLOW flags and opened-inode validation require Node file handles.
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Numeric O_NOFOLLOW flags and opened-inode validation require Node file handles.
import { open, realpath, lstat } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Canonical native paths are checked against the opened file handle.
import path from "node:path";
export const REPORT_MAX_BYTES = 256 * 1024;
export const REPORT_PAGE_CHARS = 8000;
export async function readReportPage(root: string, namedPath: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid report offset.");
  const base = await realpath(root);
  const target = path.resolve(base, namedPath);
  const relative = path.relative(base, target);
  // Reports live in an increment's reports folder; refs never expose arbitrary project files.
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !/^\.specweave\/increments\/[^/]+\/reports\/.+\.(md|txt|html|json)$/i.test(
      relative.split(path.sep).join("/"),
    ) ||
    /(?:^|[/\\])(?:\.git|userdata|secrets?)(?:[/\\]|$)|statev2\.sqlite/i.test(relative)
  )
    throw new Error("Only a named project report may be read.");
  const resolved = await realpath(target);
  if (resolved !== target) throw new Error("A report reference cannot follow symbolic links.");
  const before = await lstat(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n)
    throw new Error("A report reference must name one regular file without links.");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
    const after = await lstat(target, { bigint: true });
    const finished = await file.stat({ bigint: true });
    if (
      (await realpath(target)) !== target ||
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
    const content = text.slice(offset, offset + REPORT_PAGE_CHARS);
    return {
      content,
      offset,
      nextOffset: offset + content.length < text.length ? offset + content.length : null,
    };
  } finally {
    await file.close();
  }
}
