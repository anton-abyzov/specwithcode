// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({
  ratio: null as number | null | undefined,
  partial: false,
  folder: null as unknown,
}));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { usage: () => ({}) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    refresh: () => {},
    data: {
      cacheReadRatio: state.ratio,
      coverage: {
        threads: 2,
        missingThreads: 0,
        partialTurns: state.partial ? 1 : 0,
        missingTurns: 0,
        costUnknownTurns: 2,
      },
      totals: {
        totalTokens: 130,
        inputTokens: 100,
        outputTokens: 30,
        cachedInputTokens: 80,
        cacheCreationTokens: 10,
        equivalentCostUsd: null,
      },
      models: [],
      threads: [],
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
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.ratio = null;
  state.partial = false;
  state.folder = null;
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
describe("Project usage presentation", () => {
  it.each([null, undefined])("keeps unreported cache ratios unknown (%s)", async (ratio) => {
    state.ratio = ratio;
    state.partial = true;
    await render();
    expect(summary("Cache read ratio")).toBe("Not reported");
    expect(container.textContent).toContain("Incomplete usage");
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
    expect([...container.querySelectorAll("tfoot td")].map((e) => e.textContent)).toEqual([
      "100",
      "30",
      "80",
      "10",
    ]);
    expect(container.textContent).toContain("Cache reads and writes are included in input tokens");
    expect(container.textContent).toContain("not reported. 2 turns have no cost estimate");
  });
  it("shows limits per machine with the project's device first", async () => {
    await render();
    expect(
      container.querySelector("[data-testid=host-limits]")?.getAttribute("data-project-host"),
    ).toBe("host");
  });
  it("counts CLI sessions run in the project folder beside Studio threads", async () => {
    const t = (input: number, cached: number, output: number) => ({
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      cachedInputTokens: cached,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      equivalentCostUsd: 1.5,
    });
    state.folder = {
      hostLabel: "m4",
      windowDays: 90,
      roots: ["/work/app"],
      sessions: 4,
      studioOwnedSessions: 1,
      totals: t(1000, 900, 100),
      providers: [
        { provider: "claude", sessions: 3, totals: t(900, 850, 90), lastActiveAt: null },
        { provider: "codex", sessions: 1, totals: t(100, 50, 10), lastActiveAt: null },
      ],
      models: [{ provider: "claude", model: "claude-opus-5", totals: t(900, 850, 90) }],
    };
    await render();
    expect(summary("CLI sessions")).toBe("4");
    expect(summary("Tokens")).toBe("1.2K");
    expect(container.textContent).toContain("logs on m4 from the last 90 days");
    const rows = [...container.querySelectorAll("table")]
      .find((table) => table.querySelector("caption")?.textContent === "Tokens by provider")
      ?.querySelectorAll("tbody tr");
    expect([...(rows ?? [])].map((row) => row.querySelector("th")?.textContent)).toEqual([
      "Claude3 CLI sessions",
      "Codex1 CLI session",
    ]);
    expect(container.textContent).toContain("claude-opus-5");
  });
});
