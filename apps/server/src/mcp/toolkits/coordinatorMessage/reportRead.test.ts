import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Filesystem link fixtures exercise opened-handle validation.
import { mkdir, mkdtemp, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Native paths match the file-handle reader under test.
import path from "node:path";
import { readReportPage, REPORT_MAX_BYTES } from "./reportRead.ts";
let root = "";
const named = ".specweave/increments/1427-test/reports/check.md";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "coordinator-reports-"));
  await mkdir(path.dirname(path.join(root, named)), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("named report pages", () => {
  it("pages at 8000 characters with a stable final offset", async () => {
    await writeFile(path.join(root, named), "a".repeat(8001));
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
  it("refuses traversal and arbitrary project files", async () => {
    await writeFile(path.join(root, "secret.md"), "private");
    await expect(readReportPage(root, "secret.md", 0)).rejects.toThrow(
      "Only a named project report",
    );
    await expect(readReportPage(root, "../secret.md", 0)).rejects.toThrow(
      "Only a named project report",
    );
  });
  it("refuses final symbolic links", async () => {
    await writeFile(path.join(root, "secret.md"), "private");
    await symlink(path.join(root, "secret.md"), path.join(root, named));
    await expect(readReportPage(root, named, 0)).rejects.toThrow("symbolic links");
  });
  it("refuses a symbolic link in the reports directory", async () => {
    const folder = path.dirname(path.join(root, named));
    await rm(folder, { recursive: true });
    await mkdir(path.join(root, "private"));
    await writeFile(path.join(root, "private/check.md"), "private");
    await symlink(path.join(root, "private"), folder);
    await expect(readReportPage(root, named, 0)).rejects.toThrow("symbolic links");
  });
  it("refuses reports above 256 KB", async () => {
    await writeFile(path.join(root, named), "x".repeat(REPORT_MAX_BYTES + 1));
    await expect(readReportPage(root, named, 0)).rejects.toThrow("256 KB");
  });
  it("refuses fractional, negative and past-end offsets", async () => {
    await writeFile(path.join(root, named), "abc");
    for (const offset of [-1, 0.5, 4])
      await expect(readReportPage(root, named, offset)).rejects.toThrow("Invalid report offset");
  });
  it("refuses hard links to another file", async () => {
    await writeFile(path.join(root, "private.md"), "private");
    await link(path.join(root, "private.md"), path.join(root, named));
    await expect(readReportPage(root, named, 0)).rejects.toThrow("without links");
  });
});
