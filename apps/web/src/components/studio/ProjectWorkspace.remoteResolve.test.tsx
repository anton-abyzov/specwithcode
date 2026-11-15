// @vitest-environment jsdom
// Resolve on a thread that runs on another machine: it follows that machine's connection,
// grant and version, never the viewed project's.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { state, container, render, shell } from "./ProjectWorkspace.test-fixtures";
import { toastManager } from "../ui/toast";

const REMOTE = { environmentId: "laptop", threadId: "laptop-worker" };
// The fixture labels a paired machine with its ID, and a reason never shows a raw ID.

// One project on two machines: the viewed copy on "host" and a linked copy on "laptop".
const domain = {
  id: "atlas-domain",
  title: "Atlas",
  coordinatorId: "atlas-coordinator",
  members: [
    { environmentId: "host", projectId: "project", coordinatorThreadId: "coord" },
    { environmentId: "laptop", projectId: "remote-project", coordinatorThreadId: "laptop-coord" },
  ],
};
function listLaptopThread() {
  Object.assign(state.project, {
    workspaceSettings: { logicalProject: domain, coordinatorThreadId: "coord" },
  });
  state.pairedHosts = ["laptop"];
  state.operableHosts = ["laptop"];
  state.otherCheckouts = [
    {
      id: "remote-project",
      environmentId: "laptop",
      workspaceRoot: "/w/atlas",
      workspaceSettings: { logicalProject: domain, coordinatorThreadId: "laptop-coord" },
    } as never,
  ];
  state.shells = [
    shell("coord"),
    shell("worker"),
    shell("laptop-worker", {
      environmentId: "laptop" as never,
      projectId: "remote-project" as never,
    }),
  ];
}
const row = () => container.querySelector<HTMLElement>('[data-thread-id="laptop-worker"]')!;
const rowResolve = () => row().querySelector<HTMLButtonElement>(".sws-thread-action")!;
async function openLaptopThread() {
  await act(async () => row().querySelector<HTMLButtonElement>(".sws-thread-open")!.click());
}
const headerResolve = () => container.querySelector<HTMLButtonElement>(".sws-thread-resolve")!;
const warnings = () =>
  (toastManager.add as unknown as { mock: { calls: Array<[{ description?: string }]> } }).mock
    .calls;

beforeEach(listLaptopThread);
afterEach(() => {
  delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
});

describe("Resolve on a thread that runs on another machine", () => {
  it("resolves from the thread list on the machine that runs the thread", async () => {
    await render();
    expect(rowResolve().disabled).toBe(false);
    expect(rowResolve().getAttribute("aria-disabled")).toBeNull();
    await act(async () => rowResolve().click());
    expect(state.settle).toHaveBeenCalledWith(REMOTE);
  });

  it("resolves from the open thread's header and returns to the thread list", async () => {
    await render();
    await openLaptopThread();
    expect(headerResolve().disabled).toBe(false);
    expect(headerResolve().getAttribute("aria-disabled")).toBeNull();
    state.settle.mockResolvedValueOnce({ _tag: "Success", value: undefined });
    await act(async () => headerResolve().click());
    expect(state.settle).toHaveBeenCalledWith(REMOTE);
    expect(container.querySelector(".sws-thread-resolve")).toBeNull();
  });

  it("still resolves it while the viewed project's own machine is disconnected", async () => {
    state.connected = false;
    // The fixture's single-machine reader ties every machine to `connected`; the list does not.
    await render();
    expect(rowResolve().getAttribute("aria-disabled")).toBeNull();
    await act(async () => rowResolve().click());
    expect(state.settle).toHaveBeenCalledWith(REMOTE);
  });

  it.each([
    [
      "is disconnected",
      () => {
        state.offlineHosts = ["laptop"];
      },
      "That machine isn't connected right now, so this thread can't be resolved.",
    ],
    [
      "gives this browser no operate grant",
      () => {
        state.operableHosts = [];
      },
      "This connection can't change threads there.",
    ],
    [
      "predates Resolve",
      () => {
        state.settlementUnsupportedHosts = ["laptop"];
      },
      "That machine runs an older version that can't resolve threads. Update it first.",
    ],
    [
      "has not sent its details yet",
      () => {
        state.serverConfigPendingHosts = ["laptop"];
      },
      "Still loading that machine's details. Try again in a moment.",
    ],
  ] as const)("says why, and sends nothing, when that machine %s", async (_case, arrange, reason) => {
    arrange();
    await render();
    expect(rowResolve().getAttribute("aria-disabled")).toBe("true");
    await act(async () => rowResolve().click());
    await openLaptopThread();
    expect(headerResolve().getAttribute("aria-disabled")).toBe("true");
    await act(async () => headerResolve().click());
    expect(state.settle).not.toHaveBeenCalled();
    expect(warnings().map(([toast]) => toast.description)).toEqual([reason, reason]);
    // The project's own thread is untouched by another machine's trouble.
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Back to project threads"]')!.click(),
    );
    const own = container.querySelector<HTMLButtonElement>(
      '[data-thread-id="worker"] .sws-thread-action',
    )!;
    expect(own.getAttribute("aria-disabled")).toBeNull();
  });

  it("blocks the project's own thread on the project's own machine, with the reason", async () => {
    state.canOperate = false;
    await render();
    const own = container.querySelector<HTMLButtonElement>(
      '[data-thread-id="worker"] .sws-thread-action',
    )!;
    expect(own.getAttribute("aria-disabled")).toBe("true");
    await act(async () => own.click());
    expect(state.settle).not.toHaveBeenCalled();
    expect(warnings().at(-1)?.[0].description).toBe(
      "This connection can't change threads on Test host.",
    );
  });
});
