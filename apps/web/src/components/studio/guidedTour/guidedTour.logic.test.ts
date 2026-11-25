import { MODEL_TRACK_LABELS } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { translatePhrase } from "../../../i18n/phrases";
import { SETTINGS_NAV_GROUPS, SETTINGS_SECTION_LABELS } from "../../settings/settingsSearch";
import {
  backStepIndex,
  GUIDED_TOUR_PHRASES,
  GUIDED_TOUR_STEPS,
  nextStepIndex,
  placeCard,
} from "./guidedTour.logic";

const LOCALES = ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"] as const;

describe("guided tour steps (1486 AC-01)", () => {
  it("has at least ten steps, fourteen in the agreed order", () => {
    expect(GUIDED_TOUR_STEPS.map((step) => step.id)).toEqual([
      "welcome",
      "projects",
      "project-settings",
      "app-settings",
      "skills",
      "skill-search",
      "skill-switches",
      "track-daily",
      "track-complex",
      "track-review",
      "chat-model",
      "machines",
      "hand-off",
      "again",
    ]);
  });

  it("covers skills, machines, tracks and both kinds of settings", () => {
    const routes = new Set(GUIDED_TOUR_STEPS.map((step) => step.route));
    expect(routes).toEqual(
      new Set([
        "/",
        "/settings/general",
        "/settings/skills",
        "/settings/models",
        "/settings/machines",
      ]),
    );
  });

  it("points every step but the welcome at a target", () => {
    for (const step of GUIDED_TOUR_STEPS.slice(1))
      expect(step.targets.length, step.id).toBeGreaterThan(0);
    expect(GUIDED_TOUR_STEPS[0]!.targets).toEqual([]);
  });
});

describe("guided tour copy (1486 AC-06, AC-07)", () => {
  it("names sections, groups and tracks by the app's own labels", () => {
    const labels = new Set([
      ...Object.values(SETTINGS_SECTION_LABELS),
      ...SETTINGS_NAV_GROUPS.map((group) => group.label),
      ...Object.values(MODEL_TRACK_LABELS),
    ]);
    for (const step of GUIDED_TOUR_STEPS)
      for (const label of Object.values(step.labels ?? {}))
        expect(labels.has(label), label).toBe(true);
    const byId = new Map(GUIDED_TOUR_STEPS.map((step) => [step.id, step]));
    expect(byId.get("track-daily")!.title).toBe(MODEL_TRACK_LABELS.daily);
    expect(byId.get("track-complex")!.title).toBe(MODEL_TRACK_LABELS.complex);
    expect(byId.get("track-review")!.title).toBe(MODEL_TRACK_LABELS.review);
    expect(byId.get("skills")!.title).toBe(SETTINGS_SECTION_LABELS["/settings/skills"]);
    expect(byId.get("machines")!.title).toBe(SETTINGS_SECTION_LABELS["/settings/machines"]);
  });

  it("keeps each body to one sentence, says machine and uses no em dash", () => {
    for (const step of GUIDED_TOUR_STEPS) {
      expect(step.body.match(/[.!?](\s|$)/g)?.length, step.id).toBe(1);
      expect(step.body).not.toMatch(/environment/i);
      expect(`${step.title} ${step.body}`).not.toContain("—");
    }
  });

  it("fills every {slot} a body names", () => {
    for (const step of GUIDED_TOUR_STEPS) {
      const slots = [...step.body.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(slots.sort(), step.id).toEqual(Object.keys(step.labels ?? {}).sort());
    }
  });

  it("explains other machines without needing one", () => {
    const machines = GUIDED_TOUR_STEPS.find((step) => step.id === "machines")!;
    expect(machines.body).toContain("with one machine, nothing here needs setting");
  });

  // Labels the app already shows keep the app's own translation status.
  const ownLabels = new Set([
    ...Object.values(SETTINGS_SECTION_LABELS),
    ...SETTINGS_NAV_GROUPS.map((group) => group.label),
    ...Object.values(MODEL_TRACK_LABELS),
  ]);
  it.each(LOCALES)("translates every tour phrase into %s, keeping its slots", (locale) => {
    for (const english of GUIDED_TOUR_PHRASES.filter((phrase) => !ownLabels.has(phrase))) {
      const text = translatePhrase(locale, english);
      expect(text, `${locale}: ${english}`).not.toBe(english);
      for (const slot of english.match(/\{\w+\}/g) ?? []) expect(text, english).toContain(slot);
    }
  });
});

describe("guided tour moves (1486 AC-02)", () => {
  it("stops at both ends", () => {
    expect(backStepIndex(0)).toBe(0);
    expect(backStepIndex(3)).toBe(2);
    expect(nextStepIndex(0, 14)).toBe(1);
    expect(nextStepIndex(13, 14)).toBeNull();
  });
});

describe("card placement (1486 AC-02, AC-03)", () => {
  const card = { width: 360, height: 180 };
  const viewport = { width: 1440, height: 900 };

  it("centres the card with no target", () => {
    expect(placeCard(null, card, viewport)).toEqual({ top: 360, left: 540, side: "center" });
  });

  it("goes beside a narrow sidebar target", () => {
    const placed = placeCard({ top: 200, left: 8, width: 240, height: 120 }, card, viewport);
    expect(placed).toEqual({ top: 200, left: 260, side: "right" });
  });

  it("goes below a wide target, else above, and stays on screen", () => {
    expect(placeCard({ top: 100, left: 300, width: 900, height: 40 }, card, viewport).side).toBe(
      "below",
    );
    const above = placeCard({ top: 800, left: 1300, width: 900, height: 60 }, card, viewport);
    expect(above.side).toBe("above");
    expect(above.left + card.width).toBeLessThanOrEqual(viewport.width - 12);
  });

  it("fits a phone width", () => {
    const placed = placeCard(
      { top: 100, left: 10, width: 370, height: 40 },
      { width: 366, height: 200 },
      { width: 390, height: 844 },
    );
    expect(placed.left).toBeGreaterThanOrEqual(12);
    expect(placed.side).toBe("below");
  });
});
