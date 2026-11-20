import { EnvironmentId, type ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { reviewBoundary } from "./CoordinatorLease.ts";
import {
  emptyLeaseRecord,
  withoutPendingRelease,
  withPendingRelease,
} from "./CoordinatorLeaseStore.ts";

describe("pending release helpers", () => {
  const member = (environmentId: string) => ({
    environmentId: EnvironmentId.make(environmentId),
    projectId: `easychamp-${environmentId}` as ProjectId,
    coordinatorThreadId: `project-coordinator:easychamp-${environmentId}` as never,
  });
  const entry = (environmentId: string, epoch: number) => ({
    standby: member(environmentId),
    epoch,
    logicalProjectId: "logical:easychamp",
    since: "2026-11-03T10:00:00.000Z",
  });
  const at = "2026-11-03T10:05:00.000Z";

  it("owes a release once, starting a record when there is none", () => {
    const first = withPendingRelease(undefined, entry("m2", 4), "easychamp-m1", at);
    expect(first).toMatchObject({
      projectId: "easychamp-m1",
      logicalProjectId: "logical:easychamp",
      target: null,
      pendingReleases: [entry("m2", 4)],
    });
    expect(withPendingRelease(first, entry("m2", 4), "easychamp-m1", at)).toBe(first);
    expect(
      withPendingRelease(first, entry("m2", 5), "easychamp-m1", at).pendingReleases,
    ).toHaveLength(2);
  });

  it("removes only the named release, and the record once nothing is left", () => {
    const base = emptyLeaseRecord("easychamp-m1", "logical:easychamp", at);
    const two = { ...base, pendingReleases: [entry("m2", 4), entry("m3", 4)] };
    expect(withoutPendingRelease(undefined, member("m2"), 4)).toBeUndefined();
    expect(withoutPendingRelease(two, member("m2"), 5)).toBeUndefined();
    const one = withoutPendingRelease(two, member("m2"), 4);
    expect(one).toMatchObject({ pendingReleases: [entry("m3", 4)] });
    expect(withoutPendingRelease(one!, member("m3"), 4)).toBeNull();
  });
});

describe("reviewBoundary", () => {
  it("moves the standby's time into this clock and never past the last confirmed lease", () => {
    const sent = Date.parse("2026-10-26T14:00:00.000Z");
    // The standby's clock runs 2 minutes ahead.
    const at = reviewBoundary({
      takenOverAt: "2026-10-26T14:12:00.000Z",
      standbyReceivedAt: "2026-10-26T14:02:00.500Z",
      sentAtMs: sent,
      answeredAtMs: sent + 1_000,
      lastSuccessfulLeaseAt: null,
    });
    expect(at).toBe(Date.parse("2026-10-26T14:10:00.000Z"));
    expect(
      reviewBoundary({
        takenOverAt: "2026-10-26T14:12:00.000Z",
        standbyReceivedAt: "2026-10-26T14:02:00.500Z",
        sentAtMs: sent,
        answeredAtMs: sent + 1_000,
        lastSuccessfulLeaseAt: "2026-10-26T13:55:00.000Z",
      }),
    ).toBe(Date.parse("2026-10-26T13:55:00.000Z"));
  });
});
