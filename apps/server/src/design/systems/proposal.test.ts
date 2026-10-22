// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { DesignSystemProposal } from "@specweave-studio/contracts";

import { applyReview, buildProposal, extractFromCode, extractFromTokensFiles } from "./proposal.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});
const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name), "utf8");

async function tree(files: Record<string, string>): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-proposal-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  return NodeFSP.realpath(root);
}

const proposalFor = (
  sourced: Awaited<ReturnType<typeof extractFromCode>>,
  previous: DesignSystemProposal["system"] | null = null,
) =>
  buildProposal({
    id: "p1",
    owner: { kind: "playground" },
    origin: "code",
    createdBy: { kind: "user" },
    now: "2026-10-20T12:00:00.000Z",
    sourced,
    previous,
    systemId: "weave",
    name: sourced.suggestedName ?? "System",
  });

describe("extractFromCode", () => {
  it("imports Weave from tokens.json with weave.css classes, cross-checks and copy drift", async () => {
    const css = fixture("weave/weave.css.fixture");
    const root = await tree({
      "design/weave/tokens.json": fixture("weave/tokens.json.fixture"),
      "design/weave/weave.css": css,
      "site/weave.css": css.replace(
        "  --wv-brand-tile: #5b6cff;\n",
        "  --wv-brand-tile: #5b6cff;\n  --wv-scrim: rgba(0,0,0,.4);\n",
      ),
      "docs/weave.css": css,
    });
    const sourced = await extractFromCode(root, [
      "design/weave/weave.css",
      "design/weave/tokens.json",
    ]);
    expect(sourced.suggestedName).toBe("Weave");
    expect(sourced.extraction.tokens.filter((token) => token.type === "color")).toHaveLength(18);
    expect(sourced.extraction.components).toHaveLength(11);
    expect(sourced.stylesheet).toBe(css);
    expect(sourced.sources.map((source) => source.location)).toEqual([
      "design/weave/tokens.json",
      "design/weave/weave.css",
    ]);
    const drift = sourced.extraction.findings.filter((finding) => finding.code === "drift");
    expect(
      drift.map((finding) => [finding.location, finding.message.includes("--wv-scrim")]),
    ).toEqual([["site/weave.css", true]]);
    expect(
      sourced.extraction.findings.some(
        (finding) => finding.code === "copy" && finding.location === "docs/weave.css",
      ),
    ).toBe(true);
  });

  it("links a theme file to the stylesheet that reads its keys and resolves across files", async () => {
    const roles = [
      "canvas",
      "text",
      "accent",
      "border",
      "muted",
      "surface",
      "focus",
      "input",
      "ring",
    ];
    const theme = `export const LIGHT_THEME_COLORS = {\n${roles.map((role, index) => `  ${role}: "#00000${index}",`).join("\n")}\n};\n`;
    const sheet = `:root {\n${roles.map((role) => `  --${role}-color: var(--app-theme-${role});`).join("\n")}\n}\n`;
    const root = await tree({
      "src/theme.ts": theme,
      "src/app.css": sheet,
      "src/base.css": ":root { --gap: 4px; --pad: var(--gap); --x: 1px; }",
    });
    const sourced = await extractFromCode(root, ["src/theme.ts", "src/app.css", "src/base.css"]);
    const names = sourced.extraction.tokens.map((token) => token.name);
    expect(names).toContain("app-theme-canvas");
    expect(
      sourced.extraction.tokens.find((token) => token.name === "pad")!.values.light ??
        sourced.extraction.tokens.find((token) => token.name === "pad")!.values.default,
    ).toMatchObject({ resolved: "4px" });
  });

  it("refuses paths outside the root and says so", async () => {
    const root = await tree({ "a.css": ":root { --a: 1px; --b: 2px; --c: 3px; }" });
    const sourced = await extractFromCode(root, ["../outside.css", "a.css"]);
    expect(sourced.sources.map((source) => source.location)).toEqual(["a.css"]);
    expect(
      sourced.extraction.findings.find((finding) => finding.code === "unreadable")?.message,
    ).toContain("outside-root");
  });

  it("gives byte-identical extractions for the same bytes", async () => {
    const root = await tree({
      "design/weave/tokens.json": fixture("weave/tokens.json.fixture"),
      "design/weave/weave.css": fixture("weave/weave.css.fixture"),
    });
    const paths = ["design/weave/tokens.json", "design/weave/weave.css"];
    expect(JSON.stringify(await extractFromCode(root, paths))).toBe(
      JSON.stringify(await extractFromCode(root, paths)),
    );
  });
});

describe("review", () => {
  it("diffs against the current system and writes only confirmed items", async () => {
    const root = await tree({ "t.css": ":root { --a: 1px; --b: 2px; --c: 3px; }" });
    const first = proposalFor(await extractFromCode(root, ["t.css"]));
    expect(first.target).toBeNull();
    expect(first.tokens.map((change) => [change.name, change.change])).toEqual([
      ["a", "added"],
      ["b", "added"],
      ["c", "added"],
    ]);
    const written = applyReview(first, {
      excludeTokens: ["c"],
      excludeComponents: [],
      name: "Mine",
    });
    expect(written.name).toBe("Mine");
    expect(written.revision).toBe(0);
    expect(written.tokens.map((token) => token.name)).toEqual(["a", "b"]);

    // Next scan: a changed, b moved one line (unchanged), c still new, d new; nothing removed... then e removal.
    await NodeFSP.writeFile(
      NodePath.join(root, "t.css"),
      "\n:root { --a: 9px; --b: 2px; --d: 4px; }",
    );
    const second = proposalFor(await extractFromCode(root, ["t.css"]), written);
    expect(second.target).toEqual({ systemId: "weave", revision: 0 });
    expect(second.system.revision).toBe(1);
    expect(second.tokens.map((change) => [change.name, change.change])).toEqual([
      ["a", "changed"],
      ["b", "unchanged"],
      ["d", "added"],
    ]);
    const kept = applyReview(second, { excludeTokens: ["a"], excludeComponents: [] });
    expect(kept.tokens.find((token) => token.name === "a")!.values.default!.raw).toBe("1px");
    expect(kept.tokens.find((token) => token.name === "b")!.values.default!.provenance.line).toBe(
      2,
    );
    expect(kept.name).toBe("Mine");

    await NodeFSP.writeFile(
      NodePath.join(root, "t.css"),
      ":root { --b: 2px; --d: 4px; --e: 5px; }",
    );
    const third = proposalFor(await extractFromCode(root, ["t.css"]), kept);
    expect(third.tokens.find((change) => change.name === "a")?.change).toBe("removed");
    expect(
      applyReview(third, { excludeTokens: ["a"], excludeComponents: [] }).tokens.map(
        (token) => token.name,
      ),
    ).toContain("a");
    expect(
      applyReview(third, { excludeTokens: [], excludeComponents: [] }).tokens.map(
        (token) => token.name,
      ),
    ).not.toContain("a");
  });
});

describe("extractFromTokensFiles", () => {
  it("imports uploaded Figma exports without touching the disk", () => {
    const sourced = extractFromTokensFiles([
      {
        fileName: "Colors.Dark.tokens.json",
        contents: '{"bg": {"$type": "color", "$value": "#000"}}',
      },
      {
        fileName: "/Users/someone/Downloads/Colors.Light.tokens.json",
        contents: '{"bg": {"$type": "color", "$value": "#fff"}}',
      },
      { fileName: "notes.json", contents: '{"hello": 1}' },
    ]);
    expect(sourced.sources.map((source) => [source.kind, source.location])).toEqual([
      ["figma-export", "Colors.Dark.tokens.json"],
      ["figma-export", "Colors.Light.tokens.json"],
    ]);
    const bg = sourced.extraction.tokens[0]!;
    expect(bg.values.light!.provenance.location).toBe("Colors.Light.tokens.json#bg");
    expect(
      sourced.extraction.findings.find((finding) => finding.code === "unsupported")?.location,
    ).toBe("notes.json");
  });
});
