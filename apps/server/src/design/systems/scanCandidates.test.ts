// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  RootPathError,
  readInsideRoot,
  readInsideRootHooks,
  scanCandidates,
} from "./scanCandidates.ts";
import { COPY_SHARE, sharedShare } from "./scanRanking.ts";
import { pickSwatches, previewScan, swatchColor } from "./scanPreview.ts";
import {
  APP_DUPLICATE_STYLES,
  APP_STYLES,
  SNAP_COPY,
  STATUS_COPY,
  UIKIT_BARREL,
  UIKIT_TOKENS,
  UMBRELLA_FILES,
  layOutUmbrella,
} from "./umbrellaFixture.testkit.ts";

const temps: string[] = [];
afterEach(async () => {
  delete readInsideRootHooks.beforeOpen;
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

const umbrella = async () => {
  const root = await layOutUmbrella();
  temps.push(root);
  return root;
};

const UIKIT_KEY = "pkg:repositories/acme/uikit";
const APP_KEY = "pkg:repositories/acme/app-web";
const PROVENANCE = { source: "file", location: "a.css", extractor: "css@1" } as const;

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

describe("scanCandidates on an umbrella of repositories", () => {
  it("offers the UI kit first, with its copied tokens and the duplicate checkout folded in", async () => {
    const result = await scanCandidates(await umbrella());
    // By key alone app-web would come first and the copies would be suggestions of their own.
    expect(
      result.suggestions.map(({ key, name, paths, copies }) => [key, name, paths, copies]),
    ).toEqual([
      [UIKIT_KEY, "uikit", [UIKIT_BARREL, UIKIT_TOKENS], [STATUS_COPY, SNAP_COPY]],
      [APP_KEY, "app-web", [APP_STYLES], [APP_DUPLICATE_STYLES]],
      // Only a small stylesheet is left after its copy moved: no paths, so it sinks.
      ["pkg:repositories/acme/status-site", "status-site", [], []],
    ]);
    const owner = Object.fromEntries(
      result.candidates.map((candidate) => [candidate.path, candidate.suggestion]),
    );
    expect(owner).toMatchObject({
      [UIKIT_TOKENS]: UIKIT_KEY,
      [STATUS_COPY]: UIKIT_KEY,
      [SNAP_COPY]: UIKIT_KEY,
      [APP_DUPLICATE_STYLES]: APP_KEY,
    });
    expect(result).toMatchObject({ filesSeen: UMBRELLA_FILES, truncated: false, skipped: [] });
  });

  it("ranks a design-system package with light and dark above a bigger app stylesheet", async () => {
    const vars = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `  --${prefix}-${index}: ${index}px;`).join("\n");
    const root = await tree({
      "apps/admin/package.json": JSON.stringify({ name: "admin" }),
      "apps/admin/src/admin.css": `:root {\n${vars("admin", 60)}\n}`,
      "packages/theme/package.json": JSON.stringify({
        name: "@acme/theme",
        description: "Design tokens",
      }),
      "packages/theme/theme.css": `:root {\n${vars("theme", 20)}\n}\n[data-theme="dark"] { --theme-0: 1px; }`,
    });
    const result = await scanCandidates(root);
    // 20 tokens + 50 for light and dark + 100 for "Design tokens" beats 60 tokens.
    expect(result.suggestions.map((suggestion) => suggestion.key)).toEqual([
      "pkg:packages/theme",
      "pkg:apps/admin",
    ]);
  });

  it("walks a nested git checkout as its own repository, named by its folder", async () => {
    const root = await umbrella();
    await NodeFSP.mkdir(NodePath.join(root, "tools/snap/.git"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "tools/snap/.git/HEAD"), "ref: refs/heads/main\n");
    await NodeFSP.writeFile(
      NodePath.join(root, "tools/snap/static/frame.css"),
      `:root {\n${Array.from({ length: 12 }, (_, index) => `  --frame-${index}: ${index}px;`).join("\n")}\n}`,
    );
    const result = await scanCandidates(root);
    // Without the checkout, frame.css would belong to the workspace's own package.
    expect(result.suggestions.find((suggestion) => suggestion.key === "pkg:tools/snap")).toEqual({
      key: "pkg:tools/snap",
      name: "snap",
      paths: ["tools/snap/static/frame.css"],
      copies: [],
    });
    expect(result.suggestions[0]!.copies).toEqual([STATUS_COPY, SNAP_COPY]);
    expect(result.filesSeen).toBe(UMBRELLA_FILES + 1);
  });

  it("gives every repository its own file cap", async () => {
    const root = await umbrella();
    // The largest checkout (uikit) has 6 files: one walk of 6 would have stopped in the first repository.
    const whole = await scanCandidates(root, { maxFilesSeen: 6 });
    expect(whole).toMatchObject({ filesSeen: UMBRELLA_FILES, truncated: false });
    expect(whole.suggestions[0]).toMatchObject({
      key: UIKIT_KEY,
      paths: [UIKIT_BARREL, UIKIT_TOKENS],
    });

    // A repository over its cap is cut short; the others are still walked whole.
    const capped = await scanCandidates(root, { maxFilesSeen: 4 });
    const paths = capped.candidates.map((candidate) => candidate.path);
    expect(capped.truncated).toBe(true);
    expect(paths).not.toContain(UIKIT_TOKENS);
    expect(paths).toEqual(expect.arrayContaining([APP_STYLES, STATUS_COPY, SNAP_COPY]));
  });

  it("returns what it found at the time limit, design-system repositories first", async () => {
    const root = await umbrella();
    let clock = 0;
    // Time runs out the moment the UI kit's tokens are read.
    readInsideRootHooks.beforeOpen = async (real) => {
      // `real` is a native path; the fixture names are POSIX, so compare with forward slashes.
      if (real.replaceAll("\\", "/").endsWith(UIKIT_TOKENS)) clock = 10_000;
    };
    const result = await scanCandidates(root, { now: () => clock, timeLimitMs: 5_000 });
    expect(result.truncated).toBe(true);
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([UIKIT_TOKENS]);
    expect(result.suggestions).toEqual([
      { key: UIKIT_KEY, name: "uikit", paths: [UIKIT_TOKENS], copies: [] },
    ]);
  });

  it("previews the top suggestions in memory: counts, modes, swatches and sources", async () => {
    const root = await NodeFSP.realpath(await umbrella());
    const scan = await scanCandidates(root);
    const before = await NodeFSP.readdir(root, { recursive: true });
    const previews = await previewScan(root, scan);
    expect([...previews.keys()]).toEqual([UIKIT_KEY, APP_KEY]);
    const preview = previews.get(UIKIT_KEY)!;
    expect(preview).toMatchObject({ tokens: 17, components: 3, modes: ["light", "dark"] });
    expect(preview.swatches).toHaveLength(8);
    expect(preview.swatches.slice(0, 3)).toEqual([
      { name: "acme-brand", value: "#4f46e5", darkValue: "#818cf8" },
      // `var(--acme-orange)` resolved; the accent has no dark value of its own.
      { name: "acme-accent", value: "#f97316" },
      { name: "acme-bg", value: "#fafafa", darkValue: "#0b0f14" },
    ]);
    expect(preview.sources).toEqual([
      { path: UIKIT_TOKENS, kind: "css", tokens: 17, components: 0 },
      { path: UIKIT_BARREL, kind: "components", tokens: 0, components: 3 },
    ]);
    expect(previews.get(APP_KEY)).toMatchObject({ tokens: 12, components: 0, modes: ["default"] });
    // Nothing was written.
    expect(await NodeFSP.readdir(root, { recursive: true })).toEqual(before);
  });

  it("keeps only paintable swatch colors and calls 80% shared names a copy", () => {
    expect(swatchColor("var(--x)")).toBeNull();
    expect(swatchColor("transparent")).toBeNull();
    expect(swatchColor("12px")).toBeNull();
    expect(swatchColor("color-mix(in srgb, #fff 40%, #000)")).toBe(
      "color-mix(in srgb, #fff 40%, #000)",
    );
    expect(swatchColor(" #ABCDEF ")).toBe("#ABCDEF");
    expect(
      pickSwatches([
        {
          name: "unresolved",
          type: "color",
          values: { default: { raw: "var(--y)", resolved: null, provenance: PROVENANCE } },
        },
        {
          name: "gap",
          type: "dimension",
          values: { default: { raw: "4px", resolved: "4px", provenance: PROVENANCE } },
        },
      ]),
    ).toEqual([]);
    const names = (count: number) => new Set(Array.from({ length: count }, (_, i) => `n${i}`));
    expect(sharedShare(names(10), names(8))).toBe(0.8);
    expect(sharedShare(names(10), names(7)) < COPY_SHARE).toBe(true);
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
