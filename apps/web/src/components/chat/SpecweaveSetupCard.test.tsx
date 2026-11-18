// @vitest-environment jsdom
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import type { SpecweaveSetupRequest } from "@specweave-studio/contracts";
import { Cause } from "effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  refresh: vi.fn(),
  canWrite: true,
  canOperate: true,
  setUp: vi.fn(),
  answer: vi.fn(),
  navigate: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? undefined : state.snapshot,
    refresh: state.refresh,
  }),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    read: (request: unknown) => ({ read: request }),
    specweaveSetUp: "set-up",
    specweaveAnswer: "answer",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "set-up" ? state.setUp : state.answer),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === "filesystem:write" ? state.canWrite : state.canOperate,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [
    {
      projectKey: "atlas",
      memberProjects: [{ environmentId: "env-m4", id: "project-atlas" }],
    },
  ],
}));
vi.mock("../machineTools/machineToolInstallRequest", () => ({
  requestMachineToolInstall: state.install,
}));

const { SpecweaveSetupCard, SpecweaveSetupCardView } = await import("./SpecweaveSetupCard");

const environmentId = EnvironmentId.make("env-m4");
const projectId = ProjectId.make("project-atlas");
const threadId = "thread-coordinator";

const card = (fields: Partial<SpecweaveSetupRequest> = {}): SpecweaveSetupRequest => ({
  requestId: "req-1",
  threadId: ThreadId.make(threadId),
  state: "asking",
  gitRepository: true,
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
  ...fields,
});

describe("SpecweaveSetupCard", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.snapshot = { specweaveState: "off", specweaveSetupRequest: card() };
    state.refresh.mockReset();
    state.canWrite = true;
    state.canOperate = true;
    state.setUp.mockReset();
    state.setUp.mockResolvedValue({ _tag: "Success", value: { alreadySetUp: false } });
    state.answer.mockReset();
    state.answer.mockResolvedValue({
      _tag: "Success",
      value: { specweaveDeclined: true, specweaveAdviceSeen: false },
    });
    state.navigate.mockReset();
    state.install.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = (props: { toolKey?: string; thread?: string; lastUserMessageAt?: string } = {}) =>
    act(async () =>
      root.render(
        <SpecweaveSetupCard
          environmentId={environmentId}
          projectId={projectId}
          threadId={props.thread ?? threadId}
          toolKey={props.toolKey ?? ""}
          lastUserMessageAt={props.lastUserMessageAt ?? null}
        />,
      ),
    );
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === name);
  const shownState = () => container.querySelector("[data-specweave-card]")?.getAttribute("data-state");

  it("shows the heading, the text and what setup adds, only in the thread that asked", async () => {
    await render({ thread: "another-thread" });
    expect(container.textContent).toBe("");
    await render();
    expect(container.querySelector("h3")?.textContent).toBe("Set up SpecWeave to plan this");
    expect(container.textContent).toContain(
      "A plan is a short spec with tasks, kept in your repository. It also puts this project's work on a board.",
    );
    expect(container.querySelector("summary")?.textContent).toBe("What it adds");
    expect([...container.querySelectorAll("[data-specweave-adds] li")].map((li) => li.textContent)).toEqual([
      ".specweave/",
      "Agent skills in .claude/ and .agents/",
      "Sections in AGENTS.md and CLAUDE.md",
      "Rules in .gitignore and .gitattributes",
    ]);
    expect(container.textContent).toContain("The new files are left for you to review and commit.");
    expect(container.querySelector("[data-specweave-git]")).toBeNull();
    expect(button("Set up SpecWeave")).toBeDefined();
    expect(button("Plan without it")).toBeDefined();
  });

  it("says it starts Git first in a folder without one, and asks for it", async () => {
    state.snapshot = { specweaveState: "off", specweaveSetupRequest: card({ gitRepository: false }) };
    await render();
    expect(container.querySelector("[data-specweave-git]")?.textContent).toBe(
      "This folder is not a Git repository yet, so this also starts one here.",
    );
    await act(async () => button("Set up Git and SpecWeave")!.click());
    expect(state.setUp).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, initGit: true, requestId: "req-1" },
    });
    // The snapshot is read again when the press returns.
    expect(state.refresh).toHaveBeenCalled();
  });

  it("passes the card's request id and reads Setting up until the snapshot says On", async () => {
    await render();
    await act(async () => button("Set up SpecWeave")!.click());
    expect(state.setUp.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { projectId, requestId: "req-1" },
    });
    expect(shownState()).toBe("setting_up");
    state.snapshot = { specweaveState: "on", specweaveSetupRequest: card({ state: "on" }) };
    await render();
    expect(shownState()).toBe("on");
    await act(async () => button("Open the Board")!.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas" },
      search: { checkout: "env-m4:project-atlas", pane: "board" },
    });
  });

  it("reads the snapshot every 5 s while Setting up, and stops after", async () => {
    vi.useFakeTimers();
    state.snapshot = { specweaveState: "off", specweaveSetupRequest: card({ state: "setting_up" }) };
    await render();
    state.refresh.mockReset();
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(state.refresh).toHaveBeenCalledTimes(2);
    state.snapshot = { specweaveState: "on", specweaveSetupRequest: card({ state: "on" }) };
    await render();
    state.refresh.mockReset();
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("reads the snapshot again when a launch tool finishes in the thread", async () => {
    state.snapshot = { specweaveState: "off" };
    await render({ toolKey: "" });
    expect(container.textContent).toBe("");
    await render({ toolKey: "1:item-7" });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a failure with its reason and Retry, and Node.js missing with its install", async () => {
    state.setUp.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail({ needs: "node", detail: "Node.js was not found" }),
    });
    await render();
    await act(async () => button("Set up SpecWeave")!.click());
    expect(shownState()).toBe("node_missing");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Node.js");
    await act(async () => button("Install Node.js")!.click());
    expect(state.install).toHaveBeenCalledWith({ environmentId, tool: "node", machineLabel: null });
    expect(button("Retry")).toBeDefined();

    state.snapshot = {
      specweaveState: "off",
      specweaveSetupRequest: card({ state: "failed", detail: "This folder is inside another repository." }),
    };
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(shownState()).toBe("failed");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This folder is inside another repository.",
    );
    expect(button("Retry")).toBeDefined();
  });

  it("reads Not allowed in a window without file access, and can still plan without it", async () => {
    state.canWrite = false;
    await render();
    expect(shownState()).toBe("not_allowed");
    expect(button("Set up SpecWeave")).toBeUndefined();
    await act(async () => button("Plan without it")!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, answer: "plan_without", requestId: "req-1" },
    });
    expect(state.refresh).toHaveBeenCalled();
  });

  it("keeps a declined card until the person writes again", async () => {
    state.snapshot = {
      specweaveState: "off",
      specweaveDeclined: true,
      specweaveSetupRequest: card({ state: "declined", updatedAt: "2026-11-18T10:05:00.000Z" }),
    };
    await render({ lastUserMessageAt: "2026-11-18T10:01:00.000Z" });
    expect(shownState()).toBe("declined");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await render({ lastUserMessageAt: "2026-11-18T10:06:00.000Z" });
    expect(container.textContent).toBe("");
  });
});

describe("SpecweaveSetupCardView", () => {
  it("has exactly the seven states, each with its own buttons", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const buttons: Record<string, string[]> = {};
    for (const shown of [
      { state: "asking" },
      { state: "setting_up" },
      { state: "on" },
      { state: "failed", detail: "refused" },
      { state: "node_missing", detail: "no node" },
      { state: "not_allowed", detail: "team rules" },
      { state: "declined" },
    ] as const) {
      await act(async () =>
        root.render(
          <SpecweaveSetupCardView
            shown={shown}
            gitRepository
            canAnswer
            onSetUp={() => undefined}
            onPlanWithout={() => undefined}
            onInstallNode={() => undefined}
            onOpenBoard={() => undefined}
          />,
        ),
      );
      buttons[shown.state] = [...container.querySelectorAll("button")].map(
        (entry) => entry.textContent ?? "",
      );
    }
    expect(buttons).toEqual({
      asking: ["Set up SpecWeave", "Plan without it"],
      setting_up: ["Set up SpecWeave", "Plan without it"],
      on: ["Open the Board"],
      failed: ["Retry", "Plan without it"],
      node_missing: ["Install Node.js", "Retry", "Plan without it"],
      not_allowed: ["Plan without it"],
      declined: [],
    });
    await act(async () => root.unmount());
    container.remove();
  });
});
