import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Filesystem link fixtures exercise opened-handle validation.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Native paths match the file-handle reader under test.
import * as NodePath from "node:path";
import { readReportPage, REPORT_MAX_BYTES } from "./reportRead.ts";
let root = "";
const named = ".specweave/increments/1427-test/reports/check.md";
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "coordinator-reports-"));
  await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, named)), { recursive: true });
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});
describe("named report pages", () => {
  it("pages at 8000 characters with a stable final offset", async () => {
    await NodeFSP.writeFile(NodePath.join(root, named), "a".repeat(8001));
    expect(await readReportPage(root, named, 0)).toEqual({
      content: "a".repeat(8000),
      offset: 0,
      nextOffset: 8000,
    });
    expect(await readReportPage(root, named, 8000)).toEqual({
      content: "a",
      offset: 8000,
      nextOffset: null,
    });
  });
  it("never splits a character between two pages", async () => {
    await NodeFSP.writeFile(NodePath.join(root, named), `${"a".repeat(7999)}\u{1F600}b`);
    const first = await readReportPage(root, named, 0);
    expect(first).toEqual({ content: "a".repeat(7999), offset: 0, nextOffset: 7999 });
    expect(await readReportPage(root, named, 7999)).toEqual({
      content: "\u{1F600}b",
      offset: 7999,
      nextOffset: null,
    });
  });
  it("refuses a report that is not UTF-8 text", async () => {
    await NodeFSP.writeFile(NodePath.join(root, named), Buffer.from([0x61, 0xff, 0x62]));
    await expect(readReportPage(root, named, 0)).rejects.toThrow();
  });
  it("refuses traversal and arbitrary project files", async () => {
    await NodeFSP.writeFile(NodePath.join(root, "secret.md"), "private");
    await expect(readReportPage(root, "secret.md", 0)).rejects.toThrow(
      "Only a named project report",
    );
    await expect(readReportPage(root, "../secret.md", 0)).rejects.toThrow(
      "Only a named project report",
    );
  });
  it("refuses final symbolic links", async () => {
    await NodeFSP.writeFile(NodePath.join(root, "secret.md"), "private");
    await NodeFSP.symlink(NodePath.join(root, "secret.md"), NodePath.join(root, named));
    await expect(readReportPage(root, named, 0)).rejects.toThrow("symbolic links");
  });
  it("refuses a symbolic link in the reports directory", async () => {
    const folder = NodePath.dirname(NodePath.join(root, named));
    await NodeFSP.rm(folder, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "private"));
    await NodeFSP.writeFile(NodePath.join(root, "private/check.md"), "private");
    await NodeFSP.symlink(NodePath.join(root, "private"), folder);
    await expect(readReportPage(root, named, 0)).rejects.toThrow("symbolic links");
  });
  it("refuses reports above 256 KB", async () => {
    await NodeFSP.writeFile(NodePath.join(root, named), "x".repeat(REPORT_MAX_BYTES + 1));
    await expect(readReportPage(root, named, 0)).rejects.toThrow("256 KB");
  });
  it("refuses fractional, negative and past-end offsets", async () => {
    await NodeFSP.writeFile(NodePath.join(root, named), "abc");
    for (const offset of [-1, 0.5, 4])
      await expect(readReportPage(root, named, offset)).rejects.toThrow("Invalid report offset");
  });
  it("refuses hard links to another file", async () => {
    await NodeFSP.writeFile(NodePath.join(root, "private.md"), "private");
    await NodeFSP.link(NodePath.join(root, "private.md"), NodePath.join(root, named));
    await expect(readReportPage(root, named, 0)).rejects.toThrow("without links");
  });
});
