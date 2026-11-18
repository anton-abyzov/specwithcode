// @vitest-environment jsdom
import { EnvironmentId, ProjectId, type ProjectWorkspaceReadResult } from "@specweave-studio/contracts";
import { Cause } from "effect";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canWrite: true,
  setUp: vi.fn(),
  answer: vi.fn(),
  install: vi.fn(),
  reducedMotion: false,
}));
vi.mock("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: { specweaveSetUp: "set-up", specweaveAnswer: "answer", read: () => null },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "set-up" ? state.setUp : state.answer),
}));
vi.mock("../../../state/session", async (original) => ({
  ...(await original<typeof import("../../../state/session")>()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === "filesystem:write" ? state.canWrite : true,
}));
vi.mock("../../machineTools/machineToolInstallRequest", () => ({
  requestMachineToolInstall: state.install,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../settings/useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));

const { BoardSetupView } = await import("./BoardSetup");
const { BoardExample, resetBoardExamplePlay } = await import("./BoardExample");
const { BoardSpecweaveSetup } = await import("../ProjectSpecweaveSetting");

const environmentId = EnvironmentId.make("env-m4");
const projectId = ProjectId.make("project-atlas");

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("reduce") && state.reducedMotion,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
  state.canWrite = true;
  state.reducedMotion = false;
  state.setUp.mockReset();
  state.setUp.mockResolvedValue({ _tag: "Success", value: { alreadySetUp: false } });
  state.answer.mockReset();
  state.answer.mockResolvedValue({
    _tag: "Success",
    value: { specweaveDeclined: true, specweaveAdviceSeen: false },
  });
  state.install.mockReset();
  resetBoardExamplePlay();
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

// The setup's own buttons; the example board's are inert.
const buttons = () =>
  [...container.querySelectorAll(".sws-board-setup button")].map((entry) => entry.textContent);
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".sws-board-setup button")].find(
    (entry) => entry.textContent === name,
  );
const noop = () => undefined;

describe("BoardSetupView", () => {
  const view = (props: Partial<Parameters<typeof BoardSetupView>[0]> = {}) =>
    act(async () =>
      root.render(
        <BoardSetupView
          kind="off"
          gitRepository
          shown={{ state: "asking" }}
          offerNotNow
          onSetUp={noop}
          onNotNow={noop}
          onInstallNode={noop}
          exampleColumns
          {...props}
        />,
      ),
    );

  it("explains the board and lists what setup adds before the one press", async () => {
    await view();
    expect(container.querySelector(".sws-board-setup h3")?.textContent).toBe(
      "See this project's work as a board",
    );
    expect(container.textContent).toContain(
      "Plans each piece of work as a short spec with tasks in your repository, and gives the project a board.",
    );
    expect([...container.querySelectorAll(".sws-board-setup-adds li")].map((li) => li.textContent)).toEqual([
      ".specweave/",
      "Agent skills in .claude/ and .agents/",
      "Sections in AGENTS.md and CLAUDE.md",
      "Rules in .gitignore and .gitattributes",
    ]);
    expect(buttons()).toEqual(["Set up SpecWeave", "Not now"]);
    expect(container.querySelector(".sws-board-example")).not.toBeNull();
  });

  it("says Git starts too in a folder without it", async () => {
    await view({ gitRepository: false });
    expect(container.querySelector("[data-specweave-git]")?.textContent).toBe(
      "This folder is not a Git repository yet, so this also starts one here.",
    );
    expect(buttons()).toEqual(["Set up Git and SpecWeave", "Not now"]);
  });

  it("names the plans written before setup and offers to finish it", async () => {
    await view({
      kind: "unfinished",
      unfinished: { count: 2, titles: ["Export", "Search"] },
      gitRepository: false,
    });
    expect(container.querySelector("h3")?.textContent).toBe("2 plans here are not on the board yet");
    expect([...container.querySelectorAll(".sws-board-setup-titles li")].map((li) => li.textContent)).toEqual([
      "Export",
      "Search",
    ]);
    expect(buttons()).toEqual(["Set up Git and finish"]);
    expect(container.querySelector(".sws-board-example")).toBeNull();
  });

  it("has the card's states", async () => {
    await view({ shown: { state: "setting_up" } });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Setting up SpecWeave…");
    expect(button("Set up SpecWeave")?.disabled).toBe(true);
    await view({ shown: { state: "failed", detail: "Inside another repository." } });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Inside another repository.");
    expect(buttons()).toEqual(["Retry", "Not now"]);
    await view({ shown: { state: "node_missing", detail: "x" } });
    expect(buttons()).toEqual(["Install Node.js", "Retry", "Not now"]);
    await view({ shown: { state: "not_allowed", detail: "No file access." } });
    expect(buttons()).toEqual(["Not now"]);
    await view({ offerNotNow: false });
    expect(buttons()).toEqual(["Set up SpecWeave"]);
  });
});

describe("BoardExample", () => {
  const example = () => container.querySelector<HTMLElement>(".sws-board-example")!;
  const groupsShown = () =>
    [...example().querySelectorAll<HTMLElement>("[data-group]")].map((node) => node.dataset.group);
  const columnOf = (id: string) =>
    example().querySelector(`[data-increment="${id}"]`)?.closest<HTMLElement>("[data-group]")?.dataset
      .group;

  it("is inert, hidden, marked Example, and uses the real groups without Blocked", async () => {
    await act(async () => root.render(<BoardExample columns />));
    expect(example().hasAttribute("inert")).toBe(true);
    expect(example().getAttribute("aria-hidden")).toBe("true");
    expect(example().querySelector(".sws-board-example-label")?.textContent).toBe("Example");
    expect(groupsShown()).toEqual(["planned", "active", "review", "done"]);
    // No request button on a sample card, no meter in Done.
    expect(example().textContent).not.toMatch(/with the coordinator/);
    expect(example().querySelector('[data-group="done"] .sws-board-meter')).toBeNull();
  });

  it("plays once, Planned to Active to In review to Done, waiting while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility as DocumentVisibilityState,
    );
    await act(async () => root.render(<BoardExample columns />));
    expect(example().dataset.frame).toBe("0");
    expect(columnOf("0004-export-reports")).toBe("planned");
    await act(async () => vi.advanceTimersByTime(1_600));
    expect(columnOf("0004-export-reports")).toBe("active");
    expect(example().querySelector('[data-increment="0004-export-reports"]')?.textContent).toContain(
      "Export reports as CSV",
    );
    visibility = "hidden";
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(columnOf("0004-export-reports")).toBe("active");
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(1_600));
    expect(columnOf("0004-export-reports")).toBe("review");
    await act(async () => vi.advanceTimersByTime(1_600));
    expect(columnOf("0004-export-reports")).toBe("done");
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(example().dataset.frame).toBe("3");
    // Seen once this session: a later visit starts on the last frame.
    await act(async () => root.render(<></>));
    await act(async () => root.render(<BoardExample columns />));
    expect(example().dataset.frame).toBe("3");
  });

  it("is a still last frame under reduced motion and when stacked", async () => {
    state.reducedMotion = true;
    await act(async () => root.render(<BoardExample columns />));
    expect(example().dataset.frame).toBe("3");
    state.reducedMotion = false;
    resetBoardExamplePlay();
    await act(async () => root.render(<></>));
    await act(async () => root.render(<BoardExample columns={false} />));
    expect(example().dataset.layout).toBe("stack");
    expect(example().dataset.frame).toBe("3");
    expect(groupsShown()).toEqual(["active", "review", "planned", "done"]);
  });
});

describe("BoardSpecweaveSetup", () => {
  const snapshot = (fields: Partial<ProjectWorkspaceReadResult> = {}) =>
    ({
      settings: { kind: "code" },
      memory: { files: [], totalBytes: 0 },
      specweave: false,
      specweaveState: "off",
      gitRepository: true,
      ...fields,
    }) as ProjectWorkspaceReadResult;
  const onChanged = vi.fn();
  const render = (fields: Partial<ProjectWorkspaceReadResult> = {}) =>
    act(async () =>
      root.render(
        <BoardSpecweaveSetup
          project={{ environmentId, id: projectId }}
          snapshot={snapshot(fields)}
          disabled={false}
          onChanged={onChanged}
          exampleColumns={false}
        />,
      ),
    );

  it("runs setup in one press, with Git in a folder without it, and reads again", async () => {
    await render({ gitRepository: false });
    await act(async () => button("Set up Git and SpecWeave")!.click());
    expect(state.setUp).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, initGit: true },
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows a failure stored on the server until a setup succeeds", async () => {
    await render({
      specweaveSetupFailure: { detail: "npx failed", failedAt: "2026-11-18T10:00:00.000Z" },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("npx failed");
    expect(buttons()).toEqual(["Retry", "Not now"]);
    await render({
      specweaveSetupFailure: {
        detail: "no node",
        needsNode: true,
        failedAt: "2026-11-18T10:00:00.000Z",
      },
    });
    await act(async () => button("Install Node.js")!.click());
    expect(state.install).toHaveBeenCalledWith({ environmentId, tool: "node", machineLabel: null });
  });

  it("stores Not now, and keeps the offer without it once declined", async () => {
    await render();
    await act(async () => button("Not now")!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, answer: "not_now" },
    });
    await render({ specweaveDeclined: true });
    expect(buttons()).toEqual(["Set up SpecWeave"]);
    // An older server cannot store it: no Not now there.
    await render({ specweaveState: undefined });
    expect(buttons()).toEqual(["Set up SpecWeave"]);
  });

  it("offers Git after an older server refused a folder outside one", async () => {
    state.setUp.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("SpecWeave needs a Git repository: Run git init here first.")),
    });
    await render({ gitRepository: undefined, specweaveState: undefined });
    await act(async () => button("Set up SpecWeave")!.click());
    expect(button("Set up Git and SpecWeave")).toBeDefined();
    expect(container.querySelector("[data-specweave-git]")).not.toBeNull();
  });

  it("reads Not allowed in a window that cannot change files", async () => {
    state.canWrite = false;
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cannot change files");
    expect(button("Set up SpecWeave")).toBeUndefined();
  });
});
