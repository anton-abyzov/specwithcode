import { describe, expect, it } from "vite-plus/test";

import { describeOldAppVersionsCleanup } from "./oldAppVersions";

describe("describeOldAppVersionsCleanup", () => {
  it("says how much a cleanup freed and what it kept", () => {
    expect(
      describeOldAppVersionsCleanup({ removedCount: 112, freedBytes: 47e9, failedCount: 0 }),
    ).toBe("Removed 112 old app versions and freed 47 GB.");
    expect(
      describeOldAppVersionsCleanup({ removedCount: 1, freedBytes: 4.4e8, failedCount: 1 }),
    ).toBe("Removed 1 old app version and freed 440 MB. Kept 1 version still in use.");
  });

  it("explains why nothing was removed", () => {
    expect(
      describeOldAppVersionsCleanup({
        removedCount: 0,
        freedBytes: 0,
        failedCount: 0,
        skipped: "update-pending",
      }),
    ).toBe("An update is in progress. Try again when it finishes.");
    expect(describeOldAppVersionsCleanup({ removedCount: 0, freedBytes: 0, failedCount: 0 })).toBe(
      "No old app versions to remove.",
    );
  });
});
