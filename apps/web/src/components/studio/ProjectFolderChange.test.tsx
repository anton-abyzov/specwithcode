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
  folderStop: vi.fn(),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    folderCheck: "folderCheck",
    changeFolder: "changeFolder",
    folderStop: "folderStop",
  },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { interruptTurn: "interrupt" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state) => state[command],
}));
vi.mock("../../localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("../../studio/machineNickname", () => ({ useMachineNickname: () => "M4" }));
vi.mock("./ProjectFolderCopies", () => ({ ProjectFolderCopies: () => null }));
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
    expect(container.textContent).toContain(
      "The current folder has no Git remote; the new one is github.com/easychamp/easychamp. The current folder is inside the new one.",
    );
    expect(container.textContent).toContain("14 threads move with the project");
    expect(container.textContent).not.toMatch(/Import SpecWeave|workspace/u);
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

  it("never calls a thread stopped that only stopped blocking the change", async () => {
    vi.useFakeTimers();
    try {
      state.folderCheck
        .mockResolvedValueOnce({
          _tag: "Success",
          value: check({
            activeThreads: [{ id: "t1", title: "Worker", runId: "run-1" }],
          } as unknown as Partial<ProjectFolderCheck>),
        })
        .mockResolvedValue({
          _tag: "Success",
          // The old folder now has a Git remote for a different repository.
          // Worker stays in place and keeps the same run; it is no longer a blocker.
          value: check({ keptInPlaceCount: 1, currentRepository: "github.com/easychamp/other" }),
        });
      // The fresh folder Stop check also excludes the kept-in-place worker.
      state.folderStop.mockResolvedValue({ _tag: "Success", value: { stopped: [], failed: [] } });
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(state.folderStop).toHaveBeenCalledTimes(1);
      const status = container.querySelector("[data-folder-stopped]")?.textContent;
      expect(status ?? "").not.toContain("Stopped");
      expect(status ?? "").toContain('"Worker" no longer blocks this change.');
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the Stop wait at once when a check rules the move out", async () => {
    vi.useFakeTimers();
    try {
      const activeThreads = [
        { id: "t1", title: "Write project memory", runId: "run-1" },
      ] as unknown as ProjectFolderCheck["activeThreads"];
      state.folderCheck
        .mockResolvedValueOnce({ _tag: "Success", value: check({ activeThreads }) })
        .mockResolvedValue({
          _tag: "Success",
          value: check({ targetExists: false, activeThreads }),
        });
      const refused = `${parent} does not exist. Create or clone it first, then choose it again. "Write project memory" was not stopped.`;
      state.folderStop.mockResolvedValue({
        _tag: "Success",
        value: {
          stopped: [],
          failed: [{ id: "t1", title: "Write project memory", message: refused }],
        },
      });
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(state.folderStop).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(refused);
      expect(
        container.querySelector<HTMLInputElement>('[aria-label="New project folder"]')!.disabled,
      ).toBe(false);
      expect(button("Check").disabled).toBe(false);
      expect(container.textContent).not.toContain("Stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops running work, waits until it has stopped and keeps what was ticked", async () => {
    vi.useFakeTimers();
    try {
      const running = check({
        activeThreads: [
          { id: "t1", title: "Coordinator" },
          { id: "t2", title: "Worker" },
        ],
      } as unknown as Partial<ProjectFolderCheck>);
      state.folderCheck
        .mockResolvedValueOnce({ _tag: "Success", value: running })
        // Stop is asynchronous: the first check after it still sees one run.
        .mockResolvedValueOnce({
          _tag: "Success",
          value: check({
            activeThreads: [{ id: "t2", title: "Worker" }],
          } as unknown as Partial<ProjectFolderCheck>),
        })
        .mockResolvedValueOnce({ _tag: "Success", value: check() });
      state.folderStop.mockResolvedValue({
        _tag: "Success",
        value: { stopped: ["t1", "t2"], failed: [] },
      });
      render();
      await typeFolder(parent);
      await click("Check");
      expect(container.textContent).toContain(
        'Stop the running work first: "Coordinator", "Worker".',
      );
      await act(async () => {
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      });
      expect(button("Change folder").disabled).toBe(true);
      await click("Stop 2 runs");
      // The server stops what still blocks; the client names the threads it saw.
      expect(state.folderStop).toHaveBeenCalledTimes(1);
      expect(state.folderStop.mock.calls[0]![0]).toMatchObject({
        environmentId: "host",
        input: {
          projectId: "easychamp",
          workspaceRoot: parent,
          threads: [
            { id: "t1", runId: null },
            { id: "t2", runId: null },
          ],
        },
      });
      // While it stops, the box says so and the button shows progress.
      expect(container.textContent).toContain('Stopping "Coordinator", "Worker".');
      expect(button("Stopping…").getAttribute("aria-busy")).toBe("true");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(state.folderCheck).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('Stopping "Worker".');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(state.folderCheck).toHaveBeenCalledTimes(3);
      expect(container.querySelector("[data-folder-stopped]")?.textContent).toBe(
        'Stopped "Coordinator", "Worker". Nothing blocks the change now.',
      );
      expect(container.querySelector("[data-folder-active-work]")).toBeNull();
      // The confirmation ticked before Stop still holds, so the change is ready.
      expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(
        true,
      );
      expect(button("Change folder").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says which run is still going when Stop has not taken effect in time", async () => {
    vi.useFakeTimers();
    try {
      const running = check({
        sameRepository: true,
        activeThreads: [{ id: "t1", title: "Write project memory" }],
      } as unknown as Partial<ProjectFolderCheck>);
      state.folderCheck.mockResolvedValue({ _tag: "Success", value: running });
      state.folderStop.mockResolvedValue({
        _tag: "Success",
        value: {
          stopped: [],
          failed: [
            {
              id: "t1",
              title: "Write project memory",
              message: '"Write project memory" could not be stopped. Open it and press Stop there.',
            },
          ],
        },
      });
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(122_000);
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        '"Write project memory" is still running 2 minutes after Stop. "Write project memory" could not be stopped. Open it and press Stop there. Open the thread to see what it is doing, or press Stop again.',
      );
      expect(button("Stop 1 run").disabled).toBe(false);
      expect(button("Change folder").disabled).toBe(true);
      const checks = state.folderCheck.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(state.folderCheck.mock.calls.length).toBe(checks);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it could not tell when the checks after Stop stop answering", async () => {
    vi.useFakeTimers();
    try {
      state.folderCheck
        .mockResolvedValueOnce({
          _tag: "Success",
          value: check({
            sameRepository: true,
            activeThreads: [{ id: "t1", title: "Write project memory" }],
          } as unknown as Partial<ProjectFolderCheck>),
        })
        .mockReturnValue(new Promise(() => {}));
      // Nor does Stop itself answer: the checks run without waiting on it.
      state.folderStop.mockReturnValue(new Promise(() => {}));
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_500);
      });
      expect(state.folderCheck).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'The app could not confirm within 2 minutes that "Write project memory" stopped. Check the folder again, or open the thread.',
      );
      expect(button("Stop 1 run").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the refusal when the server cannot stop the work, and sends nothing else", async () => {
    vi.useFakeTimers();
    try {
      state.folderCheck.mockResolvedValue({
        _tag: "Success",
        value: check({
          sameRepository: true,
          activeThreads: [{ id: "t1", title: "Worker", runId: "run-1" }],
        } as unknown as Partial<ProjectFolderCheck>),
      });
      state.folderStop.mockResolvedValue({ _tag: "Failure", error: new Error("Unknown method") });
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      expect(state.folderStop.mock.calls[0]![0].input.threads).toEqual([
        { id: "t1", runId: "run-1" },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_500);
      });
      expect(state.interrupt).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        '"Worker" is still running 2 minutes after Stop. Stop failed: Unknown method. Open the thread to see what it is doing, or press Stop again.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a tick when the repositories it confirmed change during Stop", async () => {
    vi.useFakeTimers();
    try {
      state.folderCheck
        .mockResolvedValueOnce({
          _tag: "Success",
          value: check({
            activeThreads: [{ id: "t1", title: "Worker" }],
          } as unknown as Partial<ProjectFolderCheck>),
        })
        .mockResolvedValue({
          _tag: "Success",
          value: check({ targetRepository: "github.com/someone/else" }),
        });
      state.folderStop.mockResolvedValue({
        _tag: "Success",
        value: { stopped: ["t1"], failed: [] },
      });
      render();
      await typeFolder(parent);
      await click("Check");
      await act(async () => {
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      });
      await click("Stop 1 run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(
        false,
      );
      expect(container.querySelector("[data-folder-stopped]")?.textContent).toBe(
        'Stopped "Worker". Confirm the folder above, then press Change folder.',
      );
      expect(button("Change folder").disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for the folder confirmation after Stop instead of calling the change ready", async () => {
    vi.useFakeTimers();
    try {
      const noRemote = { sameRepository: false, targetRepository: null, currentRepository: null };
      state.folderCheck
        .mockResolvedValueOnce({
          _tag: "Success",
          value: check({
            ...noRemote,
            activeThreads: [{ id: "t1", title: "Write project memory" }],
          } as unknown as Partial<ProjectFolderCheck>),
        })
        .mockResolvedValue({ _tag: "Success", value: check(noRemote) });
      state.folderStop.mockResolvedValue({
        _tag: "Success",
        value: { stopped: ["t1"], failed: [] },
      });
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(container.querySelector("[data-folder-stopped]")?.textContent).toBe(
        'Stopped "Write project memory". Confirm the folder above, then press Change folder.',
      );
      expect(button("Change folder").disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting on Stop once the settings close", async () => {
    vi.useFakeTimers();
    try {
      state.folderCheck.mockResolvedValue({
        _tag: "Success",
        value: check({
          sameRepository: true,
          activeThreads: [{ id: "t1", title: "Worker" }],
        } as unknown as Partial<ProjectFolderCheck>),
      });
      state.folderStop.mockResolvedValue({ _tag: "Success", value: { stopped: [], failed: [] } });
      render();
      await typeFolder(parent);
      await click("Check");
      await click("Stop 1 run");
      act(() => root.unmount());
      root = createRoot(container);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(state.folderCheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block on held messages and says where they will run", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({
        sameRepository: true,
        heldThreads: [{ id: "t1", title: "Write project memory", messageCount: 2 }],
      } as unknown as Partial<ProjectFolderCheck>),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    expect(container.querySelector("[data-folder-held]")?.textContent).toBe(
      '"Write project memory" has 2 held messages. They run in the new folder when you resume the thread.',
    );
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

  it("says an empty new folder leaves the code behind and labels archived overlaps", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({
        sameRepository: false,
        targetEmpty: true,
        nestedProjects: [
          {
            id: "p9",
            title: "Projects",
            workspaceRoot: "/Users/test/Projects",
            relation: "contains",
            deleted: false,
            archived: true,
          },
        ],
      } as unknown as Partial<ProjectFolderCheck>),
    });
    render();
    await typeFolder(parent);
    await click("Check");
    const empty = container.querySelector("[data-folder-empty-target]")?.textContent ?? "";
    expect(empty).toContain("The new folder is empty. Changing the folder moves no files");
    expect(empty).toContain("including uncommitted work, stays there");
    expect(container.querySelector("[data-folder-nested-projects]")?.textContent).toContain(
      '"Projects" (contains it, archived)',
    );
  });
  it("says what the new folder holds and offers, unticked, to flip a switch that differs", async () => {
    const onSwitch = vi.fn();
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ sameRepository: true, layout: { ...umbrellaLayout, separateClones: true } }),
    });
    state.changeFolder.mockResolvedValue({ _tag: "Success", value: {} });
    const mount = () =>
      act(() =>
        root.render(
          <ProjectFolderChange
            project={project}
            disabled={false}
            onChanged={onChanged}
            useWorktrees={false}
            onUseWorktreesChange={onSwitch}
          />,
        ),
      );
    mount();
    await typeFolder(parent);
    await click("Check");
    expect(container.querySelector("[data-folder-repositories-found]")?.textContent).toBe(
      "2 repositories found. Threads can use any of them.",
    );
    expect(container.querySelector("[data-folder-switch-differs]")?.textContent).toBe(
      "Use worktrees is off. Recommended for this folder: on. Each thread gets its own folder and a worktree of only the repositories it changes.",
    );
    const box = () =>
      [...container.querySelectorAll("label")]
        .find((label) => label.textContent === "Also turn Use worktrees on")!
        .querySelector("input")!;
    expect(box().checked).toBe(false);
    // Without the box the folder changes and the switch stays.
    await click("Change folder");
    expect(state.changeFolder).toHaveBeenCalledOnce();
    expect(onSwitch).not.toHaveBeenCalled();
    // With it, the switch is applied with the folder change.
    await typeFolder(parent);
    await click("Check");
    await act(async () => box().click());
    await click("Change folder");
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith(true);
    expect(container.textContent).toContain("Use worktrees is now on.");
  });

  it("offers nothing when the switch already matches, or the host cannot flip it", async () => {
    state.folderCheck.mockResolvedValue({
      _tag: "Success",
      value: check({ layout: { ...umbrellaLayout, separateClones: true } }),
    });
    act(() =>
      root.render(
        <ProjectFolderChange
          project={project}
          disabled={false}
          onChanged={onChanged}
          useWorktrees={true}
          onUseWorktreesChange={() => {}}
        />,
      ),
    );
    await typeFolder(parent);
    await click("Check");
    expect(container.querySelector("[data-folder-switch-differs]")).toBeNull();
    expect(container.querySelector("[data-folder-workspace-recommendation]")?.textContent).toMatch(
      /^Recommended for this folder: on\./u,
    );
    expect(container.textContent).not.toContain("Also turn Use worktrees");
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
