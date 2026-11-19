import { ProviderInstanceId, RunId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { preswitchMoveRefusal, sameModelSelection } from "./limitPreswitchGuard.ts";

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
    expect(preswitchMoveRefusal([run("completed"), run("running", 1)]).refusal).not.toBeNull();
    expect(preswitchMoveRefusal([run("interrupted")]).refusal).not.toBeNull();
    expect(preswitchMoveRefusal([run("failed")]).refusal).not.toBeNull();
  });
});

describe("sameModelSelection", () => {
  it("tells another model, instance or option apart", () => {
    expect(sameModelSelection(claude, { ...claude })).toBe(true);
    expect(sameModelSelection(claude, { ...claude, model: "claude-sonnet-5-5" })).toBe(false);
    expect(
      sameModelSelection(claude, { ...claude, instanceId: ProviderInstanceId.make("claude-2") }),
    ).toBe(false);
    expect(
      sameModelSelection(claude, { ...claude, options: [{ id: "effort", value: "high" }] } as never),
    ).toBe(false);
  });
});
