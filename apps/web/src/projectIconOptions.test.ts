import { describe, expect, it } from "vite-plus/test";
import {
  filterProjectEmojis,
  filterProjectIconNames,
  firstEmoji,
  PROJECT_EMOJIS,
  PROJECT_ICON_CHOICES,
  projectIconColorClassName,
} from "./projectIconOptions";

describe("projectIconOptions", () => {
  it("searches across the full Lucide set", () => {
    expect(filterProjectIconNames("alarm clock")).toContain("alarm-clock");
    expect(filterProjectIconNames("alarm  \tclock")).toContain("alarm-clock");
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });

  it("maps persisted colors to theme-aware classes", () => {
    expect(projectIconColorClassName("violet")).toBe("text-violet-600 dark:text-violet-400");
  });
});

describe("project icon choices", () => {
  it("offers a large curated set of real, distinct Lucide icons", async () => {
    const { iconNames } = await import("lucide-react/dynamic");
    const known = new Set<string>(iconNames);
    expect(PROJECT_ICON_CHOICES.length).toBeGreaterThanOrEqual(200);
    expect(new Set(PROJECT_ICON_CHOICES).size).toBe(PROJECT_ICON_CHOICES.length);
    expect(PROJECT_ICON_CHOICES.filter((name) => !known.has(name))).toEqual([]);
  });

  it("finds icons by everyday words and ranks exact names first", () => {
    expect(filterProjectIconNames("ai").slice(0, 5)).toContain("bot");
    expect(filterProjectIconNames("home").slice(0, 3)).toContain("house");
    expect(filterProjectIconNames("rocket")[0]).toBe("rocket");
  });

  it("filters emoji by label", () => {
    expect(filterProjectEmojis("rocket").map((option) => option.emoji)).toEqual(["🚀"]);
    expect(filterProjectEmojis("")).toHaveLength(PROJECT_EMOJIS.length);
  });
});
