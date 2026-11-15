import { ProviderInstanceId, RunId } from "@specweave-studio/contracts";
import type { ThreadRuntimeSummary } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { isWorktreeChangeBlocked } from "./branchWorktreeChangeGuard";

function runtime(status: "preparing" | "running" | "idle"): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: status === "idle" ? null : RunId.make("run"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("isWorktreeChangeBlocked", () => {
  it.each([
    ["preparing", "/repo/wt-a", null, true],
    ["running", "/repo/wt-a", "/repo/wt-b", true],
    ["running", null, "/repo/wt-b", true],
    ["running", "/repo/wt-a", "/repo/wt-a", false],
    ["idle", "/repo/wt-a", null, false],
  ] as const)(
    "a %s turn moving %s -> %s is blocked: %s",
    (status, currentWorktreePath, nextWorktreePath, blocked) => {
      expect(
        isWorktreeChangeBlocked({
          runtime: runtime(status),
          currentWorktreePath,
          nextWorktreePath,
        }),
      ).toBe(blocked);
    },
  );

  it("never blocks a thread without a session", () => {
    expect(
      isWorktreeChangeBlocked({
        runtime: null,
        currentWorktreePath: "/repo/wt-a",
        nextWorktreePath: null,
      }),
    ).toBe(false);
  });
});
