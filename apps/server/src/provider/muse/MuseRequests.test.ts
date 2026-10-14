import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MspError, type Session } from "@muse-code/sdk";
import * as Effect from "effect/Effect";
import { watchMuseRequests } from "./MuseRequests.ts";
const approval = (stage = 0) => ({
  approvalId: "approval",
  currentRequirementId: { approvalId: "approval", sourceIndex: stage },
  sessionId: "session",
  toolCallId: "tool",
  toolName: "shell",
  rawArgs: "{}",
  availableChoices: [{ choiceId: "allow", scope: "once", decision: "approved", label: "Allow" }],
});
afterEach(() => vi.useRealTimers());
describe("Muse native request races", () => {
  it("serializes stages and suppresses a trailing stage after a terminal acknowledgement", async () => {
    vi.useFakeTimers();
    let stage = 0;
    let prompts = 0;
    let finish!: (value: Record<string, unknown>) => void;
    const ack = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const commands = vi.fn(() => ack);
    const failed = vi.fn();
    const session = {
      sessionId: "session",
      fold: {
        pendingApprovals: () => [{ approvalId: "approval", requested: approval(stage) }],
        resolvedApprovals: () => [],
        pendingUserInputs: () => [],
        settledUserInputs: () => [],
      },
    } as unknown as Session;
    const stop = await watchMuseRequests({
      session,
      request: async () => ({ approvals: [], userInputs: [] }),
      command: commands,
      permission: () => () =>
        Effect.sync(() => {
          prompts++;
          return { outcome: { outcome: "selected" as const, optionId: "allow" } };
        }),
      failed,
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(prompts).toBe(1);
      stage = 1;
      await vi.advanceTimersByTimeAsync(200);
      expect(prompts).toBe(1);
      finish({ terminal: true });
      await vi.advanceTimersByTimeAsync(200);
      expect(prompts).toBe(1);
      expect(commands).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it.each(["approvalAlreadyResolved", "approvalRequirementStale"])(
    "keeps the host alive for a native %s race",
    async (kind) => {
      vi.useFakeTimers();
      const failed = vi.fn();
      const stages: number[] = [];
      const session = {
        sessionId: "session",
        fold: {
          pendingApprovals: () => [{ approvalId: "approval", requested: approval(2) }],
          resolvedApprovals: () => [],
          pendingUserInputs: () => [],
          settledUserInputs: () => [],
        },
      } as unknown as Session;
      const stop = await watchMuseRequests({
        session,
        request: async () => ({ approvals: [approval(0)], userInputs: [] }),
        command: async (_method, params) => {
          stages.push((params.requirementId as { sourceIndex: number }).sourceIndex);
          throw new MspError({ code: -32051, message: "native race", data: { kind } });
        },
        permission: () => () =>
          Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
        failed,
      });
      try {
        await vi.advanceTimersByTimeAsync(300);
        expect(stages).toEqual([2]);
        expect(failed).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});
