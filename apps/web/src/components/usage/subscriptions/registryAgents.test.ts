import { ProviderDriverKind, type UsageMachineReport } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerGroupOf } from "./providerGroups";
import { OTHER_MODELS, agentStats, daysBetween } from "./registryAgents";

const acp = ProviderDriverKind.make("acpRegistry");
const range = { sinceDay: "2026-11-20", untilDay: "2026-11-23" };

type Cell = UsageMachineReport["cells"][number];
const cell = (
  accountKey: string,
  model: string,
  day: string,
  requests: number,
  tokens = 0,
  source?: number,
): Cell =>
  ({
    day,
    accountKey,
    model,
    origin: "app",
    tokens,
    costUsd: 0,
    requests,
    unpricedRequests: 0,
    sessions: 1,
    ...(source === undefined ? {} : { source }),
  }) as Cell;

const report = (
  cells: Cell[],
  accounts: Array<{ accountKey: string; label?: string }> = [],
  sources: Array<{ key: string; provider: string }> = [],
): UsageMachineReport =>
  ({
    version: 1,
    readAt: "2026-11-23T12:00:00.000Z",
    timeZone: "UTC",
    sinceDay: range.sinceDay,
    untilDay: range.untilDay,
    accounts: accounts.map((account) => ({
      ...account,
      driver: account.accountKey.split(":")[0],
      identity: "recorded",
      signedIn: true,
    })),
    sources,
    projects: [],
    cells,
    hourly: [],
    hourlySinceMs: 0,
  }) as unknown as UsageMachineReport;

// Fictional: two Copilot accounts on two machines and one Gemini CLI instance.
const agentOf = (accountKey: string, driver: string, label: string | undefined) =>
  providerGroupOf({
    driver: driver as typeof acp,
    displayName: label ?? (accountKey.includes("copilot") ? "GitHub Copilot" : undefined),
  });

describe("agentStats", () => {
  it("adds each machine's recorded turns per agent and model, and leaves built-in drivers out", () => {
    const view = agentStats(
      [
        report(
          [
            cell("acpRegistry:copilot-a@example.com", "claude-opus-5.5", "2026-11-20", 6, 60_000),
            cell("acpRegistry:copilot-a@example.com", "gemini-4-neon", "2026-11-21", 2, 9_000),
            cell("claudeAgent:me@example.com", "claude-opus-5-5", "2026-11-21", 40, 1_000_000),
          ],
          [{ accountKey: "acpRegistry:copilot-a@example.com", label: "GitHub Copilot" }],
        ),
        report(
          [
            cell("acpRegistry:copilot-b@example.com", "claude-opus-5.5", "2026-11-22", 3, 30_000),
            cell("acpRegistry:instance:acpRegistry_gemini", "gemini-4-neon", "2026-11-23", 4),
          ],
          [
            { accountKey: "acpRegistry:copilot-b@example.com", label: "GitHub Copilot Enterprise" },
            { accountKey: "acpRegistry:instance:acpRegistry_gemini", label: "Gemini CLI" },
          ],
        ),
      ],
      agentOf,
      range,
    );
    expect(view.turns).toBe(15);
    expect(view.tokens).toBe(99_000);
    expect(view.agents.map((agent) => [agent.group.label, agent.turns])).toEqual([
      ["GitHub Copilot", 11],
      ["Gemini CLI", 4],
    ]);
    expect(view.agents[0]?.models).toEqual([
      { model: "Opus 5.5", turns: 9, tokens: 90_000 },
      { model: "Gemini 4 Neon", turns: 2, tokens: 9_000 },
    ]);
    // Gemini CLI reported no tokens; the turns still count.
    expect(view.agents[1]).toMatchObject({ tokens: 0, turnsWithoutTokens: 4 });
    expect(view.models).toEqual(["Opus 5.5", "Gemini 4 Neon"]);
    expect(view.days.map((day) => day.total)).toEqual([6, 2, 3, 4]);
    expect(view.days[0]?.turns.get("Opus 5.5")).toBe(6);
  });

  it("counts a transcript folder two machines share once", () => {
    const shared = [{ key: "host|antigravity|/home|1:2", provider: "antigravity" }];
    const both = [cell("antigravity:me@example.com", "gemini-3.8-flash", "2026-11-22", 5, 500, 0)];
    const view = agentStats([report(both, [], shared), report(both, [], shared)], agentOf, range);
    expect(view.turns).toBe(5);
    expect(view.agents[0]?.group.key).toBe("antigravity");
  });

  it("folds models past the sixth into Other models and keeps out-of-range days out", () => {
    const models = ["a-1", "b-1", "c-1", "d-1", "e-1", "f-1", "g-1"];
    const view = agentStats(
      [
        report([
          ...models.map((model, index) =>
            cell("acpRegistry:copilot-a@example.com", model, "2026-11-21", 10 - index),
          ),
          cell("acpRegistry:copilot-a@example.com", "a-1", "2026-11-01", 100),
        ]),
      ],
      agentOf,
      range,
    );
    expect(view.models).toHaveLength(6);
    expect(view.models.at(-1)).toBe(OTHER_MODELS);
    expect(view.days[1]?.turns.get(OTHER_MODELS)).toBe(5 + 4);
    expect(view.turns).toBe(10 + 9 + 8 + 7 + 6 + 5 + 4);
  });

  it("is empty with no registry turns", () => {
    const view = agentStats([report([])], agentOf, range);
    expect(view).toMatchObject({ turns: 0, agents: [], models: [] });
    expect(view.days).toHaveLength(4);
  });
});

describe("daysBetween", () => {
  it("lists every calendar day, across a month end", () => {
    expect(daysBetween("2026-11-29", "2026-12-02")).toEqual([
      "2026-11-29",
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ]);
  });
});
