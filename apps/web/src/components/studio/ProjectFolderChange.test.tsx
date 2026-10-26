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

function render(blockedReason: string | null = null) {
  act(() =>
    root.render(
      <ProjectFolderChange
        project={project}
        disabled={false}
        blockedReason={blockedReason}
        onChanged={onChanged}
      />,
    ),
  );
}
const umbrellaLayout = {
  kind: "umbrella",
  rootIsRepository: true,
  repositories: ["repositories/easychamp/api", "repositories/easychamp/web"],
  repositoryCount: 2,
  truncated: false,
} as const;
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

  it("says why the folder is locked while the settings form has unsaved edits", async () => {
    render("Save or discard your unsaved changes to change the folder.");
    expect(container.querySelector("[data-folder-blocked]")?.textContent).toBe(
      "Save or discard your unsaved changes to change the folder.",
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="New project folder"]')!.disabled,
    ).toBe(true);
    expect(button("Check").disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(container.querySelector("[data-folder-blocked]")).toBeNull();
  });

  it("reports kept threads after moving up to the umbrella, not that every thread moved", async () => {
    const repository = "/Users/me/Projects/sw-easychamp/repositories/easychamp/api";
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ currentRoot: repository, keptInPlaceCount: 13, layout: umbrellaLayout }),
    });
    state.changeFolder.mockResolvedValue({ _tag: "Success", value: {} });
    render();
    await typeFolder(parent);
    await click("Check");
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    await click("Change folder");
    const done = container.querySelector('[data-tone="ok"]')?.textContent ?? "";
    expect(done).toContain(
      `13 threads keep running in ${repository}; the coordinator and new threads use ${parent}.`,
    );
    expect(done).toContain(`To undo, change the folder back to ${repository}.`);
    expect(done).toContain("Changing it back does not move the kept threads.");
    expect(done).not.toContain("Its threads run there");
  });

  it("names rebound checkouts in the result when the threads move", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ sameRepository: true, reboundWorktreeCount: 2 }),
    });
    state.changeFolder.mockResolvedValue({ _tag: "Success", value: {} });
    render();
    await typeFolder(parent);
    await click("Check");
    await click("Change folder");
    const done = container.querySelector('[data-tone="ok"]')?.textContent ?? "";
    expect(done).toContain("Its threads run there from their next turn.");
    expect(done).toContain(
      "2 thread checkouts inside the old folder now point at the same place in the new one.",
    );
    expect(done).not.toContain("kept threads");
  });

  it("shows a refused folder as an error and keeps the change disabled", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({
        sameRepository: true,
        refusal: { reason: "folder_protected", detail: "The home folder cannot be a project." },
      }),
    });
    render();
    await typeFolder("/Users/me");
    await click("Check");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("The home folder cannot be a project.");
    expect(alert?.querySelector("[data-folder-refusal]")?.getAttribute("data-folder-refusal")).toBe(
      "folder_protected",
    );
    expect(container.textContent).not.toContain("Same repository");
    expect(button("Change folder").disabled).toBe(true);
  });

  it("warns about other projects inside or around the folder, deleted ones included", async () => {
    const other = (n: number, patch: { relation?: "inside" | "contains"; deleted?: boolean }) => ({
      id: `p${n}`,
      title: `Repo ${n}`,
      workspaceRoot: `${parent}/repositories/easychamp/repo-${n}`,
      relation: "inside" as const,
      deleted: false,
      ...patch,
    });
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({
        sameRepository: true,
        nestedProjects: [
          other(1, {}),
          other(2, { deleted: true }),
          other(3, { relation: "contains" }),
          other(4, {}),
          other(5, {}),
          other(6, {}),
        ],
      } as unknown as Partial<ProjectFolderCheck>),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    const line = container.querySelector("[data-folder-nested-projects]")?.textContent ?? "";
    expect(line).toContain(
      '"Repo 1" (inside the new folder), "Repo 2" (inside the new folder, deleted), "Repo 3" (contains it)',
    );
    expect(line).toContain('"Repo 5" (inside the new folder) and 1 more.');
    expect(line).not.toContain("Repo 6");
    expect(line).toContain(
      "A deleted project's threads, memory and routines do not come back with this change.",
    );
    expect(button("Change folder").disabled).toBe(false);
  });

  it("says new worktrees come from the umbrella's own repository, not its nested ones", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ layout: umbrellaLayout }),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(container.querySelector("[data-folder-worktree-source]")?.textContent).toBe(
      "New worktree threads and routines are cut from this folder's own repository, so they do not contain the nested repositories' code unless a repository is chosen for them.",
    );
  });

  it("says nothing about worktree sources for the current repository or a single checkout", async () => {
    state.folderCheck
      .mockResolvedValueOnce({
        _tag: "Success",
        value: check({ sameRepository: true, layout: umbrellaLayout }),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: check({
          layout: { ...umbrellaLayout, kind: "single", repositories: [], repositoryCount: 0 },
        }),
      });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(container.querySelector("[data-folder-worktree-source]")).toBeNull();
    await click("Check");
    expect(container.querySelector("[data-folder-worktree-source]")).toBeNull();
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
