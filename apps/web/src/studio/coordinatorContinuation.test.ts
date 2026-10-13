import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@specweave-studio/contracts";
import { createCoordinatorModelSave } from "./coordinatorModelSave";
import {
  assertCoordinatorQueueModel,
  continueWithProjectModel,
  createCoordinatorSelectionTracker,
  resumeQueueWithProjectModel,
} from "./coordinatorContinuation";
import type { ProjectMessageRouting } from "./projectMessageRouting";
const claude = { instanceId: ProviderInstanceId.make("claude"), model: "opus" } as ModelSelection;
const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "effort", value: "low" }],
} as ModelSelection;
const routing = (
  continueCoordinator: NonNullable<ProjectMessageRouting["continueCoordinator"]>,
): ProjectMessageRouting => ({
  coordinatorThreadId: "coord" as never,
  continueCoordinator,
  send: vi.fn(),
  openCoordinator: vi.fn(),
  openThread: () => true,
});

describe("coordinator native continuations", () => {
  it("retains acknowledged selection until the projection catches up and accepts newer external edits", () => {
    const model = createCoordinatorSelectionTracker();
    model.observe(claude, 1);
    model.observe(codex, 2);
    model.observe(claude, 1);
    expect(model.selection()).toEqual(codex);
    model.observe(claude, 3);
    expect(model.selection()).toEqual(claude);
  });
  it.each(["resume", "plan"])(
    "waits for persistence and resolves %s selection after acknowledgement",
    async (kind) => {
      const model = createCoordinatorSelectionTracker();
      model.observe(claude, 1);
      const gate = createCoordinatorModelSave();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const save = gate.save(async () => {
        await pending;
        model.observe(codex, 2);
      });
      const operation = vi.fn(async (selection) => ({ kind, selection }));
      const result = continueWithProjectModel(
        routing((op) => gate.run(() => op(model.selection()))),
        undefined,
        operation,
      );
      expect(operation).not.toHaveBeenCalled();
      finish();
      await save;
      expect(await result).toEqual({ kind, selection: codex });
      expect(operation).toHaveBeenCalledOnce();
    },
  );
  it("refuses native continuation after rejected persistence", async () => {
    const gate = createCoordinatorModelSave();
    await gate.save(async () => {
      throw new Error("Conflict");
    });
    const operation = vi.fn(async () => {});
    await expect(
      continueWithProjectModel(
        routing((op) => gate.run(() => op(claude))),
        undefined,
        operation,
      ),
    ).rejects.toThrow("Conflict");
    expect(operation).not.toHaveBeenCalled();
  });
  it("leaves worker-native continuation unchanged", async () => {
    const worker: ProjectMessageRouting = {
      coordinatorThreadId: "coord" as never,
      send: vi.fn(),
      openCoordinator: vi.fn(),
      openThread: () => true,
    };
    const operation = vi.fn(async () => {});
    await continueWithProjectModel(worker, claude, operation);
    expect(operation).toHaveBeenCalledExactlyOnceWith(claude);
    expect(worker.send).not.toHaveBeenCalled();
  });
  it("preserves held requests with a different model or options instead of releasing their old choices", () => {
    expect(() =>
      assertCoordinatorQueueModel(codex, [{ status: "queued", modelSelection: claude }]),
    ).toThrow("Queued requests use a different model");
    expect(() =>
      assertCoordinatorQueueModel(codex, [
        {
          status: "queued",
          modelSelection: { ...codex, options: [{ id: "effort", value: "high" }] },
        },
      ]),
    ).toThrow("Queued requests use a different model");
    expect(() =>
      assertCoordinatorQueueModel(codex, [
        { status: "completed", modelSelection: claude },
        { status: "queued", modelSelection: codex },
      ]),
    ).not.toThrow();
  });
  it("checks requests arriving while the coordinator model is saving before releasing the queue", async () => {
    const gate = createCoordinatorModelSave();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = gate.save(() => pending);
    let runs: Array<{ status: string; modelSelection: ModelSelection }> = [];
    const readRuns = vi.fn(() => runs);
    const resume = vi.fn(async () => "released");
    const continuation = resumeQueueWithProjectModel(
      routing((op) => gate.run(() => op(codex))),
      claude,
      readRuns,
      resume,
    );
    expect(readRuns).not.toHaveBeenCalled();
    // A server projection update lands while the save is pending; no React render is required.
    runs = [{ status: "queued", modelSelection: claude }];
    finish();
    await save;
    await expect(continuation).rejects.toThrow("Queued requests use a different model");
    expect(resume).not.toHaveBeenCalled();
    runs = [{ status: "queued", modelSelection: codex }];
    await expect(
      resumeQueueWithProjectModel(
        routing((op) => gate.run(() => op(codex))),
        claude,
        readRuns,
        resume,
      ),
    ).resolves.toBe("released");
    expect(resume).toHaveBeenCalledOnce();
  });
  it("refuses a coordinator queue release when its current projection is unavailable", async () => {
    const resume = vi.fn(async () => {});
    await expect(
      resumeQueueWithProjectModel(
        routing((op) => op(codex)),
        claude,
        () => null,
        resume,
      ),
    ).rejects.toThrow("Reload coordinator details");
    expect(resume).not.toHaveBeenCalled();
  });
  it("leaves a worker queue on its native resume path without inspecting coordinator state", async () => {
    const readRuns = vi.fn(() => null);
    const resume = vi.fn(async () => "released");
    await expect(resumeQueueWithProjectModel(null, undefined, readRuns, resume)).resolves.toBe(
      "released",
    );
    expect(readRuns).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
  });
});
