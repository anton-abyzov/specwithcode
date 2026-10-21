// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  toggle: vi.fn(),
  refresh: vi.fn(),
  upsert: vi.fn(),
  tasks: [] as Array<Record<string, unknown> & { id: string; enabled: boolean }>,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => ({}),
    setScheduledTaskEnabled: "toggle",
    runScheduledTaskNow: "run",
    upsertScheduledTask: "upsert",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { tasks: state.tasks },
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "run" | "toggle" | "upsert") => state[name],
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (r: { error: Error }) => r.error,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => <a>{children}</a>,
}));
import { ProjectRoutines } from "./ProjectRoutines";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.refresh.mockReset();
  state.upsert.mockReset().mockResolvedValue({ _tag: "Success" });
  const daily = { type: "fixed_time", timeOfDay: "09:00" };
  state.tasks = [
    { id: "daily", projectId: "project", title: "Daily review", enabled: true, schedule: daily },
    {
      id: "foreign",
      projectId: "another",
      title: "Foreign routine",
      enabled: true,
      schedule: daily,
    },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const openThread = vi.fn();
async function render(canOperate = true, admissionBlocked = false, personal = false) {
  await act(async () =>
    root.render(
      <ProjectRoutines
        environmentId={EnvironmentId.make("host")}
        projectId={ProjectId.make("project")}
        projectKey="atlas"
        canOperate={canOperate}
        admissionBlocked={admissionBlocked}
        personal={personal}
        modelSelection={{ instanceId: "claudeAgent", model: "fixture" } as never}
        onOpenThread={openThread}
      />,
    ),
  );
}
function button(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
describe("Project routine admission and durable browser receipts", () => {
  it("retries an uncertain run after remount with the same ID and allocates anew after acknowledgement", async () => {
    state.run.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Response lost") });
    await render();
    expect(container.textContent).not.toContain("Foreign routine");
    await click("Run now");
    const first = state.run.mock.calls[0]![0].input.commandId;
    expect(first).toBeTruthy();
    expect(container.textContent).toContain("Response lost");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click("Run now");
    expect(state.run.mock.calls[1]![0].input.commandId).toBe(first);
    await click("Run now");
    expect(state.run.mock.calls[2]![0].input.commandId).not.toBe(first);
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });
  it("retains identity after a thrown transport error and guards concurrent clicks", async () => {
    let reject!: (reason: Error) => void;
    state.run.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    await render();
    await act(async () => {
      button("Run now").click();
      button("Run now").click();
    });
    expect(state.run).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Disconnected")));
    expect(container.textContent).toContain("Disconnected");
    await click("Run now");
    expect(state.run.mock.calls[1]![0].input.commandId).toBe(
      state.run.mock.calls[0]![0].input.commandId,
    );
  });
  it("blocks new runs and enabling while paused or archived but allows disabling", async () => {
    await render(true, true);
    expect(button("Run now").disabled).toBe(true);
    expect(button("Pause").disabled).toBe(false);
    await click("Pause");
    expect(state.toggle).toHaveBeenCalledWith({
      environmentId: "host",
      input: { id: "daily", enabled: false },
    });
    state.tasks[0]!.enabled = false;
    await render(true, true);
    expect(button("Enable").disabled).toBe(true);
    await click("Run now");
    expect(state.run).not.toHaveBeenCalled();
  });
  it("blocks all mutations for read-only or disconnected clients", async () => {
    await render(false);
    expect(button("Run now").disabled).toBe(true);
    expect(button("Pause").disabled).toBe(true);
    await click("Pause");
    await click("Run now");
    expect(state.toggle).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });
  it("starts a new intent only after explicit review of a typed unknown-outcome error", async () => {
    state.run.mockResolvedValueOnce({
      _tag: "Failure",
      error: Object.assign(new Error("Check its thread first"), { reason: "run_outcome_unknown" }),
    });
    await render();
    await click("Run now");
    const id = state.run.mock.calls[0]![0].input.commandId;
    expect(container.textContent).toContain("previous run may still be working");
    await click("I checked the previous run; start a new run");
    expect(state.run.mock.calls[1]![0].input.commandId).not.toBe(id);
    expect(container.textContent).not.toContain("previous run may still be working");
  });
  it("never offers a new intent for an ordinary transport failure", async () => {
    state.run.mockRejectedValueOnce(new Error("Timeout"));
    await render();
    await click("Run now");
    expect(container.textContent).not.toContain("I checked the previous run");
  });
  it("keeps a retry safe when session storage is unavailable", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    try {
      state.run.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Uncertain") });
      await render();
      await click("Run now");
      await click("Run now");
      expect(state.run.mock.calls[1]![0].input.commandId).toBe(
        state.run.mock.calls[0]![0].input.commandId,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
// A fictional household: nothing here names a real person, account or folder.
describe("Personal routines", () => {
  it("shows a routine's cadence, inputs, result and thread, without Pause when run by hand", async () => {
    state.tasks = [
      {
        id: "tax",
        projectId: "project",
        title: "Monthly tax prep",
        enabled: true,
        schedule: { type: "manual" },
        ownThread: true,
        threadId: "routine-thread-1",
        brief: {
          inputs: [{ label: "Receipts", location: "/fixtures/example-household/receipts" }],
          output: "tax/{period}-prep.md",
          prepareOnly: true,
        },
      },
    ];
    await render(true, false, true);
    expect(container.querySelector("[data-routine-cadence]")?.textContent).toBe("When you ask");
    expect(container.textContent).toContain("/fixtures/example-household/receipts");
    expect(container.textContent).toContain("tax/{period}-prep.md");
    expect(button("Pause")).toBeUndefined();
    await click("Open its thread");
    expect(openThread).toHaveBeenCalledWith("routine-thread-1");
  });
  it("saves a template as a hand-run, prepare-only routine with its own thread", async () => {
    state.tasks = [];
    await render(true, false, true);
    expect(container.textContent).toContain("Start from a template");
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button.sws-routine-template")]
        .find((b) => b.textContent?.includes("Monthly tax prep"))!
        .click(),
    );
    // Nothing is saved until Save.
    expect(state.upsert).not.toHaveBeenCalled();
    const receipts = container.querySelector<HTMLInputElement>(
      'input[placeholder="Folder with receipts"]',
    )!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(receipts, "/fixtures/example-household/receipts");
      receipts.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save routine");
    const input = state.upsert.mock.calls[0]![0].input;
    expect(input.schedule).toEqual({ type: "manual" });
    expect(input.ownThread).toBe(true);
    expect(input.threadId).toBeNull();
    expect(input.brief).toEqual({
      inputs: [{ label: "Receipts", location: "/fixtures/example-household/receipts" }],
      output: "tax/{period}-prep.md",
      prepareOnly: true,
    });
    expect(state.refresh).toHaveBeenCalled();
  });
  it("offers no templates outside a personal project", async () => {
    await render();
    expect(container.textContent).not.toContain("Start from a template");
  });
});
