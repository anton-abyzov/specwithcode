// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const t = (input: number, cached: number | null, output: number, cost: number | null = null) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: cached,
  cacheCreationTokens: cached === null ? null : 10,
  reasoningTokens: 0,
  equivalentCostUsd: cost,
});
const state = vi.hoisted(() => ({
  ratio: null as number | null | undefined,
  partial: false,
  costUnknown: 2,
  folder: null as unknown,
  threads: [] as unknown[],
  daily: [] as unknown[] | undefined,
}));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { usage: () => ({}) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    refresh: () => {},
    data: {
      readAt: new Date().toISOString(),
      cacheReadRatio: state.ratio,
      coverage: {
        threads: 2,
        threadsWithUsage: 2,
        missingThreads: 0,
        partialTurns: state.partial ? 1 : 0,
        missingTurns: 0,
        costUnknownTurns: state.costUnknown,
        completeTurns: 2,
      },
      totals: t(100, 80, 30),
      models: [],
      threads: state.threads,
      daily: state.daily,
      folderSessions: state.folder,
    },
  }),
}));
vi.mock("./shell/ProjectUsageIndicator", () => ({
  SubscriptionUsageSummary: () => <div data-testid="subscription-usage" />,
}));
vi.mock("./shell/HostLimits", () => ({
  HostLimits: (props: { projectEnvironmentId: string }) => (
    <div data-testid="host-limits" data-project-host={props.projectEnvironmentId} />
  ),
}));
import { ProjectUsage } from "./ProjectUsage";
import { localToday } from "../../studio/projectUsageInsights";

const thread = (
  id: string,
  role: "coordinator" | "worker",
  models: {
    provider: string;
    instance: string;
    model: string | null;
    totals: ReturnType<typeof t>;
  }[],
) => {
  const totalTokens = models.reduce((sum, m) => sum + m.totals.totalTokens, 0);
  return {
    threadId: id,
    title: id,
    role,
    archived: false,
    totals: { ...t(0, 0, 0), totalTokens },
    share: null,
    models: models.map((m) => ({
      provider: m.provider,
      providerInstanceId: m.instance,
      model: m.model,
      totals: m.totals,
    })),
  };
};

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.ratio = null;
  state.partial = false;
  state.costUnknown = 2;
  state.folder = null;
  state.daily = [];
  state.threads = [
    thread("Coordinator", "coordinator", [
      {
        provider: "claudeAgent",
        instance: "claudeAgent",
        model: "claude-opus-5.5",
        totals: t(60, 50, 20),
      },
    ]),
    thread("Build", "worker", [
      {
        provider: "claudeAgent",
        instance: "claudeAgent",
        model: "claude-opus-5-5",
        totals: t(40, 30, 10),
      },
    ]),
    thread("Idle", "worker", []),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <ProjectUsage
        environmentId={EnvironmentId.make("host")}
        projectId={ProjectId.make("project")}
        onOpenThread={() => {}}
      />,
    ),
  );
}
const summary = (name: string) =>
  [...container.querySelectorAll("dt")].find((e) => e.textContent === name)?.nextElementSibling
    ?.textContent;
const table = (caption: string) =>
  [...container.querySelectorAll("table")].find(
    (element) => element.querySelector("caption")?.textContent === caption,
  );
const rowHeads = (element: Element | undefined) =>
  [...(element?.querySelectorAll("tbody tr > th") ?? [])].map((e) => e.textContent);

describe("Project usage presentation", () => {
  it.each([null, undefined])("keeps unreported cache ratios unknown (%s)", async (ratio) => {
    state.ratio = ratio;
    state.partial = true;
    await render();
    expect(summary("Cache read ratio")).toBe("—");
    expect(container.textContent).toContain("Not reported by every turn");
    expect(container.textContent).toContain("Some usage was not reported");
    expect(container.textContent).toContain("1 turn reported only part of their usage");
  });

  it.each([
    [0, "0.0%"],
    [0.8, "80.0%"],
    [0.375, "37.5%"],
  ])("renders the server's input-weighted ratio %s without recomputing", async (ratio, text) => {
    state.ratio = ratio as number;
    await render();
    expect(summary("Cache read ratio")).toBe(text);
    expect(summary("Tokens")).toBe("130");
    expect(
      [...(table("Tokens by model")?.querySelectorAll("tfoot td") ?? [])].map((e) => e.textContent),
    ).toEqual(["130", "", "100", "30", "80"]);
    expect(container.textContent).toContain("Input includes cache reads and writes");
    expect(container.textContent).toContain("2 turns have no cost estimate");
    expect(container.querySelector(".project-usage-gaps.project-notice")).toBeNull();
  });

  it("merges model spellings into one named row and hides threads without usage", async () => {
    await render();
    expect(rowHeads(table("Tokens by model"))).toEqual(["Claude Opus 5.5Claude"]);
    const threads = () => [...container.querySelectorAll("table")].at(-1);
    expect(rowHeads(threads())).toEqual(["CoordinatorCoordinator", "BuildThread"]);
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Show 1 thread without usage",
    );
    await act(async () => toggle?.click());
    expect(rowHeads(threads())).toContain("IdleThread");
  });

  it("drops the cache column when no model reports cache reads", async () => {
    state.threads = [
      thread("Build", "worker", [
        {
          provider: "acpRegistry",
          instance: "acpRegistry",
          model: "auto",
          totals: t(40, null, 10),
        },
      ]),
    ];
    await render();
    const models = table("Tokens by model");
    expect([...(models?.querySelectorAll("thead th") ?? [])].map((e) => e.textContent)).toEqual([
      "Model",
      "Tokens",
      "Share",
      "Input",
      "Output",
    ]);
    expect(rowHeads(models)).toEqual(["Chosen by the agentACP agent"]);
    expect(container.textContent).not.toContain("acpRegistry");
  });

  it("keeps an older host's missing split and daily data unknown, not zero", async () => {
    state.daily = undefined;
    state.threads = (state.threads as { models?: unknown }[]).map(
      ({ models: _m, ...rest }) => rest,
    );
    await render();
    expect(summary("Last 7 days")).toBe("—");
    expect(container.textContent).toContain("This host does not report daily usage");
    expect(container.querySelector(".project-usage-trend")).toBeNull();
  });

  it("ends the trend on the host's day when it runs ahead of this browser", async () => {
    const ahead = new Date(Date.now() + 86_400_000);
    const day = `${ahead.getFullYear()}-${String(ahead.getMonth() + 1).padStart(2, "0")}-${String(ahead.getDate()).padStart(2, "0")}`;
    state.daily = [
      {
        day,
        role: "worker",
        provider: "claudeAgent",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        totalTokens: 70,
      },
    ];
    await render();
    expect(summary("Last 7 days")).toBe("70");
  });

  it("shows limits per machine with the project's device first", async () => {
    await render();
    expect(
      container.querySelector("[data-testid=host-limits]")?.getAttribute("data-project-host"),
    ).toBe("host");
  });

  it("draws the daily trend and compares the last week with the one before", async () => {
    state.daily = [
      {
        day: localToday(Date.now()),
        role: "worker",
        provider: "claudeAgent",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        totalTokens: 90,
      },
    ];
    await render();
    expect(container.querySelector("#project-usage-trend-title")?.textContent).toBe(
      "Daily tokens, last 30 days",
    );
    expect(container.querySelectorAll(".project-usage-trend-column")).toHaveLength(30);
    expect(summary("Last 7 days")).toBe("90");
    expect(container.textContent).toContain("Nothing the week before");
  });

  it("counts CLI sessions run in the project folder beside Studio threads", async () => {
    state.folder = {
      hostLabel: "m4",
      windowDays: 90,
      roots: ["/work/app"],
      sessions: 4,
      studioOwnedSessions: 1,
      totals: t(1000, 900, 100, 1.5),
      providers: [],
      models: [
        { provider: "claude", model: "claude-opus-5", totals: t(900, 850, 90) },
        { provider: "codex", model: "gpt-5.5", totals: t(100, 50, 10) },
      ],
    };
    await render();
    expect(summary("Tokens")).toBe("1.23K");
    expect(container.textContent).toContain("2 threads · 4 CLI sessions");
    expect(rowHeads(table("Tokens by harness"))).toEqual([
      "ClaudeCLI sessions · Coordinator · Threads",
      "CodexCLI sessions",
    ]);
    expect(rowHeads(table("Tokens by model"))).toEqual([
      "Claude Opus",
      "Claude Opus 5Claude",
      "Claude Opus 5.5Claude",
      "GPT-5.5Codex",
    ]);
  });
});
