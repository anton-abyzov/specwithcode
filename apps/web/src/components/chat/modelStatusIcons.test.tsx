import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AvailabilityText, ModelAvailability } from "../../studio/modelAvailability";
import { TooltipProvider } from "../ui/tooltip";
import { modelStatusIcons, ModelStatusIcons } from "./modelStatusIcons";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const text = (long: string, label = "label"): AvailabilityText => ({
  short: "short",
  label,
  long,
  tone: "muted",
});
const binding = (resetsAt: number | null) => ({
  label: "Weekly",
  name: "weekly",
  scope: "account" as const,
  family: null,
  resetsAt,
});
const room = (leftPercent: number): ModelAvailability => ({
  kind: "room",
  leftPercent,
  tone: leftPercent <= 20 ? "warn" : "ok",
  binding: binding(NOW + 3_600_000),
  checkedAt: NOW,
});
const icons = (input: Omit<Parameters<typeof modelStatusIcons>[0], "nowMs">) =>
  modelStatusIcons({ ...input, nowMs: NOW });

describe("modelStatusIcons", () => {
  it("draws a usage ring, with the percent only once 80% is used", () => {
    const [plenty] = icons({ availability: { state: room(94), text: text("94% left.") } });
    expect(plenty).toMatchObject({ kind: "usage", percentText: null, tooltip: "94% left." });
    const [low] = icons({ availability: { state: room(20), text: text("20% left.") } });
    expect(low).toMatchObject({ kind: "usage", percentText: "20% left", tone: "warn" });
    const [above] = icons({ availability: { state: room(21), text: text("") } });
    expect(above).toMatchObject({ percentText: null });
  });

  it("marks a reached limit with its short reset", () => {
    const state: ModelAvailability = {
      kind: "exhausted",
      binding: binding(NOW + 20 * 86_400_000 + 60_000),
      checkedAt: NOW,
      providerAllows: false,
    };
    expect(
      icons({ availability: { state, text: text("Chat limit reached. Resets in 20d 0h.") } }),
    ).toEqual([
      {
        kind: "limit",
        reset: "20d",
        label: "label",
        tooltip: "Chat limit reached. Resets in 20d 0h.",
      },
    ]);
  });

  it("keeps extra usage amber, never the limit mark", () => {
    const state: ModelAvailability = {
      kind: "exhausted",
      binding: binding(null),
      checkedAt: NOW,
      providerAllows: true,
    };
    expect(icons({ availability: { state, text: text("") } })[0]).toMatchObject({
      kind: "usage",
      leftPercent: 0,
      tone: "warn",
    });
  });

  it("draws a dashed ring for usage a provider does not report", () => {
    expect(icons({ availability: { state: { kind: "unreported" }, text: text("long") } })).toEqual([
      {
        kind: "unknown",
        label: "Usage not reported by this provider",
        tooltip: "Usage not reported by this provider",
      },
    ]);
    // A reason from the machine (which sign-in is missing) is kept whole.
    expect(
      icons({
        availability: {
          state: { kind: "unreported", message: "Run gh auth login." },
          text: text("Run gh auth login. The model stays selectable."),
        },
      })[0],
    ).toMatchObject({ tooltip: "Run gh auth login. The model stays selectable." });
    expect(
      icons({
        availability: { state: { kind: "unknown", reason: "notRead" }, text: text("Not read.") },
      })[0],
    ).toMatchObject({ kind: "unknown", tooltip: "Not read." });
  });

  it("shows coins for per-token billing and a drive for a local model, without a ring", () => {
    expect(
      icons({ billing: "api", availability: { state: room(50), text: text("") } }).map(
        (icon) => icon.kind,
      ),
    ).toEqual(["perToken"]);
    expect(
      icons({ availability: { state: { kind: "perToken" }, text: text("Per token.") } }),
    ).toEqual([{ kind: "perToken", label: "Billed per token", tooltip: "Per token." }]);
    expect(icons({ billing: "local" }).map((icon) => icon.kind)).toEqual(["local"]);
  });

  it("shows nothing for a subscription or unreported billing, and a dot for a new model", () => {
    expect(icons({ billing: "subscription" })).toEqual([]);
    expect(icons({ billing: "unknown" })).toEqual([]);
    expect(icons({})).toEqual([]);
    expect(icons({ isNew: true }).map((icon) => icon.kind)).toEqual(["new"]);
  });
});

describe("ModelStatusIcons", () => {
  it("gives every icon an accessible name and never prints the old row text", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ModelStatusIcons
          icons={icons({
            isNew: true,
            billing: "unknown",
            availability: { state: { kind: "unreported" }, text: text("") },
          })}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="New model"');
    expect(html).toContain('aria-label="Usage not reported by this provider"');
    expect(html).not.toContain("Billing unverified");
    expect(html).not.toContain("Usage not read");
  });
});
