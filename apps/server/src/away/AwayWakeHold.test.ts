/**
 * The wake hold keeps worker threads the intent named, not only coordinators
 * (1267 #13): the gate refuses them with their own text, and releasing them
 * leaves the coordinators held.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  AWAY_THREAD_HOLD_REFUSAL,
  awayHoldRefusal,
  COORDINATOR_AWAY_HOLD_REFUSAL,
  heldThread,
  releaseProjects,
  releaseThreads,
  type AwayWakeHoldRecord,
} from "./AwayWakeHold.ts";

const hold: AwayWakeHoldRecord = {
  version: 1,
  targetEnvironmentId: "ministorm",
  since: "2026-11-09T22:00:00.000Z",
  projects: [{ projectId: "p1", threadIds: ["project-coordinator:p1"] }],
  threads: ["t1", "t2"],
};

describe("the wake hold for worker threads (#13)", () => {
  it("refuses held workers with their own text, coordinators with theirs", () => {
    expect(awayHoldRefusal(hold, "project-coordinator:p1")).toBe(COORDINATOR_AWAY_HOLD_REFUSAL);
    expect(awayHoldRefusal(hold, "t1")).toBe(AWAY_THREAD_HOLD_REFUSAL);
    expect(awayHoldRefusal(hold, "t9")).toBeNull();
    expect(heldThread(hold, "t2")).toBe(true);
  });

  it("releases threads and projects apart; null only once nothing is held", () => {
    const noThreads = releaseThreads(hold, ["t1", "t2"]);
    expect(noThreads).toMatchObject({ projects: hold.projects });
    expect(noThreads?.threads).toBeUndefined();
    expect(releaseProjects(noThreads, ["p1"])).toBeNull();
    const onlyThreads = releaseProjects(hold, ["p1"]);
    expect(onlyThreads).toMatchObject({ projects: [], threads: ["t1", "t2"] });
    expect(releaseThreads(onlyThreads, ["t1"])).toMatchObject({ threads: ["t2"] });
    expect(releaseThreads(onlyThreads, ["t1", "t2"])).toBeNull();
  });
});
