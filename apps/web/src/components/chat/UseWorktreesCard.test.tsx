// @vitest-environment jsdom
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  allowed: true,
  save: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  useProjectOverrideWriteMode: () => "per-key",
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));

const { UseWorktreesCard } = await import("./UseWorktreesCard");

const environmentId = EnvironmentId.make("env-m4");
const projectId = ProjectId.make("project-atlas");

describe("UseWorktreesCard", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.settings = DEFAULT_SERVER_SETTINGS;
    state.allowed = true;
    state.save.mockReset();
    state.save.mockResolvedValue({ _tag: "Success" });
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
    act(async () =>
      root.render(<UseWorktreesCard environmentId={environmentId} projectId={projectId} />),
    );
  const button = () =>
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Turn on Use worktrees for this project",
    );

  it("turns on only this project's switch with one click", async () => {
    await render();
    expect(
      container.querySelector("[data-use-worktrees]")?.getAttribute("data-use-worktrees"),
    ).toBe("off");
    await act(async () => button()!.click());
    expect(state.save).toHaveBeenCalledTimes(1);
    const { input } = state.save.mock.calls[0]![0];
    expect(state.save.mock.calls[0]![0].environmentId).toBe(environmentId);
    expect(input.patch.projectSettingsOverrideChanges).toEqual({
      [projectId]: { set: { defaultThreadEnvMode: "worktree" } },
    });
  });

  it("says it is on once the project's switch is on, with no button", async () => {
    state.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
    };
    await render();
    expect(container.textContent).toContain("Use worktrees is on for this project");
    expect(button()).toBeUndefined();
  });

  it("disables the button without permission to change settings", async () => {
    state.allowed = false;
    await render();
    expect(button()!.disabled).toBe(true);
  });
});
