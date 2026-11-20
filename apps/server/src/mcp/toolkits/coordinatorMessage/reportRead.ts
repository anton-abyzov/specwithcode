/** Bounded report pages. Only a path already named in an outgoing message reaches here. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
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
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > REPORT_MAX_BYTES)
      throw new Error("A report may contain at most 256 KB.");
    const bytes = Buffer.alloc(REPORT_MAX_BYTES + 1);
    const count = await file.read(bytes, 0, bytes.length, 0);
    if (count.bytesRead > REPORT_MAX_BYTES) throw new Error("A report may contain at most 256 KB.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, count.bytesRead),
    );
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
