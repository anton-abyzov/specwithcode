import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { toggleProjectThreadResolution } from "./projectThreadResolution";
const thread = {
  id: "history",
  environmentId: "host",
  archivedAt: "2026-10-14",
  settledOverride: "settled",
} as EnvironmentThreadShell;
const success = { _tag: "Success", value: undefined } as const;
const failure = { _tag: "Failure" } as const;
// What unsettleThread returns for a server that predates Resolve.
const unsupported = AsyncResult.failure(
  Cause.fail({ _tag: "ThreadSettlementUnsupportedError", message: "Update the server." }),
);
const setup = () => ({
  unarchiveThread: vi.fn(async () => success),
  unsettleThread: vi.fn(async () => success),
  settleThread: vi.fn(async () => success),
});
describe("project Reopen", () => {
  it("restores legacy history and clears settlement without navigating away", async () => {
    const actions = setup(),
      refresh = vi.fn();
    await toggleProjectThreadResolution(thread, actions as never, refresh);
    expect(actions.unarchiveThread).toHaveBeenCalledWith(
      { environmentId: "host", threadId: "history" },
      { navigate: false },
    );
    expect(actions.unsettleThread).toHaveBeenCalledWith({
      environmentId: "host",
      threadId: "history",
    });
    expect(actions.unarchiveThread.mock.invocationCallOrder[0]).toBeLessThan(
      actions.unsettleThread.mock.invocationCallOrder[0]!,
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(actions.settleThread).not.toHaveBeenCalled();
  });
  it("stops when restoration fails", async () => {
    const actions = setup(),
      refresh = vi.fn();
    actions.unarchiveThread.mockResolvedValue(failure as never);
    expect(await toggleProjectThreadResolution(thread, actions as never, refresh)).toBe(failure);
    expect(actions.unsettleThread).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("returns settlement failure so the UI can report it", async () => {
    const actions = setup(),
      refresh = vi.fn();
    actions.unsettleThread.mockResolvedValue(failure as never);
    expect(await toggleProjectThreadResolution(thread, actions as never, refresh)).toBe(failure);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("counts history a server only archived as reopened once restored, on a server without Resolve", async () => {
    const actions = setup(),
      refresh = vi.fn();
    actions.unsettleThread.mockResolvedValue(unsupported as never);
    const archivedOnly = { ...thread, settledOverride: null } as EnvironmentThreadShell;
    expect(await toggleProjectThreadResolution(archivedOnly, actions as never, refresh)).toBe(
      success,
    );
    expect(actions.unarchiveThread).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("still reports a server without Resolve for history that was also resolved", async () => {
    const actions = setup();
    actions.unsettleThread.mockResolvedValue(unsupported as never);
    expect(await toggleProjectThreadResolution(thread, actions as never, vi.fn())).toBe(
      unsupported,
    );
  });
  it("still reports any other failure to clear settlement on archived-only history", async () => {
    const actions = setup();
    const offline = AsyncResult.failure(Cause.fail(new Error("offline")));
    actions.unsettleThread.mockResolvedValue(offline as never);
    const archivedOnly = { ...thread, settledOverride: null } as EnvironmentThreadShell;
    expect(await toggleProjectThreadResolution(archivedOnly, actions as never, vi.fn())).toBe(
      offline,
    );
  });
  it("reopens already live resolved threads without restoring history", async () => {
    const actions = setup();
    await toggleProjectThreadResolution({ ...thread, archivedAt: null }, actions as never, vi.fn());
    expect(actions.unarchiveThread).not.toHaveBeenCalled();
    expect(actions.unsettleThread).toHaveBeenCalledOnce();
  });
});
