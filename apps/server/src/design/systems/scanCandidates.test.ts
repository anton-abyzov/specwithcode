// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { RootPathError, readInsideRoot, scanCandidates } from "./scanCandidates.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name), "utf8");

async function tree(files: Record<string, string>): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-scan-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  return root;
}

const THEME_CSS = `:root { --brand: #5b6cff; --ink: #111; --line: #ddd; }
[data-theme="dark"] { --brand: #8a96ff; --ink: #eee; --line: #333; }`;

describe("scanCandidates", () => {
  it("lists candidates with token counts and groups a Weave system with its copies", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "@acme/site" }),
      "design/weave/tokens.json": fixture("weave/tokens.json.fixture"),
      "design/weave/weave.css": fixture("weave/weave.css.fixture"),
      "docs-site/src/css/weave.css": fixture("weave/weave.css.fixture"),
      "src/styles/theme.css": THEME_CSS,
      "src/styles/tiny.css": ".a { color: red }",
      "node_modules/pkg/tokens.css": THEME_CSS,
      ".cache/tokens.css": THEME_CSS,
      "README.md": "# not a candidate",
    });
    const result = await scanCandidates(root);
    expect(
      result.candidates.map((candidate) => [
        candidate.path,
        candidate.kind,
        candidate.tokenCount,
        candidate.componentCount,
      ]),
    ).toEqual([
      ["design/weave/tokens.json", "weave", 51, 0],
      ["design/weave/weave.css", "css", 39, 11],
      ["docs-site/src/css/weave.css", "css", 39, 11],
      ["src/styles/theme.css", "css", 3, 0],
    ]);
    const weave = result.suggestions.find((suggestion) => suggestion.key === "weave")!;
    expect(weave.name).toBe("Weave");
    expect(weave.paths).toEqual(["design/weave/tokens.json", "design/weave/weave.css"]);
    expect(weave.copies).toEqual(["docs-site/src/css/weave.css"]);
    expect(result.suggestions.find((suggestion) => suggestion.key === "pkg:")?.name).toBe("site");
    expect(
      result.candidates.find((candidate) => candidate.path === "src/styles/theme.css")?.modes,
    ).toEqual(["dark", "light"]);
  });

  it("never reads outside the root: escaping symlinks are skipped, folder symlinks not followed", async () => {
    const outside = await tree({ "secret/tokens.css": THEME_CSS, "secret/more.css": THEME_CSS });
    const root = await tree({ "src/theme.css": THEME_CSS });
    await NodeFSP.symlink(
      NodePath.join(outside, "secret/tokens.css"),
      NodePath.join(root, "src/linked-tokens.css"),
    );
    await NodeFSP.symlink(
      NodePath.join(outside, "secret"),
      NodePath.join(root, "src/linked-folder"),
    );
    await NodeFSP.symlink(
      NodePath.join(root, "src/theme.css"),
      NodePath.join(root, "src/alias.css"),
    );
    const result = await scanCandidates(root);
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      "src/alias.css",
      "src/theme.css",
    ]);
    expect(result.skipped).toEqual([
      { path: "src/linked-tokens.css", reason: "symlink-outside-root" },
    ]);
  });

  it("is deterministic across runs", async () => {
    const root = await tree({
      "design/weave/tokens.json": fixture("weave/tokens.json.fixture"),
      "design/weave/weave.css": fixture("weave/weave.css.fixture"),
      "b/theme.css": THEME_CSS,
      "a/theme.css": THEME_CSS,
    });
    expect(JSON.stringify(await scanCandidates(root))).toBe(
      JSON.stringify(await scanCandidates(root)),
    );
  });
});

describe("readInsideRoot", () => {
  it("refuses paths that leave the root", async () => {
    const outside = await tree({ "x.css": THEME_CSS });
    const root = await tree({ "a.css": THEME_CSS });
    await NodeFSP.symlink(NodePath.join(outside, "x.css"), NodePath.join(root, "link.css"));
    const realRoot = await NodeFSP.realpath(root);
    await expect(readInsideRoot(realRoot, "a.css")).resolves.toMatchObject({ path: "a.css" });
    for (const [path, reason] of [
      ["../x.css", "outside-root"],
      [NodePath.join(outside, "x.css"), "outside-root"],
      ["link.css", "symlink-outside-root"],
      ["missing.css", "missing"],
    ] as const) {
      const error = await readInsideRoot(realRoot, path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RootPathError);
      expect((error as RootPathError).reason).toBe(reason);
    }
  });
});
