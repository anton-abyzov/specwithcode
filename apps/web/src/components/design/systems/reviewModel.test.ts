import type {
  DesignSystemProposal,
  DesignSystemSummary,
  DesignToken,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConfirmInput,
  EMPTY_SELECTION,
  failureText,
  filterSystems,
  isRescannable,
  readTokensFiles,
  sourcesLabel,
  swatchColor,
  toggleItems,
  writeCount,
} from "./reviewModel";

const token = (name: string, light: string): DesignToken => ({
  name,
  type: "color",
  values: {
    light: {
      raw: light,
      resolved: light,
      provenance: { source: "file", location: "tokens.json", line: 3, extractor: "weave" },
    },
  },
});

const proposal = (target: DesignSystemProposal["target"]): DesignSystemProposal =>
  ({
    id: "p1",
    owner: { kind: "playground" },
    origin: "code",
    createdAt: "2026-10-20T10:00:00Z",
    createdBy: { kind: "user" },
    target,
    system: { name: "Weave", modes: [{ id: "light", name: "Light" }] },
    tokens: [
      { name: "a", change: "added", token: token("a", "#fff") },
      { name: "b", change: "changed", token: token("b", "#000"), previous: token("b", "#111") },
      { name: "c", change: "removed", token: token("c", "#222") },
      { name: "d", change: "unchanged", token: token("d", "#333") },
    ],
    components: [
      { id: "btn", change: "added", component: { id: "btn" } },
      { id: "card", change: "unchanged", component: { id: "card" } },
    ],
    findings: [],
  }) as unknown as DesignSystemProposal;

describe("review selection", () => {
  it("excludes only unticked items that change something", () => {
    let selection = toggleItems(EMPTY_SELECTION, "tokens", ["a", "c", "d"], false);
    selection = toggleItems(selection, "components", ["btn"], false);
    const input = buildConfirmInput(proposal({ systemId: "weave", revision: 2 }), selection, "X");
    expect(input).toEqual({
      proposalId: "p1",
      excludeTokens: ["a", "c"],
      excludeComponents: ["btn"],
    });
  });

  it("sends a trimmed name only for a new system", () => {
    expect(buildConfirmInput(proposal(null), EMPTY_SELECTION, "  Acme UI ").name).toBe("Acme UI");
    expect(buildConfirmInput(proposal(null), EMPTY_SELECTION, "  ").name).toBeUndefined();
  });

  it("counts ticked changes and reaches zero when everything is unticked", () => {
    const p = proposal({ systemId: "weave", revision: 2 });
    expect(writeCount(p, EMPTY_SELECTION)).toBe(4);
    let none = toggleItems(EMPTY_SELECTION, "tokens", ["a", "b", "c"], false);
    none = toggleItems(none, "components", ["btn"], false);
    expect(writeCount(p, none)).toBe(0);
    expect(writeCount(p, toggleItems(none, "tokens", ["b"], true))).toBe(1);
  });
});

describe("systems list", () => {
  const summary = (name: string, kinds: string[], owner = "project") =>
    ({
      ref: { owner: { kind: owner, projectId: "web" }, systemId: name, path: "" },
      name,
      ownerLabel: "Web",
      sources: kinds.map((kind) => ({ kind, location: "x", readAt: "" })),
    }) as unknown as DesignSystemSummary;

  it("labels sources by kind", () => {
    expect(sourcesLabel(summary("a", ["file", "file"]).sources)).toBe("Code · 2 files");
    expect(sourcesLabel(summary("a", ["figma-export"]).sources)).toBe("Figma export");
    expect(sourcesLabel(summary("a", ["figma-desktop", "file"]).sources)).toBe(
      "Code · 1 file + Figma desktop",
    );
    expect(sourcesLabel([])).toBe("None");
  });

  it("offers rescan only for project systems read entirely from files", () => {
    expect(isRescannable(summary("a", ["file"]))).toBe(true);
    expect(isRescannable(summary("a", ["file", "figma-export"]))).toBe(false);
    expect(isRescannable(summary("a", ["file"], "playground"))).toBe(false);
    expect(isRescannable(summary("a", []))).toBe(false);
  });

  it("filters by name, case-insensitively, sorted", () => {
    const systems = [summary("Weave", []), summary("Acme UI", []), summary("weave app", [])];
    expect(filterSystems(systems, "WEAVE").map((s) => s.name)).toEqual(["Weave", "weave app"]);
    expect(filterSystems(systems, "").map((s) => s.name)).toEqual([
      "Acme UI",
      "Weave",
      "weave app",
    ]);
  });
});

describe("values and errors", () => {
  it("paints swatches only for resolved colors", () => {
    const value = (resolved: string | null) => ({ raw: "x", resolved, provenance: {} }) as never;
    expect(swatchColor(value("#0a84ff"))).toBe("#0a84ff");
    expect(swatchColor(value("oklch(0.7 0.1 250)"))).toBe("oklch(0.7 0.1 250)");
    expect(swatchColor(value("12px"))).toBeNull();
    expect(swatchColor(value(null))).toBeNull();
  });

  it("never paints a value that could load a URL", () => {
    const value = (resolved: string) => ({ raw: "x", resolved, provenance: {} }) as never;
    for (const hostile of [
      "rgb(0 0 0) url(https://example.com/x.png)",
      "url(https://example.com/x.png)",
      "#fff url(//example.com/x)",
      'color-mix(in srgb, url("https://example.com") 50%, red)',
      "rgb(0 0 0);background-image:url(x)",
      "var(--ink)",
    ]) {
      expect(swatchColor(value(hostile)), hostile).toBeNull();
    }
    expect(swatchColor(value("rgb(9 9 11 / 0.45)"))).toBe("rgb(9 9 11 / 0.45)");
    expect(swatchColor(value("color-mix(in srgb, #003366 20%, transparent)"))).toBe(
      "color-mix(in srgb, #003366 20%, transparent)",
    );
    expect(swatchColor(value("#2f62f080"))).toBe("#2f62f080");
  });

  it("explains a revision conflict plainly", () => {
    const text = failureText(
      { _tag: "DesignError", code: "conflict", detail: "x", currentRevision: 4 },
      "fallback",
    );
    expect(text).toMatch(/changed after the proposal was made \(it is now at revision 4\)/);
    expect(failureText(new Error("Boom"), "fallback")).toBe("Boom");
    expect(failureText(null, "fallback")).toBe("fallback");
  });
});

describe("readTokensFiles", () => {
  const file = (name: string, contents: string, size = contents.length) => ({
    name,
    size,
    text: async () => contents,
  });

  it("reads JSON files as text with their names", async () => {
    const read = await readTokensFiles([
      file("Brand.Light.tokens.json", '{"a":1}'),
      file("Brand.Dark.tokens.json", '{"a":2}'),
    ]);
    expect(read).toEqual({
      ok: true,
      files: [
        { fileName: "Brand.Light.tokens.json", contents: '{"a":1}' },
        { fileName: "Brand.Dark.tokens.json", contents: '{"a":2}' },
      ],
    });
  });

  it("refuses other types, oversized files and empty picks", async () => {
    expect(await readTokensFiles([file("theme.css", "")])).toEqual({
      ok: false,
      message: "theme.css is not a .json file.",
    });
    expect(await readTokensFiles([file("big.json", "", 3 * 1024 * 1024)])).toEqual({
      ok: false,
      message: "big.json is larger than 2 MB.",
    });
    expect((await readTokensFiles([])).ok).toBe(false);
  });
});
