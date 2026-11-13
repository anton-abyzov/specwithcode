import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_ICON_SUGGESTIONS,
  assistantIconChoices,
  assistantIconGlyph,
  distinctAssistantIconPlan,
  LEGACY_ASSISTANT_ICON,
  suggestAssistantIcon,
} from "./assistantIcon.ts";

const bell = LEGACY_ASSISTANT_ICON;
const holder = (id: string, environmentId: string, createdAt: string, icon: unknown = bell) => ({
  id,
  environmentId,
  createdAt,
  icon: icon as never,
});

describe("assistant icon suggestions", () => {
  it("offers icons with their own glyph and their own colour", () => {
    expect(new Set(ASSISTANT_ICON_SUGGESTIONS.map((icon) => icon.name)).size).toBe(
      ASSISTANT_ICON_SUGGESTIONS.length,
    );
    expect(new Set(ASSISTANT_ICON_SUGGESTIONS.map((icon) => icon.color)).size).toBe(
      ASSISTANT_ICON_SUGGESTIONS.length,
    );
  });

  it("keeps the bell for the first assistant", () => {
    expect(suggestAssistantIcon({ taken: [], seed: "anything" })).toEqual(bell);
    expect(suggestAssistantIcon({ taken: [null, undefined] })).toEqual(bell);
  });

  it("never suggests a glyph or colour another assistant uses", () => {
    for (const seed of ["a", "b", "machine-1", "machine-2", "zzz"]) {
      const taken = [bell, { kind: "lucide", name: "folder", color: "amber" }] as const;
      const icon = suggestAssistantIcon({ taken, seed });
      expect(icon.name).not.toBe("concierge-bell");
      expect(icon.color).not.toBe("violet");
      expect(icon.color).not.toBe("amber");
    }
  });

  it("varies the suggestion with the seed", () => {
    const names = new Set(
      Array.from(
        { length: 40 },
        (_, index) => suggestAssistantIcon({ taken: [bell], seed: `seed-${index}` }).name,
      ),
    );
    expect(names.size).toBeGreaterThan(3);
  });

  it("treats the same glyph in another colour as the same icon", () => {
    const icon = suggestAssistantIcon({
      taken: [{ kind: "lucide", name: "concierge-bell", color: "red" }],
    });
    expect(assistantIconGlyph(icon)).not.toBe("lucide:concierge-bell");
  });

  it("still answers when every suggestion is used", () => {
    expect(suggestAssistantIcon({ taken: ASSISTANT_ICON_SUGGESTIONS })).toBeDefined();
  });

  it("lists the suggestion first and used icons last", () => {
    const choices = assistantIconChoices({ taken: [bell], seed: "x" });
    expect(choices).toHaveLength(ASSISTANT_ICON_SUGGESTIONS.length);
    expect(choices[0]!.taken).toBe(false);
    expect(choices.at(-1)).toMatchObject({ name: "concierge-bell", taken: true });
  });
});

describe("distinct icons for existing assistants", () => {
  it("changes nothing for one assistant", () => {
    expect(distinctAssistantIconPlan([holder("a", "m1", "2026-01-01")])).toEqual([]);
  });

  it("leaves the earliest on the bell and gives each other one its own icon", () => {
    const plan = distinctAssistantIconPlan([
      holder("c", "m3", "2026-03-01"),
      holder("a", "m1", "2026-01-01"),
      holder("b", "m2", "2026-02-01"),
    ]);
    expect(plan.map((change) => change.id)).toEqual(["b", "c"]);
    const glyphs = new Set([bell.name, ...plan.map((change) => change.icon.name)]);
    expect(glyphs.size).toBe(3);
  });

  it("gives every client the same plan whatever order it lists them in", () => {
    const assistants = [
      holder("a", "m1", "2026-01-01"),
      holder("b", "m2", "2026-01-01"),
      holder("c", "m3", "2026-01-01"),
    ];
    expect(distinctAssistantIconPlan(assistants)).toEqual(
      distinctAssistantIconPlan(assistants.toReversed()),
    );
  });

  it("never touches an icon somebody chose, and avoids it for the others", () => {
    const chosen = { kind: "lucide", name: "sparkles", color: "amber" };
    const plan = distinctAssistantIconPlan([
      holder("a", "m1", "2026-01-01"),
      holder("b", "m2", "2026-02-01"),
      holder("c", "m3", "2026-03-01", chosen),
      holder("d", "m4", "2026-04-01", chosen),
    ]);
    expect(plan.map((change) => change.id)).toEqual(["b"]);
    expect(plan[0]!.icon.name).not.toBe("sparkles");
    expect(plan[0]!.icon.name).not.toBe("concierge-bell");
  });

  it("has nothing left to do once applied", () => {
    const assistants = [holder("a", "m1", "2026-01-01"), holder("b", "m2", "2026-02-01")];
    const plan = distinctAssistantIconPlan(assistants);
    const after = assistants.map((assistant) => ({
      ...assistant,
      icon: (plan.find((change) => change.id === assistant.id)?.icon ?? assistant.icon) as never,
    }));
    expect(distinctAssistantIconPlan(after)).toEqual([]);
  });
});
