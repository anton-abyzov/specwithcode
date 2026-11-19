import { CommandId, ProviderInstanceId, RunId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { preswitchMoveRefusal } from "./limitPreswitchGuard.ts";

// 1089: the orchestrator judges a pre-switch again when it lands, so a pick or
// a new turn made after the sweep's checks keeps the thread where it is.
const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const at = Date.parse("2026-11-19T12:00:00.000Z");
const run = (status: string, selection = claude, offset = 0) =>
  ({
    id: RunId.make(`r-${status}-${offset}`),
    threadId: ThreadId.make("t1"),
    ordinal: 1 + offset,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    status,
    requestedAt: DateTime.makeUnsafe(at - 120_000 + offset),
    startedAt: DateTime.makeUnsafe(at - 120_000 + offset),
    completedAt: status === "running" ? null : DateTime.makeUnsafe(at - 60_000 + offset),
  }) as never;
const thread = { modelSelection: claude, limitPreswitchFrom: null };

describe("preswitchMoveRefusal", () => {
  it("lets the move stand on the selection the completed turn ran", () => {
    expect(preswitchMoveRefusal(thread, [run("completed")]).refusal).toBeNull();
  });

  it("lets the move stand for a thread with no turn yet", () => {
    expect(preswitchMoveRefusal(thread, []).refusal).toBeNull();
  });

  it("refuses once a turn started or the latest one did not complete", () => {
    expect(preswitchMoveRefusal(thread, [run("completed"), run("running", claude, 1)]).refusal)
      .not.toBeNull();
    expect(preswitchMoveRefusal(thread, [run("interrupted")]).refusal).not.toBeNull();
    expect(preswitchMoveRefusal(thread, [run("failed")]).refusal).not.toBeNull();
  });

  it("refuses after a person's pick, but not after an earlier pre-switch", () => {
    const picked = { ...claude, model: "claude-sonnet-5-5" };
    expect(
      preswitchMoveRefusal({ ...thread, modelSelection: picked }, [run("completed")]).refusal,
    ).toBe("A model was picked since the latest turn.");
    expect(
      preswitchMoveRefusal(
        {
          modelSelection: picked,
          limitPreswitchFrom: {
            modelSelection: claude,
            commandId: CommandId.make("limit-preswitch:t1:claudeAgent:2026-11-19T15:00:00.000Z"),
            resetAt: "2026-11-19T15:00:00.000Z",
          },
        },
        [run("completed")],
      ).refusal,
    ).toBeNull();
  });
});
