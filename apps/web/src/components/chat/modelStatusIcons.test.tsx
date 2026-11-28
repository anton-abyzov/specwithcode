import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AvailabilityText, ModelAvailability } from "../../studio/modelAvailability";
import { TooltipProvider } from "../ui/tooltip";
import { modelStatusIcons, ModelStatusIcons, modelStatusIconsFor } from "./modelStatusIcons";

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

describe("modelStatusIconsFor an open-model route", () => {
  const forRoute = (
    openModelPreset: string | undefined,
    input: Omit<Parameters<typeof modelStatusIcons>[0], "nowMs">,
  ) => modelStatusIconsFor(openModelPreset ? { openModelPreset } : {}, { ...input, nowMs: NOW });

  it("adds the list-price note to the per-token tooltip and keeps the accessible name", () => {
    expect(forRoute("deepseek", { billing: "api" })).toEqual([
      {
        kind: "perToken",
        label: "Billed per token",
        tooltip: "Billed per token. DeepSeek bills your key at its own list price.",
      },
    ]);
    // The availability's words speak of plans; a route says only how it bills.
    expect(
      forRoute("openrouter", {
        availability: {
          state: { kind: "perToken" },
          text: text("Billed per token, not to a subscription."),
        },
      })[0],
    ).toMatchObject({
      tooltip: "Billed per token. OpenRouter bills your key at its own list price.",
    });
  });

  it("says where a local route runs, once", () => {
    expect(forRoute("ollama", { billing: "local" })).toEqual([
      {
        kind: "local",
        label: "Local model",
        tooltip: "Local model. Runs on your own Ollama.",
      },
    ]);
  });

  it("never draws a plan ring, even when the row reads subscription billing and usage", () => {
    const kinds = (preset: string) =>
      forRoute(preset, {
        billing: "subscription",
        availability: { state: room(40), text: text("40% left.") },
      }).map((icon) => icon.kind);
    expect(kinds("kimi")).toEqual(["perToken"]);
    expect(kinds("lmstudio")).toEqual(["local"]);
  });

  it("leaves a route without the marker exactly as before (D-05)", () => {
    // A Claude instance built by hand with a base URL, Pi or OpenCode serving DeepSeek
    // or Ollama, and an unknown preset id all carry no usable marker.
    const cases: ReadonlyArray<Omit<Parameters<typeof modelStatusIcons>[0], "nowMs">> = [
      { billing: "api" },
      { billing: "local" },
      { billing: "subscription", availability: { state: room(40), text: text("40% left.") } },
      { availability: { state: { kind: "perToken" }, text: text("Per token.") } },
    ];
    for (const input of cases) {
      const plain = icons(input);
      expect(forRoute(undefined, input)).toEqual(plain);
      expect(forRoute("mistral", input)).toEqual(plain);
      expect(modelStatusIconsFor(null, { ...input, nowMs: NOW })).toEqual(plain);
    }
    expect(icons({ billing: "local" })[0]).toMatchObject({
      tooltip: "Local model: runs on this machine",
    });
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
