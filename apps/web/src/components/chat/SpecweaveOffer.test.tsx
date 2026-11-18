// @vitest-environment jsdom
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
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
    { projectKey: "atlas", memberProjects: [{ environmentId: "env-m4", id: "project-atlas" }] },
  ],
}));
vi.mock("../machineTools/machineToolInstallRequest", () => ({
  requestMachineToolInstall: vi.fn(),
}));

const { SpecweaveOffer, NotOnBoardNote } = await import("./SpecweaveOffer");

const environmentId = EnvironmentId.make("env-m4");
const projectId = ProjectId.make("project-atlas");
const off = (fields: Record<string, unknown> = {}) => ({
  settings: { kind: "code" },
  specweave: false,
  specweaveState: "off",
  gitRepository: true,
  ...fields,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.snapshot = off();
  state.refresh.mockReset();
  state.canWrite = true;
  state.canOperate = true;
  state.setUp.mockReset();
  state.setUp.mockResolvedValue({ _tag: "Success", value: { alreadySetUp: false } });
  state.answer.mockReset();
  state.answer.mockResolvedValue({
    _tag: "Success",
    value: { specweaveDeclined: false, specweaveAdviceSeen: true },
  });
  state.navigate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(async () => root.render(<SpecweaveOffer environmentId={environmentId} projectId={projectId} />));
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === name || entry.getAttribute("aria-label") === name,
  );
const line = () => container.querySelector("[data-specweave-offer]");

describe("SpecweaveOffer", () => {
  it("advises once with three actions, and takes no focus", async () => {
    const before = document.activeElement;
    await render();
    expect(line()?.textContent).toContain("Plan this project's work on a board.");
    expect(button("Set up SpecWeave")).toBeDefined();
    expect(button("See the board")).toBeDefined();
    expect(button("Dismiss")).toBeDefined();
    expect(document.activeElement).toBe(before);
  });

  it("does not show once seen, declined, set up, or where the server cannot store it", async () => {
    for (const snapshot of [
      off({ specweaveAdviceSeen: true }),
      off({ specweaveDeclined: true }),
      off({ specweave: true, specweaveState: "on" }),
      off({ specweaveState: undefined }),
    ]) {
      state.snapshot = snapshot;
      await render();
      expect(line()).toBeNull();
    }
  });

  it("dismisses: declines and never returns", async () => {
    await render();
    await act(async () => button("Dismiss")!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, answer: "advice_dismissed" },
    });
    expect(line()).toBeNull();
  });

  it("See the board marks it seen and opens the Board tab", async () => {
    await render();
    await act(async () => button("See the board")!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, answer: "advice_seen" },
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas" },
      search: { checkout: "env-m4:project-atlas", pane: "board" },
    });
    expect(line()).toBeNull();
  });

  it("sets up in one press, says Git starts first where there is none, and marks it seen", async () => {
    state.snapshot = off({ gitRepository: false });
    await render();
    expect(line()?.querySelector("[data-specweave-git]")?.textContent).toBe(
      "This folder is not a Git repository yet, so this also starts one here.",
    );
    await act(async () => button("Set up Git and SpecWeave")!.click());
    expect(state.setUp).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, initGit: true },
    });
    expect(state.answer).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, answer: "advice_seen" },
    });
    expect(line()).toBeNull();
  });

  it("keeps the line with its reason when setup fails, though the advice is seen", async () => {
    state.setUp.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("npx failed")) });
    await render();
    await act(async () => button("Set up SpecWeave")!.click());
    state.snapshot = off({ specweaveAdviceSeen: true });
    await render();
    expect(line()?.querySelector('[role="alert"]')?.textContent).toBe("npx failed");
    expect(button("Set up SpecWeave")).toBeDefined();
  });

  it("offers only the board and the dismiss in a window that cannot change files", async () => {
    state.canWrite = false;
    await render();
    expect(button("Set up SpecWeave")).toBeUndefined();
    expect(button("See the board")).toBeDefined();
  });
});

describe("NotOnBoardNote", () => {
  const renderNote = () =>
    act(async () =>
      root.render(<NotOnBoardNote environmentId={environmentId} projectId={projectId} />),
    );

  it("marks an increment of an unfinished project and opens the Board", async () => {
    state.snapshot = off({ specweaveState: "unfinished" });
    await renderNote();
    const note = container.querySelector<HTMLButtonElement>("[data-not-on-board]");
    expect(note?.textContent).toBe("Not on the board yet");
    await act(async () => note!.click());
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { checkout: "env-m4:project-atlas", pane: "board" } }),
    );
  });

  it("shows nothing in a project that is on", async () => {
    state.snapshot = off({ specweave: true, specweaveState: "on" });
    await renderNote();
    expect(container.textContent).toBe("");
  });
});
