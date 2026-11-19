import { describe, expect, it } from "@effect/vitest";

import {
  afterHandoffRunEnded,
  closedWith,
  continuesFailedRun,
  firstRunId,
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
  it("names a thread's first run as every release does", () => {
    expect(firstRunId("handoff:abc")).toBe("run:thread:handoff%3Aabc:ordinal:1");
  });

  it("reports the owed run's result, whatever started or finished around it", () => {
    // The second message was moved ahead of the first and finished first.
    const runs = [run(1, "completed", 5, 6), run(2, "failed", 2, 3), run(3, "running", 7)];
    expect(nextHandoffStep(runs, [], "run-1")).toEqual({
      kind: "report",
      runId: "run-1",
      status: "completed",
    });
    // Still queued while a later message ran: it is waited for, not replaced.
    expect(nextHandoffStep([run(1, "queued", null), run(2, "completed", 2, 3)], [], "run-1")).toEqual({
      kind: "follow",
      runId: "run-1",
      status: "queued",
      pin: "run-1",
    });
  });

  it("gives the same answer when the owed run is known by its status alone", () => {
    const unlisted: ListedRun = { ...run(1, "completed", null), unlisted: true };
    expect(nextHandoffStep([unlisted, run(2, "failed", 2, 3)], [], "run-1")).toEqual({
      kind: "report",
      runId: "run-1",
      status: "completed",
    });
  });

  it("has nothing for a thread without the owed run, or with runs that were only stopped", () => {
    expect(nextHandoffStep([], [], "run-1")).toEqual({ kind: "nothing" });
    expect(
      nextHandoffStep([run(1, "interrupted", 1, 2), run(2, "rolled_back", 3, 4)], [], "run-1"),
    ).toEqual({ kind: "nothing" });
    // A message still queued has not started: nothing has taken the stopped run's place yet.
    expect(nextHandoffStep([run(1, "cancelled", null, 1), run(2, "queued", null)], [], "run-1")).toEqual(
      { kind: "nothing" },
    );
  });

  it("lets the next run to start take the place of an owed run that was only stopped", () => {
    expect(nextHandoffStep([run(1, "cancelled", null, 1), run(2, "running")], [], "run-1")).toEqual({
      kind: "follow",
      runId: "run-2",
      status: "running",
      pin: "run-2",
    });
    // Two started: the listed start times say which was first, not the ordinals.
    expect(
      nextHandoffStep(
        [run(1, "interrupted", 1, 2), run(2, "completed", 6, 7), run(3, "failed", 3, 4)],
        [],
        "run-1",
      ),
    ).toEqual({ kind: "hold", runId: "run-3", pin: "run-3", completedAt: at(4) });
  });

  it("does not guess when two runs started after a stopped one and a start time is unknown", () => {
    const unlisted: ListedRun = { ...run(2, "completed", null), unlisted: true };
    expect(
      nextHandoffStep([run(1, "interrupted", 1, 2), unlisted, run(3, "completed", 3, 4)], [], "run-1"),
    ).toEqual({ kind: "unsure" });
    // One of them still queued has not started, so the other is the next run.
    expect(
      nextHandoffStep(
        [run(1, "interrupted", 1, 2), unlisted, { ...run(3, "queued", null), unlisted: true }],
        [],
        "run-1",
      ),
    ).toEqual({ kind: "report", runId: "run-2", status: "completed" });
  });

  it("holds a failure, whoever sent a message after it", () => {
    expect(nextHandoffStep([run(1, "failed", 1, 2)], [], "run-1")).toEqual({
      kind: "hold",
      runId: "run-1",
      pin: "run-1",
      completedAt: at(2),
    });
    // Someone's own later message is not a continuation: the failure stays the result.
    expect(
      nextHandoffStep(
        [run(1, "failed", 1, 2), run(2, "completed", 3, 4)],
        [message("run-2", "message:typed", "web")],
        "run-1",
      ),
    ).toEqual({ kind: "hold", runId: "run-1", pin: "run-1", completedAt: at(2) });
  });

  it("follows the target's own continuation of a failure, and reports what it ends as", () => {
    const fallback = message("run-2", "limit-fallback:thread:run-1");
    expect(
      nextHandoffStep([run(1, "failed", 1, 2), run(2, "running", 3)], [fallback], "run-1"),
    ).toEqual({
      kind: "follow",
      runId: "run-2",
      status: "running",
      pin: "run-1",
      failedRunId: "run-1",
    });
    expect(
      nextHandoffStep([run(1, "failed", 1, 2), run(2, "completed", 3, 4)], [fallback], "run-1"),
    ).toEqual({ kind: "report", runId: "run-2", status: "completed" });
    // A continuation that was only stopped leaves the failure as the result.
    expect(
      nextHandoffStep([run(1, "failed", 1, 2), run(2, "interrupted", 3, 4)], [fallback], "run-1"),
    ).toEqual({ kind: "report", runId: "run-1", status: "failed" });
    // A continuation that failed too is held, and its own continuation is followed.
    const again = message("run-3", "provider-fallback:thread:hop-1:run-2");
    expect(
      nextHandoffStep(
        [run(1, "failed", 1, 2), run(2, "failed", 3, 4), run(3, "completed", 5, 6)],
        [fallback, again],
        "run-1",
      ),
    ).toEqual({ kind: "report", runId: "run-3", status: "completed" });
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

  it("reads where a fenced thread runs now from the stretch that is open, and nothing for one that runs where asked", () => {
    const thread = {
      executionState: "fenced",
      executionMachineId: "env-onward",
      executionHistory: [
        { machine: "env-target", epoch: 2, to: "2026-10-20T14:00:00.000Z" },
        { machine: "env-onward", epoch: 3, to: null },
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

  it("takes no epoch from an earlier visit while the entry of this move is not written", () => {
    // Fenced and handed to onward again, but the history still ends on the machine asked.
    const thread = {
      executionState: "fenced",
      executionMachineId: "env-onward",
      executionHistory: [
        { machine: "env-onward", epoch: 2, to: "2026-10-20T14:00:00.000Z" },
        { machine: "env-target", epoch: 3, to: null },
      ],
    };
    expect(movedOn({ thread }, "env-target")).toEqual({
      environmentId: "env-onward",
      epoch: undefined,
    });
    // A closed stretch for that machine is a visit that ended, not where it runs now.
    const closed = [...thread.executionHistory, { machine: "env-onward", epoch: 4, to: "x" }];
    expect(movedOn({ thread: { ...thread, executionHistory: closed } }, "env-target")).toEqual({
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
