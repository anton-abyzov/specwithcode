import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";

const toasts = vi.hoisted(() => ({
  added: [] as Array<Record<string, unknown>>,
  closed: [] as unknown[],
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (options: Record<string, unknown>) => options,
  toastManager: {
    add: (options: Record<string, unknown>) => {
      toasts.added.push(options);
      return `toast-${toasts.added.length}`;
    },
    close: (id: unknown) => toasts.closed.push(id),
  },
}));

import { toastProviderUpdateResult } from "./providerUpdateResultToast";

const target = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
};

function updated(updateState: ServerProvider["updateState"]) {
  return AsyncResult.success({
    providers: [{ ...target, updateState } as ServerProvider],
  }) as never;
}

const failed = (message: string, inUse?: true) => ({
  status: "failed" as const,
  startedAt: "2026-10-30T12:00:00.000Z",
  finishedAt: "2026-10-30T12:00:01.000Z",
  message,
  output: null,
  ...(inUse ? { inUse } : {}),
});

describe("toastProviderUpdateResult", () => {
  beforeEach(() => {
    toasts.added.length = 0;
    toasts.closed.length = 0;
  });

  it("offers Update anyway for an in-use refusal and retries with force", () => {
    // Settings passes a retry that re-runs the update with force.
    const runProviderUpdate = vi.fn();
    toastProviderUpdateResult({
      target,
      result: updated(failed("codex is running (pid 7: codex).", true)),
      updateAnyway: () => runProviderUpdate(target, undefined, true),
    });
    expect(toasts.added).toHaveLength(1);
    const toast = toasts.added[0]!;
    expect(toast.title).toBe("Codex is running");
    expect(toast.description).toBe("codex is running (pid 7: codex).");
    const action = toast.actionProps as { children: string; onClick: () => void };
    expect(action.children).toBe("Update anyway");
    action.onClick();
    expect(toasts.closed).toEqual(["toast-1"]);
    expect(runProviderUpdate).toHaveBeenCalledWith(target, undefined, true);
  });

  it("offers no forced retry for other failures or a success", () => {
    const updateAnyway = vi.fn();
    toastProviderUpdateResult({
      target,
      result: updated(failed("npm exited with code 1.")),
      updateAnyway,
    });
    toastProviderUpdateResult({
      target,
      result: updated({ ...failed("done"), status: "succeeded" }),
      updateAnyway,
    });
    expect(toasts.added).toHaveLength(0);
    expect(updateAnyway).not.toHaveBeenCalled();
  });
});
