import { describe, expect, it } from "@effect/vitest";

import {
  afterHandoffRunEnded,
  closedWith,
  continuesFailedRun,
  inRunOrder,
  type ListedMessage,
  type ListedRun,
  movedOn,
  nextHandoffStep,
  owesResult,
} from "./handoffDelivery.ts";

const at = (second: number) => `2026-10-20T14:00:${String(second).padStart(2, "0")}.000Z`;
const run = (
  ordinal: number,
  status: string,
  started: number | null = ordinal,
  ended: number | null = null,
): ListedRun => ({
  runId: `run-${ordinal}`,
  ordinal,
  status,
  startedAt: started === null ? null : at(started),
  completedAt: ended === null ? null : at(ended),
});
const message = (
  runId: string,
  messageId: string,
  creationSource: string | null = "server",
): ListedMessage => ({ runId, messageId, creationSource, position: 0 });

describe("what a handed-off thread owes its launcher", () => {
  it("orders runs by when they ran, a queued one last", () => {
    // The second message was moved ahead of the first after both were queued.
    const order = inRunOrder([run(1, "completed", 5, 6), run(2, "completed", 2, 3), run(3, "queued", null)]);
    expect(order.map((entry) => entry.runId)).toEqual(["run-2", "run-1", "run-3"]);
  });

  it("reports the first run that completed, whatever was sent after it", () => {
    expect(
      nextHandoffStep([run(3, "running"), run(2, "completed", 2, 3), run(1, "interrupted", 1, 2)], []),
    ).toEqual({ kind: "report", runId: "run-2", status: "completed" });
  });

  it("waits for a run that is going, and has nothing for runs that were only stopped", () => {
    expect(nextHandoffStep([run(1, "cancelled", null, 1), run(2, "running")], [])).toEqual({
      kind: "follow",
      runId: "run-2",
      status: "running",
    });
    expect(
      nextHandoffStep([run(1, "interrupted", 1, 2), run(2, "rolled_back", 3, 4)], []),
    ).toEqual({ kind: "nothing" });
  });

  it("holds a failure that is last, and reports it once someone else's run follows", () => {
    expect(nextHandoffStep([run(1, "failed", 1, 2)], [])).toEqual({
      kind: "hold",
      runId: "run-1",
      completedAt: at(2),
    });
    expect(
      nextHandoffStep(
        [run(1, "failed", 1, 2), run(2, "running", 3)],
        [message("run-2", "message:typed", "web")],
      ),
    ).toEqual({ kind: "report", runId: "run-1", status: "failed" });
  });

  it("follows the target's own continuation of a failure, and reports what it ends as", () => {
    const fallback = message("run-2", "limit-fallback:thread:run-1");
    expect(nextHandoffStep([run(1, "failed", 1, 2), run(2, "running", 3)], [fallback])).toEqual({
      kind: "follow",
      runId: "run-2",
      status: "running",
      failedRunId: "run-1",
    });
    expect(
      nextHandoffStep([run(1, "failed", 1, 2), run(2, "completed", 3, 4)], [fallback]),
    ).toEqual({ kind: "report", runId: "run-2", status: "completed" });
    // A continuation that was only stopped leaves the failure as the result.
    expect(
      nextHandoffStep([run(1, "failed", 1, 2), run(2, "interrupted", 3, 4)], [fallback]),
    ).toEqual({ kind: "report", runId: "run-1", status: "failed" });
  });

  it("takes only a server message naming the failed run as its continuation", () => {
    expect(continuesFailedRun(message("r", "provider-fallback:t:hop-1:run-1"), ["run-1"])).toBe(true);
    // The resume after a limit reset names the run, then what makes the id unique.
    expect(continuesFailedRun(message("r", "limit-resume:t:run-1:1760000000:req-1"), ["run-1"])).toBe(
      true,
    );
    expect(continuesFailedRun(message("r", "limit-fallback:t:run-1", "web"), ["run-1"])).toBe(false);
    expect(continuesFailedRun(message("r", "limit-fallback:t:run-9"), ["run-1"])).toBe(false);
    expect(continuesFailedRun(message("r", "message:run-1"), ["run-1"])).toBe(false);
    expect(continuesFailedRun(undefined, ["run-1"])).toBe(false);
  });

  it("reads where a fenced thread runs now, and nothing for one that runs where asked", () => {
    const thread = {
      executionState: "fenced",
      executionMachineId: "env-onward",
      executionHistory: [
        { machine: "env-target", epoch: 2 },
        { machine: "env-onward", epoch: 3 },
      ],
    };
    expect(movedOn({ thread }, "env-target")).toEqual({ environmentId: "env-onward", epoch: 3 });
    expect(movedOn({ thread }, "env-onward")).toBeUndefined();
    expect(movedOn({ thread: { ...thread, executionState: "running" } }, "env-target")).toBeUndefined();
    expect(movedOn({ thread: { ...thread, executionHistory: [] } }, "env-target")).toEqual({
      environmentId: "env-onward",
      epoch: undefined,
    });
  });

  it("keeps a row owing until a result closes it, whoever saw the run end", () => {
    const handoff = { sourceThreadId: "thread-1", epoch: 2, hops: 1, failedRunId: "run-1" };
    expect(owesResult({ handoff })).toBe(true);
    expect(afterHandoffRunEnded({ handoff }, "interrupted")).toEqual({
      followedRunId: null,
      lastStatus: "interrupted",
      handoff: { ...handoff, awaiting: "run" },
    });
    const closed = closedWith(handoff, "run-2");
    expect(closed).toEqual({ sourceThreadId: "thread-1", epoch: 2, hops: 1, resultRunId: "run-2" });
    expect(owesResult({ handoff: closed })).toBe(false);
    expect(afterHandoffRunEnded({ handoff: closed }, "completed")).toBeUndefined();
    expect(afterHandoffRunEnded({}, "completed")).toBeUndefined();
  });
});
