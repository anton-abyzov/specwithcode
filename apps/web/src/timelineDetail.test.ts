import { describe, expect, it } from "vite-plus/test";

import {
  nextTimelineDetail,
  TIMELINE_DETAIL_DESCRIPTIONS,
  TIMELINE_DETAIL_LABELS,
  TIMELINE_DETAIL_LEVELS,
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
