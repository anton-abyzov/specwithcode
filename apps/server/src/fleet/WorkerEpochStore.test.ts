import { describe, expect, it } from "@effect/vitest";

import { applyEpochClaim, epochAdmits, type WorkerEpochRecord } from "./WorkerEpochStore.ts";

/** M1 took over EasyChamp at epoch 5 and claimed it on this worker machine. */
const claimed: WorkerEpochRecord = {
  logicalProjectId: "logical:easychamp",
  epoch: 5,
  claimedBy: "env-m1",
  claimedAt: "2026-10-26T14:30:00.000Z",
};

describe("epochAdmits", () => {
  it("admits anyone before a claim", () => {
    expect(epochAdmits(undefined, undefined, "env-m4")).toBe(true);
    expect(epochAdmits(undefined, 0, "env-m4")).toBe(true);
  });

  it("admits the claimed epoch only from the machine that claimed it", () => {
    expect(epochAdmits(claimed, 5, "env-m1")).toBe(true);
    // M4 also reached epoch 5 by itself: it does not steer beside M1.
    expect(epochAdmits(claimed, 5, "env-m4")).toBe(false);
  });

  it("admits a higher epoch from any machine", () => {
    expect(epochAdmits(claimed, 6, "env-m4")).toBe(true);
    expect(epochAdmits(claimed, 6, "env-m1")).toBe(true);
  });

  it("refuses a lower epoch, or none, even from the claimant", () => {
    expect(epochAdmits(claimed, 4, "env-m4")).toBe(false);
    expect(epochAdmits(claimed, 4, "env-m1")).toBe(false);
    expect(epochAdmits(claimed, undefined, "env-m1")).toBe(false);
  });

  it("agrees with the claim path: the claim that stands is the one admitted", () => {
    const first = applyEpochClaim(undefined, {
      logicalProjectId: claimed.logicalProjectId,
      epoch: 5,
      by: "env-m1",
    });
    const record = { ...first.next!, claimedAt: claimed.claimedAt };
    const rival = applyEpochClaim(record, {
      logicalProjectId: claimed.logicalProjectId,
      epoch: 5,
      by: "env-m4",
    });
    expect(rival).toMatchObject({ accepted: false, next: undefined });
    expect(epochAdmits(record, 5, "env-m1")).toBe(true);
    expect(epochAdmits(record, 5, "env-m4")).toBe(false);
  });
});
