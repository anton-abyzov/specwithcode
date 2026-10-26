import {
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { AvailabilityText, ModelAvailability } from "../../studio/modelAvailability";
import { ModelPickerUsageBand, type ModelPickerUsage } from "./ModelUsage";

const now = Date.parse("2026-10-21T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

const windows: ServerProviderUsageWindow[] = [
  {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: 38,
    resetsAt: iso(now + 2 * HOUR),
    windowDurationMins: 300,
  },
  {
    id: "seven_day_fable",
    kind: "weekly",
    label: "Weekly · Fable",
    usedPercent: 64,
    resetsAt: iso(now + 30 * HOUR),
    windowDurationMins: 10080,
    modelScope: "Fable",
  },
];

const entry = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  displayName: "Claude",
  snapshot: {
    usageLimits: { checkedAt: iso(now - 60_000), windows },
  } as unknown as ServerProvider,
} as unknown as ProviderInstanceEntry;

const usageIn = (state: ModelAvailability, long: string): ModelPickerUsage => ({
  connected: true,
  environmentId: "env-m4",
  machineLabel: "M4",
  running: null,
  nowMs: now,
  availability: () => state,
  text: (): AvailabilityText => ({ short: "", label: "", long, tone: "muted" }),
  warningReason: () => null,
  formatAt: (ms) => new Date(ms).toISOString(),
});

describe("ModelPickerUsageBand", () => {
  it("names each window with the shared window name, never Session", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerUsageBand
        entry={entry}
        usage={usageIn(
          { kind: "room", leftPercent: 62 } as unknown as ModelAvailability,
          "62% left",
        )}
      />,
    );
    expect(markup).toContain(">5-hour<");
    expect(markup).toContain(">Fable weekly<");
    expect(markup).not.toContain("Session");
    expect(markup).not.toContain("Weekly · Fable");
  });

  it("shows no bars from the previous account while the account switches", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerUsageBand
        entry={entry}
        usage={usageIn({ kind: "switching" }, "New account, not read yet")}
      />,
    );
    expect(markup).toContain('data-model-picker-usage-band="switching"');
    expect(markup).toContain("New account, not read yet");
    expect(markup).not.toContain("data-model-usage-window");
    expect(markup).not.toContain("% left");
  });
});
