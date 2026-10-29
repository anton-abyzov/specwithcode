// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitHistorySeries,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const history = vi.hoisted(() => ({
  series: [] as UsageLimitHistorySeries[],
  calls: 0,
  fail: null as "reject" | "unknown-tag" | null,
  // Whether each environment's session grant has loaded yet.
  granted: true,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "locale" }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => history.granted,
  useEnvironmentsWithScope: (environments: ReadonlyArray<{ readonly environmentId: string }>) =>
    new Set(history.granted ? environments.map(({ environmentId }) => environmentId) : []),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { consumeResetCredit: "consume", usageLimitHistory: "history" },
}));
// Stable per command, as the real hook memoizes it.
const commands = vi.hoisted(() => ({
  history: async () => {
    history.calls += 1;
    if (history.fail === "reject") throw new Error("socket closed");
    // What an older server answers for a method it does not have.
    if (history.fail === "unknown-tag") return { _tag: "Failure", cause: "Unknown request tag" };
    return { _tag: "Success", value: { createdAt: "", series: history.series } };
  },
  other: () => Promise.resolve(undefined),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "history" ? commands.history : commands.other),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }) }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const HOUR = 3_600_000;
const now = Date.parse("2026-10-26T12:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();
const resetsAt = iso(now + 4 * HOUR);
const claude = ProviderDriverKind.make("claudeAgent");

function claudeOn(email: string, usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: claude,
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: iso(now),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(now),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          windowDurationMins: 300,
          resetsAt,
        },
      ],
    },
  };
}

const recorded = (email: string, usedPercent: number): UsageLimitHistorySeries => ({
  accountKey: `claudeAgent:${email}`,
  driver: claude,
  windowId: "five_hour",
  windowKind: "session",
  windowDurationMins: 300,
  samples: [{ at: iso(now - 3 * HOUR), usedPercent, resetsAt }],
});

const presentations = new Map([
  [
    EnvironmentId.make("m1"),
    {
      entry: { target: { label: "Mac one" } },
      serverConfig: { providers: [claudeOn("work@example.com", 40)] },
    },
  ],
  [
    EnvironmentId.make("m4"),
    {
      entry: { target: { label: "Mac two" } },
      serverConfig: { providers: [claudeOn("home@example.com", 98)] },
    },
  ],
]) as unknown as Parameters<typeof UsageLimitsPooled>[0]["presentations"];

describe("pooled limits show burn, run-out and a quota chart", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    history.calls = 0;
    history.fail = null;
    history.granted = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(() => root.render(<UsageLimitsPooled presentations={presentations} now={now} />));
    // Let the history reads resolve and re-render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const panel = () => container.querySelector<HTMLElement>("[data-pool-forecast]");

  it("adds the accounts up, measures the burn and names the first account to run dry", async () => {
    history.series = [recorded("work@example.com", 34), recorded("home@example.com", 95)];
    await render();
    expect(history.calls).toBe(2);
    const text = panel()?.textContent ?? "";
    expect(text).toContain("Pool left");
    expect(text).toMatch(/0\.6\s*of 2 accounts/);
    expect(text).toContain("3%/h");
    // home has 2% left at 1%/h, two hours before both accounts reset.
    expect(text).toMatch(/First empty\s*home@example\.com in 2h/);
    expect(text).toMatch(/Pool empty\s*Not in the next 12 hours/);
    // Both reset together and hand back everything they used.
    expect(text).toMatch(/Next reset\s*\+138%/);
    const chart = container.querySelector("[data-pool-forecast-chart]");
    expect(chart?.querySelector('[data-series="recorded"]')).not.toBeNull();
    expect(chart?.querySelector('[data-series="projected"]')).not.toBeNull();
    expect(chart?.querySelector("svg")?.getAttribute("aria-label")).toContain(
      "now 0.6 of 2 accounts",
    );
  });

  it("reads the history once the session grant lands after the connection", async () => {
    history.series = [recorded("work@example.com", 34), recorded("home@example.com", 95)];
    history.granted = false;
    await render();
    expect(history.calls).toBe(0);
    expect(panel()?.textContent ?? "").toContain("Collecting history");
    history.granted = true;
    await render();
    expect(history.calls).toBe(2);
    expect(panel()?.textContent ?? "").toContain("3%/h");
  });

  it.each(["reject", "unknown-tag"] as const)(
    "keeps the bars and says it is collecting when the history read fails (%s)",
    async (fail) => {
      history.fail = fail;
      history.series = [recorded("work@example.com", 34)];
      await render();
      const text = panel()?.textContent ?? "";
      expect(text).toContain("Measuring");
      expect(text).toContain("Collecting history");
      expect(container.textContent).toContain("work@example.com");
    },
  );

  it("says it is still collecting when no history has been recorded", async () => {
    history.series = [];
    await render();
    const text = panel()?.textContent ?? "";
    expect(text).toContain("Measuring");
    expect(text).toContain("Collecting history");
    expect(container.querySelector("[data-pool-forecast-chart]")).toBeNull();
  });
});
