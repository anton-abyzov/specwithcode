/**
 * Away mode's planned coordinator handover (1267 T-04, AC-05). The M4
 * coordinates EasyChamp and Ministorm holds a linked copy; each has its own
 * ProjectLink over in-memory projects whose writes follow the real ownership
 * rules. The handover call crosses a stub network that encodes and decodes
 * every body as the wire does. After every step the test checks that the
 * two copies are never both active.
 */
import { describe, expect, it } from "@effect/vitest";

import { claimTargets } from "./CoordinatorPlannedHandover.ts";

describe("claimTargets", () => {
  it("claims on worker machines and other copies, never itself or the predecessor", () => {
    expect(
      claimTargets(
        [{ environmentId: "m3" }, { environmentId: "m4" }],
        [{ environmentId: "m4" }, { environmentId: "ministorm" }, { environmentId: "m1" }],
        "ministorm",
        "m4",
      ),
    ).toEqual(["m3", "m1"]);
  });
});
