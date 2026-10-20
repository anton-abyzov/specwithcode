import { describe, expect, it } from "vite-plus/test";

import {
  isRetiredProjectIconName,
  projectEmojiForDisplay,
  projectIconNameForDisplay,
} from "./projectIconLegacy.ts";

describe("projectIconNameForDisplay", () => {
  it("draws saved brain and padlock icons as their replacements", () => {
    expect(projectIconNameForDisplay("brain")).toBe("lightbulb");
    expect(projectIconNameForDisplay("brain-circuit")).toBe("cpu");
    expect(projectIconNameForDisplay("lock")).toBe("shield");
    expect(projectIconNameForDisplay("lock-keyhole-open")).toBe("shield");
    expect(projectIconNameForDisplay("user-lock")).toBe("shield");
    expect(projectIconNameForDisplay("brain-cog")).toBe("cpu");
  });

  it("leaves every other icon alone", () => {
    for (const name of ["clock", "blocks", "folder-code", "shield", "bot", "alarm-clock-off"]) {
      expect(projectIconNameForDisplay(name)).toBe(name);
    }
  });
});

describe("isRetiredProjectIconName", () => {
  it("matches whole name segments only", () => {
    expect(isRetiredProjectIconName("file-lock")).toBe(true);
    expect(isRetiredProjectIconName("brain")).toBe(true);
    expect(isRetiredProjectIconName("clock-alert")).toBe(false);
    expect(isRetiredProjectIconName("blocks")).toBe(false);
    expect(isRetiredProjectIconName("unlock-keyhole")).toBe(true);
    expect(isRetiredProjectIconName("door-closed-locked")).toBe(true);
  });
});

describe("projectEmojiForDisplay", () => {
  it("swaps brain and padlock emoji and keeps the rest", () => {
    expect(projectEmojiForDisplay("\u{1F9E0}")).toBe("\u{1F4A1}");
    expect(projectEmojiForDisplay("\u{1F512}")).toBe("\u{1F6E1}\u{FE0F}");
    expect(projectEmojiForDisplay("\u{1F680}")).toBe("\u{1F680}");
  });
});
