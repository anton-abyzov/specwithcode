import { ProviderInstanceId, RunId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  PRESWITCH_TURN_STARTED,
  PRESWITCH_TURN_UNFINISHED,
  preswitchMoveRefusal,
  preswitchWindowHeld,
} from "./limitPreswitchGuard.ts";

// 1089: the orchestrator judges a pre-switch again when it lands, so a turn
// that started after the sweep's checks keeps the thread where it is.
const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const at = Date.parse("2026-11-19T12:00:00.000Z");
const run = (status: string, offset = 0) =>
  ({
    id: RunId.make(`r-${status}-${offset}`),
    threadId: ThreadId.make("t1"),
    ordinal: 1 + offset,
    providerInstanceId: claude.instanceId,
    modelSelection: claude,
    status,
    requestedAt: DateTime.makeUnsafe(at - 120_000 + offset),
    startedAt: DateTime.makeUnsafe(at - 120_000 + offset),
    completedAt: status === "running" ? null : DateTime.makeUnsafe(at - 60_000 + offset),
  }) as never;

describe("preswitchMoveRefusal", () => {
  it("lets the move stand after a completed turn, or before any turn", () => {
    expect(preswitchMoveRefusal([run("completed")]).refusal).toBeNull();
    expect(preswitchMoveRefusal([]).refusal).toBeNull();
  });

  it("refuses once a turn started or the latest one did not complete", () => {
    expect(preswitchMoveRefusal([run("completed"), run("running", 1)]).refusal).toBe(
      PRESWITCH_TURN_STARTED,
    );
    // An ended turn is a lasting refusal, recorded so the sweep does not
    // send the same move every 30 seconds; only a running one frees the id.
    expect(preswitchMoveRefusal([run("interrupted")]).refusal).toBe(PRESWITCH_TURN_UNFINISHED);
    expect(preswitchMoveRefusal([run("failed")]).refusal).toBe(PRESWITCH_TURN_UNFINISHED);
    expect(preswitchMoveRefusal([run("completed"), run("starting", 1)]).refusal).toBe(
      PRESWITCH_TURN_STARTED,
    );
    // A queued send starts on the model it was sent with: the move waits for it.
    expect(preswitchMoveRefusal([run("completed"), run("queued", 1)]).refusal).toBe(
      PRESWITCH_TURN_STARTED,
    );
  });
});

describe("preswitchWindowHeld", () => {
  const reset = "2026-11-19T15:00:00.000Z";
  const sent = [`limit-preswitch:t1:claudeAgent:${reset}`, "limit-fallback:t1:r1"];
  it("holds while the window a move went out for has not reset", () => {
    expect(preswitchWindowHeld(sent, "t1", "claudeAgent", at)).toBe(true);
    expect(preswitchWindowHeld(sent, "t1", "claudeAgent", Date.parse(reset))).toBe(false);
    expect(preswitchWindowHeld(sent, "t2", "claudeAgent", at)).toBe(false);
    expect(preswitchWindowHeld(sent, "t1", "codex", at)).toBe(false);
    const open = ["limit-preswitch:t1:claudeAgent:open"];
    // A window with no reset holds until the sweep reads it under the threshold.
    expect(preswitchWindowHeld(open, "t1", "claudeAgent", at)).toBe(true);
  });
});
