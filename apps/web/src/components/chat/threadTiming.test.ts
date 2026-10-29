import { describe, expect, it } from "vite-plus/test";
import { deriveThreadTiming, threadTimingBackground, type ThreadTimingRun } from "./threadTiming";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 12, minute)).toISOString();
const turn = (
  id: string,
  start: number,
  end: number | null,
  status = "completed",
): ThreadTimingRun => ({
  id,
  status,
  startedAt: at(start),
  completedAt: end === null ? null : at(end),
});
const view = (
  run: ThreadTimingRun | null,
  recordedRuns: readonly ThreadTimingRun[] = [],
  extra: object = {},
) =>
  deriveThreadTiming({
    run,
    recordedRuns,
    nowMs: Date.parse(at(30)),
    historyComplete: true,
    ...extra,
  });
describe("recorded turn timing", () => {
  it("shows pending background work only for a settled active thread", () => {
    const tasks = [{ taskId: "watch", kind: "workflow" as const }];
    expect(threadTimingBackground(tasks, false, true)).toEqual({
      label: "Waiting on a workflow",
      waiting: true,
      kind: "workflow",
    });
    expect(threadTimingBackground(tasks, true, true)).toBeNull();
    expect(threadTimingBackground(tasks, false, false)).toBeNull();
    expect(threadTimingBackground([], false, true)).toBeNull();
  });
  it("accepts explicitly absent optional fields from runtime records", () => {
    expect(
      deriveThreadTiming({
        run: { ...turn("queued", 0, null, "queued"), queueHeld: undefined },
        recordedRuns: undefined,
        nowMs: Date.parse(at(30)),
      }),
    ).toMatchObject({ label: "Queued", elapsedMs: null });
  });
  it("names the latest follow-up separately from recorded cumulative elapsed", () => {
    const old = turn("one", 0, 5),
      followup = turn("two", 20, 21);
    expect(view(followup, [old, followup])).toMatchObject({
      label: "Last turn 1m",
      elapsedMs: 60_000,
      recordedMs: 6 * 60_000,
      recordedCount: 2,
    });
  });
  it("does not count the gap, idle watch time or provider-session age", () => {
    const done = turn("one", 0, 5);
    expect(
      view(done, [done], {
        background: { kind: "monitor", label: "Waiting on PR checks", waiting: true },
      }),
    ).toMatchObject({ label: "Watching", elapsedMs: 5 * 60_000, recordedMs: 5 * 60_000 });
  });
  it("updates the current span when a steer stays in the same run, then a follow-up/resume adds a run", () => {
    const live = turn("same", 20, null, "running");
    expect(view(live, [live], { nowMs: Date.parse(at(22)) })).toMatchObject({
      elapsedMs: 2 * 60_000,
      recordedCount: 1,
    });
    expect(view(live, [live])).toMatchObject({ elapsedMs: 10 * 60_000, recordedCount: 1 });
    const stopped = turn("same", 20, 23, "interrupted"),
      resumed = turn("resume", 28, null, "running");
    expect(view(resumed, [stopped, resumed])).toMatchObject({
      recordedMs: 5 * 60_000,
      recordedCount: 2,
    });
  });
  it("deduplicates run IDs and counts overlapping recorded intervals once", () => {
    const a = turn("a", 0, 5),
      b = turn("b", 3, 7);
    expect(view(b, [a, a, b])).toMatchObject({ recordedMs: 7 * 60_000, timedCount: 2 });
  });
  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"])(
    "never extends an unknown %s end to now",
    (status) => {
      expect(view(turn("x", 0, null, status))).toMatchObject({
        elapsedMs: null,
        recordedMs: null,
        timedCount: 0,
      });
    },
  );
  it("shows queued/held requests without calling their waiting time work", () => {
    const queued = {
      id: "q",
      status: "queued",
      queueHeld: true,
      startedAt: null,
      completedAt: null,
    };
    expect(view(queued, [turn("one", 0, 5), queued])).toMatchObject({
      label: "Queue held",
      elapsedMs: null,
      recordedMs: 5 * 60_000,
      timedCount: 1,
      recordedCount: 2,
    });
  });
  it("does not count a retained queued start timestamp", () => {
    expect(view(turn("q", 0, null, "queued"))).toMatchObject({
      label: "Queued",
      elapsedMs: null,
      recordedMs: null,
    });
  });
  it("names active user/tool waits and keeps elapsed explicitly separate from active work", () => {
    const active = turn("active", 20, null, "waiting");
    expect(view(active, [], { awaitingPerson: "answer" })).toMatchObject({
      label: "Waiting on you",
      elapsedMs: 10 * 60_000,
    });
    expect(
      view(active, [], {
        health: { state: "waiting", label: "Running tests", idleMs: 0, waitingMs: 1 },
      }),
    ).toMatchObject({ label: "Waiting · 10m elapsed", statusDetail: "Running tests" });
  });
  it("reports partial loaded history, invalid stamps and future clock skew without invented values", () => {
    const invalid = { ...turn("x", 0, 5), startedAt: "bad" };
    expect(view(invalid, [invalid], { historyComplete: false })).toMatchObject({
      partial: true,
      elapsedMs: null,
      recordedMs: null,
      timedCount: 0,
    });
    expect(view(turn("future", 40, null, "running"))).toMatchObject({
      elapsedMs: null,
      recordedMs: null,
    });
  });
  it("does not infer live work from a provider session or missing run", () =>
    expect(view(null)).toBeNull());
});
