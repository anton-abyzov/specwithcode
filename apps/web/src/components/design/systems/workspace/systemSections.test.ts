import { describe, expect, it } from "vite-plus/test";

import {
  buildSections,
  familyKeyOf,
  groupTokensByName,
  humanizeKey,
  isSectionId,
  placeToken,
  searchSections,
  sharedPrefix,
  typographyParts,
  visibleSections,
} from "./systemSections";
import { TEST_SYSTEM, testToken } from "./testSystem";

describe("section order", () => {
  it("puts the fixed head first, extra families next, then Components and Assets", () => {
    const sections = buildSections(TEST_SYSTEM);
    expect(sections.map((section) => section.title)).toEqual([
      "Overview",
      "Colors",
      "Typography",
      "Spacing",
      "Corner radius",
      "Shadows",
      "Duration",
      "Easing",
      "Breakpoint",
      "Z index",
      "Control",
      "Opacity",
      "Letter case",
      "Components",
      "Assets",
    ]);
    expect(sections.map((section) => section.id)).toContain("family-zIndex");
    expect(sections.find((section) => section.id === "colors")?.tokens).toHaveLength(9);
  });

  it("marks empty core sections as starters and hides them from read-only viewers", () => {
    const sections = buildSections({ tokens: [] });
    expect(sections.filter((section) => section.starter).map((section) => section.id)).toEqual([
      "colors",
      "type",
      "spacing",
      "corners",
      "shadows",
    ]);
    expect(
      visibleSections(sections, { canEdit: false, componentCount: 0 }).map((s) => s.id),
    ).toEqual(["readme", "assets"]);
    expect(visibleSections(sections, { canEdit: true, componentCount: 0 })).toHaveLength(8);
  });

  it("gives a family the group its tokens share, so new tokens stay there", () => {
    const motion = buildSections({
      tokens: [testToken("duration-fast", "duration", "motion", "100ms")],
    });
    const duration = motion.find((section) => section.id === "family-duration");
    expect(duration?.group).toBe("motion");
    const zIndex = buildSections(TEST_SYSTEM).find((section) => section.id === "family-zIndex");
    expect(zIndex?.group).toBe("zIndex");
  });
});

describe("placing a token", () => {
  it("reads the type first, then the group, then the name", () => {
    expect(placeToken({ name: "tide-high", type: "color", group: "tide" })).toEqual({
      kind: "colors",
    });
    expect(placeToken({ name: "font-sans", type: "fontFamily", group: "type" })).toEqual({
      kind: "typography",
    });
    expect(placeToken({ name: "text-sm", type: "dimension", group: "type" })).toEqual({
      kind: "typography",
    });
    expect(placeToken({ name: "gap-lg", type: "dimension", group: "spacing" })).toEqual({
      kind: "spacing",
    });
    expect(placeToken({ name: "x", type: "number", group: "z-index" })).toEqual({
      kind: "family",
      key: "zIndex",
    });
    expect(placeToken({ name: "ease-out", type: "easing", group: "motion" })).toEqual({
      kind: "family",
      key: "easing",
    });
    expect(placeToken({ name: "bp-md", type: "dimension", group: "layout" })).toEqual({
      kind: "family",
      key: "breakpoint",
    });
    expect(placeToken({ name: "chip-pad", type: "dimension", group: "component/chip" })).toEqual({
      kind: "family",
      key: "control",
    });
    expect(placeToken({ name: "rounded-lg", type: "dimension", group: "size" })).toEqual({
      kind: "radius",
    });
    expect(placeToken({ name: "overlay-opacity", type: "number" })).toEqual({
      kind: "family",
      key: "opacity",
    });
    expect(placeToken({ name: "thing", type: "other", group: "font_feature" })).toEqual({
      kind: "family",
      key: "fontFeature",
    });
  });
});

describe("keys and titles", () => {
  it("camel-cases groups and humanizes keys", () => {
    expect(familyKeyOf("z-index")).toBe("zIndex");
    expect(familyKeyOf("font_size")).toBe("fontSize");
    expect(familyKeyOf("Breakpoint")).toBe("breakpoint");
    expect(humanizeKey("zIndex")).toBe("Z index");
    expect(humanizeKey("breakpoint")).toBe("Breakpoint");
    expect(humanizeKey("line_height")).toBe("Line height");
    expect(humanizeKey("font-size")).toBe("Font size");
  });

  it("knows which hashes name sections", () => {
    expect(isSectionId("colors")).toBe(true);
    expect(isSectionId("family-zIndex")).toBe(true);
    expect(isSectionId("family-")).toBe(false);
    expect(isSectionId("elsewhere")).toBe(false);
  });
});

describe("color groups", () => {
  const names = (list: string[]) =>
    groupTokensByName(list.map((name) => testToken(name, "color", "color", "#000"))).map(
      (group) => [group.label, group.tokens.map((token) => token.name)],
    );

  it("groups by the first hyphen segment and puts bare names under Palette", () => {
    expect(names(["color-ink", "color-line", "accent-tenant", "sig"])).toEqual([
      ["color", ["color-ink", "color-line"]],
      ["accent", ["accent-tenant"]],
      ["Palette", ["sig"]],
    ]);
  });

  it("strips the prefix every name shares", () => {
    expect(sharedPrefix(["wv-ink", "wv-line-strong", "wv-brand-500"])).toBe("wv-");
    expect(sharedPrefix(["wv-ink"])).toBe("");
    expect(names(["wv-ink-1", "wv-ink-2", "wv-brand"])).toEqual([
      ["ink", ["wv-ink-1", "wv-ink-2"]],
      ["Palette", ["wv-brand"]],
    ]);
  });

  it("keeps a numbered scale under its stem and a bare name with its own group", () => {
    expect(names(["blue-gray-100", "blue-gray-200", "blue-500", "surface", "surface-2"])).toEqual([
      ["blue-gray", ["blue-gray-100", "blue-gray-200"]],
      ["blue", ["blue-500"]],
      ["surface", ["surface", "surface-2"]],
    ]);
  });
});

describe("typography parts", () => {
  it("splits styles from families and other type values", () => {
    const parts = typographyParts(
      buildSections(TEST_SYSTEM).find((section) => section.id === "type")!.tokens,
    );
    expect(parts.sets.map((set) => set.label)).toEqual(["Styles"]);
    expect(parts.sets[0]!.tokens.map((token) => token.name)).toEqual(["type-body", "type-kicker"]);
    expect(parts.families.map((token) => token.name)).toEqual(["font-sans"]);
    expect(parts.other).toEqual([]);
  });
});

describe("nav search", () => {
  it("lists matching sections and items, capped per section", () => {
    const sections = buildSections(TEST_SYSTEM);
    const result = searchSections(sections, "tide", ["Button", "TideChart"]);
    expect(result.matches.map((match) => [match.section.id, match.items])).toEqual([
      ["colors", ["tide-high", "tide-low"]],
      ["components", ["TideChart"]],
    ]);
    expect(result.total).toBe(3);
    expect(searchSections(sections, "radius").matches.map((m) => m.section.id)).toEqual([
      "corners",
    ]);
    expect(searchSections(sections, "zzz").matches).toEqual([]);
  });
});
