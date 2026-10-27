import { describe, expect, it } from "vite-plus/test";

import { contrastRatio, ratioLabel, TEXT_RATIO, textRole, tokenContrast } from "./contrast";
import { TEST_SYSTEM, testToken } from "./testSystem";

const LIGHT = { id: "light", name: "Light" };
const DARK = { id: "dark", name: "Dark" };

describe("contrast", () => {
  it("measures WCAG ratios, compositing see-through text", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("rgba(0, 0, 0, 0)", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("oklch(0.5 0.1 200)", "#ffffff")).toBeNull();
    // A see-through fill sits on the mode's ground, not on white.
    expect(contrastRatio("#E9E3FA", "rgba(124, 77, 222, 0.16)", "#0B0D12")).toBeGreaterThan(13);
  });

  it("labels a ratio without rounding a failure up to a pass", () => {
    expect(ratioLabel(14.26)).toBe("14.2:1");
    expect(ratioLabel(13.04)).toBe("13:1");
    expect(ratioLabel(4.49)).toBe("4.4:1");
  });

  it("knows which colors are text and what they sit on", () => {
    expect(textRole("color-ink")).toEqual({ on: "ground" });
    expect(textRole("wv-muted")).toBeNull();
    expect(textRole("color-text-muted")).toEqual({ on: "ground" });
    expect(textRole("color-on-brand")).toEqual({ on: "brand" });
    expect(textRole("color-brand")).toBeNull();
    expect(textRole("primary-foreground")).toEqual({ on: "primary", orGround: true });
    expect(textRole("color-foreground")).toEqual({ on: "ground" });
    expect(textRole("muted-fg")).toEqual({ on: "muted", orGround: true });
  });

  it("measures X-foreground on X, and on the ground when there is no X", () => {
    const background = testToken("background", "color", "color", "#fafafa", "#0b0d12");
    const primary = testToken("primary", "color", "color", "#1d4ed8", "#93c5fd");
    const onPrimary = testToken("primary-foreground", "color", "color", "#ffffff", "#0b0d12");
    const card = testToken("card-foreground", "color", "color", "#111111", "#f5f5f5");
    const system = { tokens: [background, primary, onPrimary, card], modes: TEST_SYSTEM.modes };
    const check = tokenContrast(onPrimary, system, LIGHT)!;
    expect(check.against).toBe("primary");
    expect(check.ratio).toBeGreaterThan(6);
    expect(tokenContrast(card, system, DARK)!.against).toBe("the page ground");
  });

  it("never measures text on another text color, an unreadable fill or a see-through fill with no ground", () => {
    const background = testToken("background", "color", "color", "#ffffff", "#0b0d12");
    const ink = testToken("text-primary", "color", "color", "#111111", "#f5f5f5");
    const primary = testToken("primary", "color", "color", "#4f8cff", "#4f8cff");
    const onPrimary = testToken("text-on-primary", "color", "color", "#ffffff", "#ffffff");
    const system = { tokens: [background, ink, primary, onPrimary], modes: TEST_SYSTEM.modes };
    const check = tokenContrast(onPrimary, system, LIGHT)!;
    expect(check.against).toBe("primary");
    expect(check.ratio).toBeLessThan(TEXT_RATIO);
    // X exists but is not hex or rgb(): no check, not a false failure on the ground.
    const named = testToken("brand", "color", "color", "oklch(0.5 0.2 270)");
    const onNamed = testToken("brand-foreground", "color", "color", "#ffffff");
    const unreadable = { tokens: [background, named, onNamed], modes: TEST_SYSTEM.modes };
    expect(tokenContrast(onNamed, unreadable, LIGHT)).toBeNull();
    // A see-through fill with no page ground to lay it on.
    const subtle = testToken("accent-subtle", "color", "color", "rgba(124, 77, 222, 0.16)");
    const onSubtle = testToken("on-accent-subtle", "color", "color", "#E9E3FA");
    const groundless = { tokens: [subtle, onSubtle], modes: TEST_SYSTEM.modes };
    expect(tokenContrast(onSubtle, groundless, DARK)).toBeNull();
    // A see-through page ground is no ground.
    const clear = testToken("background", "color", "color", "#0b0d1280");
    const light = testToken("text-primary", "color", "color", "#f5f5f5");
    expect(
      tokenContrast(light, { tokens: [clear, light], modes: TEST_SYSTEM.modes }, LIGHT),
    ).toBeNull();
    // on-background is text, never the ground, even when it comes first.
    const onBackground = testToken("on-background", "color", "color", "#1c1b1f");
    const page = testToken("background", "color", "color", "#fffbfe");
    const body = testToken("text-primary", "color", "color", "#111111");
    const ordered = { tokens: [onBackground, page, body], modes: TEST_SYSTEM.modes };
    expect(tokenContrast(body, ordered, LIGHT)!.ratio).toBeGreaterThan(15);
  });

  it("checks text on the page ground per mode, and on-X on X", () => {
    const ink = TEST_SYSTEM.tokens.find((token) => token.name === "color-ink")!;
    const light = tokenContrast(ink, TEST_SYSTEM, LIGHT)!;
    expect(light.against).toBe("the page ground");
    expect(light.ratio).toBeGreaterThan(10);
    expect(tokenContrast(ink, TEST_SYSTEM, DARK)!.ratio).toBeGreaterThan(10);
    const onBrand = testToken("color-on-brand", "color", "color", "#ffffff", "#0d1020");
    const system = { ...TEST_SYSTEM, tokens: [...TEST_SYSTEM.tokens, onBrand] };
    expect(tokenContrast(onBrand, system, LIGHT)!.against).toBe("color-brand");
  });

  it("says nothing without a ground or for a color that is not text", () => {
    const ink = testToken("color-ink", "color", "color", "#111111");
    expect(tokenContrast(ink, { tokens: [ink], modes: TEST_SYSTEM.modes }, LIGHT)).toBeNull();
    const brand = TEST_SYSTEM.tokens.find((token) => token.name === "color-brand")!;
    expect(tokenContrast(brand, TEST_SYSTEM, LIGHT)).toBeNull();
  });
});
