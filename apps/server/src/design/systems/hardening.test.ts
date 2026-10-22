// @effect-diagnostics nodeBuiltinImport:off - Lays out hostile fixture files.
/** Regression tests for hostile input and review edge cases (lead review of #511). */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { pickVariablesTool } from "../figma/FigmaDesktopMcpClient.ts";
import { assemble } from "./assemble.ts";
import { customPropertyNames, singleLine, sourceText } from "./common.ts";
import { collectCss, countCssCustomProperties } from "./extractCss.ts";
import { collectDtcg } from "./extractDtcg.ts";
import { MAX_EVALUATION_STEPS, collectTsTheme, loadTypeScript } from "./extractTsTheme.ts";
import { applyReview, buildProposal, extractFromCode } from "./proposal.ts";
import { RootPathError, preloadReader, readInsideRoot, scanCandidates } from "./scanCandidates.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-hardening-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  return NodeFSP.realpath(root);
}

const timed = <A>(run: () => A) => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

const CSS = (extra: string) =>
  `:root {\n${Array.from({ length: 12 }, (_, index) => `  --x-${index}: ${index}px;`).join("\n")}\n}\n${extra}`;

describe("hostile input stays linear", () => {
  const dashes = "-".repeat(100_000);
  const spaces = " ".repeat(100_000);

  it("reads custom property names from 100k dashes and spaces quickly", () => {
    for (const text of [dashes, `a${dashes}`, `--a${spaces}`, `${dashes}:`, `x { --${dashes}`]) {
      const { ms } = timed(() => customPropertyNames(text));
      expect(ms).toBeLessThan(250);
    }
    expect(customPropertyNames("a{--one: 1; b:--two;--three :3}")).toEqual(["one", "three"]);
    expect(timed(() => countCssCustomProperties(dashes)).ms).toBeLessThan(250);
  });

  it("folds a value's lines without a backtracking regex", () => {
    expect(timed(() => singleLine(`a${spaces}\n${spaces}b`)).ms).toBeLessThan(250);
    expect(singleLine("  a \n\n   b\n c  ")).toBe("a b c");
    const { ms } = timed(() =>
      collectCss(sourceText("a.css", `:root { --v: a${spaces}\n${spaces}b; }`)),
    );
    expect(ms).toBeLessThan(1_000);
  });

  it("scans a folder of hostile files in bounded time and skips what it cannot parse", async () => {
    const root = await tree({
      "styles/dashes.css": `${CSS("")}\n/* ${dashes} */ a { --${dashes} }`,
      "styles/spaces.css": `${CSS("")}\n:root { --v: a${spaces}\n${spaces}b; }`,
      "tokens/deep.tokens.json": `{"a": {"$value": ${"[".repeat(200_000)}`,
      "tokens/good.tokens.json": '{"brand": {"$type": "color", "$value": "#5b6cff"}}',
    });
    const started = performance.now();
    const scan = await scanCandidates(root);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(scan.skipped).toContainEqual({ path: "tokens/deep.tokens.json", reason: "unparseable" });
    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining(["styles/dashes.css", "styles/spaces.css", "tokens/good.tokens.json"]),
    );
  });

  it("refuses deeply nested JSON before parsing it", () => {
    expect(() =>
      collectDtcg(sourceText("deep.tokens.json", `{"a": ${"[".repeat(200_000)}`)),
    ).toThrow(/nested deeper/);
  });

  it("evaluates chained theme spreads once per binding, with a step cap", async () => {
    const ts = await loadTypeScript();
    const lines = [
      'const a0 = { a: "#111111", b: "#222222", c: "#333333", d: "#444444", e: "#555555" };',
    ];
    for (let index = 1; index <= 40; index += 1) {
      lines.push(`const a${index} = { ...a${index - 1}, x: a${index - 1}, y: a${index - 1} };`);
    }
    const { ms } = timed(() => collectTsTheme(ts, sourceText("theme.ts", lines.join("\n"))));
    expect(ms).toBeLessThan(2_000);
    expect(MAX_EVALUATION_STEPS).toBeGreaterThan(0);
  });
});

describe("paths the scan never reads", () => {
  it("refuses hidden, excluded and secret paths even when named", async () => {
    const root = await tree({
      ".env": "SECRET=1",
      ".git/config": "[core]",
      "node_modules/pkg/theme.css": CSS(""),
      "keys/server.pem": "-----BEGIN",
      "src/.hidden.css": CSS(""),
      "src/theme.css": CSS(""),
    });
    for (const path of [
      ".env",
      ".git/config",
      "node_modules/pkg/theme.css",
      "keys/server.pem",
      "src/.hidden.css",
    ]) {
      await expect(readInsideRoot(root, path)).rejects.toMatchObject({ reason: "excluded" });
      await expect(readInsideRoot(root, path)).rejects.toBeInstanceOf(RootPathError);
    }
    expect((await readInsideRoot(root, "src/theme.css")).path).toBe("src/theme.css");
    const sourced = await extractFromCode(root, [".env", "src/theme.css"]);
    expect(sourced.sources.map((source) => source.location)).toEqual(["src/theme.css"]);
    expect((await scanCandidates(root)).candidates.map((candidate) => candidate.path)).toEqual([
      "src/theme.css",
    ]);
  });

  it("reads a file once per scan when barrels share it", async () => {
    const root = await tree({ "ui/Button.tsx": "export const Button = () => null;" });
    const cache = new Map();
    const folders = new Map([["ui", ["ui/Button.tsx"]]]);
    const first = await preloadReader(root, folders, ["ui/Button.tsx"], cache);
    const second = await preloadReader(root, folders, ["ui/Button.tsx"], cache);
    expect(second.read("ui/Button.tsx")).toBe(first.read("ui/Button.tsx"));
  });
});

describe("Figma desktop tools", () => {
  it("calls only allowlisted read tools", () => {
    expect(pickVariablesTool([{ name: "set_variables" }, { name: "variable_writer" }])).toBeNull();
    expect(pickVariablesTool([{ name: "get_variable_defs" }])).toBe("get_variable_defs");
  });
});

describe("applyReview", () => {
  it("declares a mode the source dropped while a kept token still uses it", () => {
    const previous = buildProposal({
      id: "p0",
      owner: { kind: "playground" },
      origin: "code",
      createdBy: { kind: "user" },
      now: "2026-10-20T12:00:00.000Z",
      sourced: {
        extraction: assemble([
          collectCss(
            sourceText(
              "a.css",
              ':root { --ink: #111; --sea: #036; }\n.dark { --ink: #eee; }\n[data-theme="ocean"] { --sea: #024; }',
            ),
          ),
        ]),
        sources: [],
      },
      previous: null,
      systemId: "s",
      name: "S",
    }).system;
    expect(previous.modes.map((mode) => mode.id)).toEqual(["light", "dark", "ocean"]);
    const next = buildProposal({
      id: "p1",
      owner: { kind: "playground" },
      origin: "code",
      createdBy: { kind: "user" },
      now: "2026-10-20T13:00:00.000Z",
      sourced: {
        extraction: assemble([
          collectCss(sourceText("a.css", ":root { --ink: #111; }\n.dark { --ink: #eee; }")),
        ]),
        sources: [],
      },
      previous,
      systemId: "s",
      name: "S",
    });
    expect(next.tokens.find((change) => change.name === "sea")?.change).toBe("removed");
    const kept = applyReview(next, { excludeTokens: ["sea"], excludeComponents: [] });
    const declared = kept.modes.map((mode) => mode.id);
    expect(declared).toEqual(["light", "dark", "ocean"]);
    for (const token of kept.tokens) {
      for (const mode of Object.keys(token.values)) expect(declared).toContain(mode);
    }
    const dropped = applyReview(next, { excludeTokens: [], excludeComponents: [] });
    expect(dropped.modes.map((mode) => mode.id)).toEqual(["light", "dark"]);
  });
});
