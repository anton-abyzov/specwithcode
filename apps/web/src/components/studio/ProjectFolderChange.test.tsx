// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { ProjectFolderCheck } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  folderCheck: vi.fn(),
  changeFolder: vi.fn(),
  interrupt: vi.fn(),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { folderCheck: "folderCheck", changeFolder: "changeFolder" },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { interruptTurn: "interrupt" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state) => state[command],
}));
vi.mock("../../localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (r: { error: Error }) => r.error,
}));
import { ProjectFolderChange } from "./ProjectFolderChange";

const stub = "/Users/me/Projects/sw-easychamp/easychamp";
const parent = "/Users/me/Projects/sw-easychamp";
const project = {
  id: "easychamp",
  environmentId: "host",
  title: "easychamp",
  workspaceRoot: stub,
} as EnvironmentProject;

const check = (patch: Partial<ProjectFolderCheck> = {}): ProjectFolderCheck =>
  ({
    projectId: "easychamp",
    currentRoot: stub,
    targetRoot: parent,
    unchanged: false,
    targetExists: true,
    currentRepository: null,
    targetRepository: "github.com/easychamp/easychamp",
    sameRepository: false,
    conflictingProject: null,
    activeThreads: [],
    threadCount: 14,
    reboundWorktreeCount: 0,
    keptInPlaceCount: 0,
    specweaveWorkspace: true,
    ...patch,
  }) as ProjectFolderCheck;

let root: Root, container: HTMLDivElement;
const onChanged = vi.fn();
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(state)) fn.mockReset();
  onChanged.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() =>
    root.render(<ProjectFolderChange project={project} disabled={false} onChanged={onChanged} />),
  );
}
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
async function typeFolder(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="New project folder"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(name: string) {
  await act(async () => {
    button(name).click();
  });
}

describe("ProjectFolderChange", () => {
  it("says a repository's threads keep running in place when moving up to the umbrella", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ keptInPlaceCount: 13, currentRoot: "/umb/repositories/specweave" }),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(container.textContent).toContain(
      "14 threads stay in the project. 13 threads keep running in /umb/repositories/specweave",
    );
    expect(container.textContent).not.toContain("move with the project");
  });

  it("re-points easychamp to the repository root after the user confirms the folder", async () => {
    state.folderCheck.mockResolvedValue({ _tag: "Success", value: check() });
    state.changeFolder.mockResolvedValue({ _tag: "Success", value: {} });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(state.folderCheck).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "easychamp", workspaceRoot: parent },
    });
    expect(container.textContent).toContain("Different repository");
    expect(container.textContent).toContain("14 threads move with the project");
    expect(container.textContent).toContain("Import SpecWeave workspace");
    expect(button("Change folder").disabled).toBe(true);

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    expect(button("Change folder").disabled).toBe(false);
    await click("Change folder");
    expect(state.changeFolder).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "easychamp", workspaceRoot: parent, confirmDifferentRepository: true },
    });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(`The project now uses ${parent}.`);
  });

  it("names the project that owns the folder and keeps the change disabled", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({
        conflictingProject: { id: "old", title: "EasyChamp", threadCount: 21, archived: true },
      } as unknown as Partial<ProjectFolderCheck>),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(container.textContent).toContain(
      'belongs to the project "EasyChamp" (21 threads, archived)',
    );
    expect(button("Change folder").disabled).toBe(true);
  });

  it("stops running work on request and checks again", async () => {
    state.folderCheck
      .mockResolvedValueOnce({
        _tag: "Success",
        value: check({
          sameRepository: true,
          activeThreads: [
            { id: "t1", title: "Coordinator" },
            { id: "t2", title: "Worker" },
          ],
        } as unknown as Partial<ProjectFolderCheck>),
      })
      .mockResolvedValueOnce({ _tag: "Success", value: check({ sameRepository: true }) });
    state.interrupt.mockResolvedValue({ _tag: "Success", value: {} });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(container.textContent).toContain(
      'Stop the running work first: "Coordinator", "Worker".',
    );
    expect(button("Change folder").disabled).toBe(true);
    await click("Stop 2 runs");
    expect(state.interrupt).toHaveBeenCalledTimes(2);
    expect(state.interrupt).toHaveBeenCalledWith({
      environmentId: "host",
      input: { threadId: "t1" },
    });
    expect(state.folderCheck).toHaveBeenCalledTimes(2);
    expect(button("Change folder").disabled).toBe(false);
  });

  it("shows the server's refusal", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ sameRepository: true }),
    });
    state.changeFolder.mockResolvedValue({
      _tag: "Failure",
      error: new Error(
        "The project folder did not change. Check the folder in project settings before trying again.",
      ),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    await click("Change folder");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The project folder did not change.",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});
