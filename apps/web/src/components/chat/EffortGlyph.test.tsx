import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  EffortGlyph,
  effortGlyphLevel,
  effortLevelDescription,
  effortLevelLabel,
} from "./EffortGlyph";

const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"] as const;

describe("effortGlyphLevel", () => {
  it("fills one more bar per level up to Max", () => {
    expect(LEVELS.slice(0, 5).map((level) => effortGlyphLevel(level)?.bars)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("marks Ultracode and Ultrathink over a full meter", () => {
    expect(effortGlyphLevel("ultracode")).toEqual({ bars: 5, mark: "agents" });
    expect(effortGlyphLevel("Ultrathink")).toEqual({ bars: 5, mark: "sparkle" });
  });

  it("reads provider spellings and rejects values off the ladder", () => {
    expect(effortGlyphLevel("extra-high")?.bars).toBe(4);
    expect(effortGlyphLevel("minimal")?.bars).toBe(1);
    expect(effortGlyphLevel("none")?.bars).toBe(0);
    expect(effortGlyphLevel("build")).toBeNull();
    expect(effortGlyphLevel(null)).toBeNull();
  });
});

describe("EffortGlyph", () => {
  it("draws five bars and only the filled ones at full strength", () => {
    const markup = renderToStaticMarkup(<EffortGlyph value="high" />);
    expect(markup.match(/<rect/g)).toHaveLength(5);
    expect(markup.match(/data-filled="true"/g)).toHaveLength(3);
    expect(markup).not.toContain("data-effort-mark");
  });

  it("gives Ultracode and Ultrathink distinct marks", () => {
    expect(renderToStaticMarkup(<EffortGlyph value="ultracode" />)).toContain(
      'data-effort-mark="agents"',
    );
    expect(renderToStaticMarkup(<EffortGlyph value="ultrathink" />)).toContain(
      'data-effort-mark="sparkle"',
    );
  });
});

it("explains every Claude effort level in one line", () => {
  for (const level of LEVELS) {
    const description = effortLevelDescription(level);
    expect(description, level).toBeTruthy();
    expect(description!.length, level).toBeLessThanOrEqual(42);
  }
  expect(effortLevelDescription("build")).toBeNull();
});

it("names raw provider level ids and keeps real labels", () => {
  expect(effortLevelLabel("medium", "medium")).toBe("Medium");
  expect(effortLevelLabel("xhigh", "xhigh")).toBe("Extra High");
  expect(effortLevelLabel("xhigh", "Extra High")).toBe("Extra High");
  expect(effortLevelLabel("high", "Deep")).toBe("Deep");
});
