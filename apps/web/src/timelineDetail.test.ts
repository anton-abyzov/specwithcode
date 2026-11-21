import { describe, expect, it } from "vite-plus/test";

import {
  MAX_THREAD_TIMELINE_DETAILS,
  nextThreadTimelineDetails,
  nextTimelineDetail,
  planTimelineDetailCycle,
  resolveTimelineDetail,
  threadHasOwnTimelineDetail,
  TIMELINE_DETAIL_DESCRIPTIONS,
  TIMELINE_DETAIL_LABELS,
  TIMELINE_DETAIL_LEVELS,
  type TimelineDetail,
} from "./timelineDetail";

describe("timeline detail levels", () => {
  it("cycles concise, normal, verbose and back to concise", () => {
    expect(nextTimelineDetail("concise")).toBe("normal");
    expect(nextTimelineDetail("normal")).toBe("verbose");
    expect(nextTimelineDetail("verbose")).toBe("concise");
  });

  it("labels and describes every level", () => {
    expect(TIMELINE_DETAIL_LEVELS).toEqual(["concise", "normal", "verbose"]);
    for (const level of TIMELINE_DETAIL_LEVELS) {
      expect(TIMELINE_DETAIL_LABELS[level]).toMatch(/^[A-Z]/);
      expect(TIMELINE_DETAIL_DESCRIPTIONS[level].length).toBeGreaterThan(0);
    }
  });
});

describe("per-thread timeline detail", () => {
  const settings = {
    timelineDetail: "concise" as const,
    threadTimelineDetail: { "env:verbose-thread": "verbose" as const },
  };

  it("uses the thread's own level and the default for every other thread", () => {
    expect(resolveTimelineDetail(settings, "env:verbose-thread")).toBe("verbose");
    expect(resolveTimelineDetail(settings, "env:other")).toBe("concise");
    expect(resolveTimelineDetail(settings, null)).toBe("concise");
    expect(threadHasOwnTimelineDetail(settings, "env:verbose-thread")).toBe(true);
    expect(threadHasOwnTimelineDetail(settings, "env:other")).toBe(false);
  });

  it("follows a new default in threads without their own level", () => {
    const changed = { ...settings, timelineDetail: "normal" as const };
    expect(resolveTimelineDetail(changed, "env:other")).toBe("normal");
    expect(resolveTimelineDetail(changed, "env:verbose-thread")).toBe("verbose");
  });

  it("sets, moves to newest and clears a thread's level", () => {
    const set = nextThreadTimelineDetails({ a: "verbose", b: "normal" }, "a", "concise");
    expect(Object.entries(set)).toEqual([
      ["b", "normal"],
      ["a", "concise"],
    ]);
    expect(nextThreadTimelineDetails(set, "a", null)).toEqual({ b: "normal" });
  });

  it("forgets the oldest choices past the limit", () => {
    let current: Record<string, TimelineDetail> = {};
    for (let index = 0; index <= MAX_THREAD_TIMELINE_DETAILS; index += 1) {
      current = nextThreadTimelineDetails(current, `env:${index}`, "verbose");
    }
    expect(Object.keys(current)).toHaveLength(MAX_THREAD_TIMELINE_DETAILS);
    expect(current["env:0"]).toBeUndefined();
    expect(current[`env:${MAX_THREAD_TIMELINE_DETAILS}`]).toBe("verbose");
  });
});

describe("the shortcut cycles what the conversations on screen show", () => {
  const settings = {
    timelineDetail: "normal" as const,
    threadTimelineDetail: { "env:own": "concise" as const, "env:elsewhere": "verbose" as const },
  };

  it("moves the default when no thread is on screen", () => {
    expect(planTimelineDetailCycle(settings, [])).toEqual({
      timelineDetail: "verbose",
      title: "Show: Everything",
    });
  });

  it("moves the default for a thread that follows it", () => {
    expect(planTimelineDetailCycle(settings, ["env:follows"])).toEqual({
      timelineDetail: "verbose",
      title: "Show: Everything",
    });
  });

  it("moves a thread's own level and leaves the default and other threads alone", () => {
    const plan = planTimelineDetailCycle(settings, ["env:own"]);
    expect(plan.timelineDetail).toBeUndefined();
    expect(plan.threadTimelineDetail).toEqual({ "env:elsewhere": "verbose", "env:own": "normal" });
    expect(plan.title).toBe("Show in this thread: Folded steps");
  });

  it("moves both when a coordinator follows the default beside a thread with its own level", () => {
    const plan = planTimelineDetailCycle(settings, ["env:coordinator", "env:own", "env:own"]);
    expect(plan.timelineDetail).toBe("verbose");
    expect(plan.threadTimelineDetail?.["env:own"]).toBe("normal");
    expect(plan.title).toBe("Show: Everything · this thread: Folded steps");
  });
});
