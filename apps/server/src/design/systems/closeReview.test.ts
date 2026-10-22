// @effect-diagnostics nodeBuiltinImport:off - Lays out hostile fixture files and swaps them mid-read.
/** Regression tests for the 0973 closing review: secret links, read races, scan budget, deep chains. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { assemble } from "./assemble.ts";
import { sourceText } from "./common.ts";
import { collectCss } from "./extractCss.ts";
import { MAX_REFERENCE_DEPTH } from "./resolveModes.ts";
import {
  ReadBudget,
  readInsideRoot,
  readInsideRootHooks,
  scanCandidates,
} from "./scanCandidates.ts";

const temps: string[] = [];
afterEach(async () => {
  delete readInsideRootHooks.beforeOpen;
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

async function folder(prefix: string, files: Record<string, string> = {}): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  return root;
}

const CSS = (prefix: string, count = 12) =>
  `:root {\n${Array.from({ length: count }, (_, index) => `  --${prefix}-${index}: ${index}px;`).join("\n")}\n}\n`;

describe("links to secrets inside the root", () => {
  it("refuses theme.css -> .env by its real path, in a named read and in a scan", async () => {
    const root = await folder("design-secret-link-", {
      ".env": `${CSS("leak")}SECRET=hunter2\n`,
      "config/.npmrc": CSS("npm"),
      "src/theme.css": CSS("ok"),
    });
    await NodeFSP.symlink(NodePath.join(root, ".env"), NodePath.join(root, "theme.css"));
    await NodeFSP.symlink("../config/.npmrc", NodePath.join(root, "src/tokens.css"));

    await expect(readInsideRoot(root, "theme.css")).rejects.toMatchObject({ reason: "excluded" });
    await expect(readInsideRoot(root, "src/tokens.css")).rejects.toMatchObject({
      reason: "excluded",
    });
    const scan = await scanCandidates(root);
    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(["src/theme.css"]);
    expect(scan.skipped).toEqual([
      { path: "src/tokens.css", reason: "excluded" },
      { path: "theme.css", reason: "excluded" },
    ]);
    expect(JSON.stringify(scan)).not.toContain("hunter2");
  });
});

describe("one open per read", () => {
  it("refuses a file swapped for a link to a secret after it was resolved", async () => {
    const root = await folder("design-race-file-", {
      ".env": "SECRET=hunter2",
      "theme.css": CSS("a"),
    });
    readInsideRootHooks.beforeOpen = async (real) => {
      await NodeFSP.rm(real);
      await NodeFSP.symlink(NodePath.join(root, ".env"), real);
    };
    await expect(readInsideRoot(root, "theme.css")).rejects.toMatchObject({ reason: "missing" });
  });

  it("refuses a parent folder swapped for a link outside the root after it was resolved", async () => {
    const outside = await folder("design-race-outside-", {
      "theme.css": `${CSS("x")}/* outside */`,
    });
    const root = await folder("design-race-parent-", { "styles/theme.css": CSS("a") });
    readInsideRootHooks.beforeOpen = async () => {
      await NodeFSP.rename(NodePath.join(root, "styles"), NodePath.join(root, "styles-old"));
      await NodeFSP.symlink(outside, NodePath.join(root, "styles"));
    };
    await expect(readInsideRoot(root, "styles/theme.css")).rejects.toMatchObject({
      reason: "symlink-outside-root",
    });
  });

  it("still reads an in-root link to an ordinary file", async () => {
    const root = await folder("design-link-ok-", { "src/theme.css": CSS("a") });
    await NodeFSP.symlink("src/theme.css", NodePath.join(root, "linked.css"));
    const read = await readInsideRoot(root, "linked.css");
    expect(read.path).toBe("linked.css");
    expect(read.text).toBe(CSS("a"));
  });
});

describe("scan read budget", () => {
  it("lists files past the byte or file budget as skipped and marks the scan truncated", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`styles/theme-${index}.css`, CSS(`t${index}`)]),
    );
    const root = await folder("design-budget-", files);
    const full = await scanCandidates(root);
    expect(full.candidates).toHaveLength(6);
    expect(full.truncated).toBe(false);

    const byFiles = await scanCandidates(root, { maxReadFiles: 2 });
    expect(byFiles.candidates.map((candidate) => candidate.path)).toEqual([
      "styles/theme-0.css",
      "styles/theme-1.css",
    ]);
    expect(byFiles.skipped.filter((skip) => skip.reason === "budget")).toHaveLength(4);
    expect(byFiles.truncated).toBe(true);

    const oneFile = Buffer.byteLength(CSS("t0"));
    const byBytes = await scanCandidates(root, { maxReadBytes: oneFile * 3 });
    expect(byBytes.candidates).toHaveLength(3);
    expect(byBytes.skipped.map((skip) => skip.reason)).toEqual(["budget", "budget", "budget"]);
  });

  it("counts every read against one budget", async () => {
    const root = await folder("design-budget-unit-", { "a.css": "aaaa", "b.css": "bb" });
    const budget = new ReadBudget(5, 10);
    await readInsideRoot(root, "a.css", undefined, budget);
    expect(budget).toMatchObject({ bytes: 1, files: 9 });
    await expect(readInsideRoot(root, "b.css", undefined, budget)).rejects.toMatchObject({
      reason: "budget",
    });
    expect([...budget.refused]).toEqual(["b.css"]);
  });
});

describe("reference chains", () => {
  const chain = (length: number) =>
    `:root {\n  --c-0: #123456;\n${Array.from(
      { length: length - 1 },
      (_, index) => `  --c-${index + 1}: var(--c-${index});`,
    ).join("\n")}\n}\n`;

  it("leaves a token past the depth cap unresolved instead of failing the extraction", () => {
    const extraction = assemble([collectCss(sourceText("chain.css", chain(200)))]);
    const value = (index: number) =>
      extraction.tokens.find((token) => token.name === `c-${index}`)!.values.default!.resolved;
    expect(value(MAX_REFERENCE_DEPTH)).toBe("#123456");
    expect(value(MAX_REFERENCE_DEPTH + 1)).toBeNull();
    expect(value(199)).toBeNull();
    const deep = extraction.findings.find((item) => item.message.includes("left unresolved"));
    expect(deep).toMatchObject({ code: "unresolved", severity: "warning" });
    expect(deep!.message).toContain(
      `135 tokens follow more than ${MAX_REFERENCE_DEPTH} references`,
    );
  });

  it("measures a 20,000-token chain and a wide diamond without deep recursion", () => {
    expect(() => assemble([collectCss(sourceText("long.css", chain(20_000)))])).not.toThrow();
    const diamond = `:root {\n  --d-0: 1px;\n${Array.from(
      { length: 60 },
      (_, index) => `  --d-${index + 1}: calc(var(--d-${index}) + var(--d-${index}));`,
    ).join("\n")}\n}\n`;
    const started = performance.now();
    const extraction = assemble([collectCss(sourceText("diamond.css", diamond))]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(extraction.tokens.find((token) => token.name === "d-3")!.values.default!.resolved).toBe(
      "calc(calc(calc(1px + 1px) + calc(1px + 1px)) + calc(calc(1px + 1px) + calc(1px + 1px)))",
    );
  });
});
