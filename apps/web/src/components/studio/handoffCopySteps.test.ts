import { describe, expect, it } from "vite-plus/test";
import { transferRefusal } from "./handoffCopySteps";
import { DestinationContextPreviewError } from "./useCoordinatorTransfer";

const changes = {
  digest: "a".repeat(64),
  total: 3,
  truncated: false,
  acceptable: true,
  rows: [{ path: ".specweave/ledger.jsonl", kind: "changed" as const, size: 10 }],
};
const refusal = (extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("Files changed on the source after the copy."), {
    code: "source_changed",
    ...extra,
  });

describe("transferRefusal", () => {
  it("carries the source's change list and counts its paths", () => {
    expect(transferRefusal(refusal({ changes }), false, "M3", "M4")).toEqual({
      notice: "3 paths changed on M4 after copying.",
      recovery: false,
      copyAgain: true,
      changes,
    });
  });

  it("says one path in the singular", () => {
    const one = { ...changes, total: 1 };
    expect(transferRefusal(refusal({ changes: one }), false, "M3", "M4").notice).toBe(
      "1 path changed on M4 after copying.",
    );
  });

  it("keeps the old notice for an older source without a list", () => {
    const refused = transferRefusal(refusal(), false, "M3", "M4");
    expect(refused).toEqual({
      notice: "M4 changed after copying. Copy again before moving the coordinator.",
      recovery: false,
      copyAgain: true,
    });
    expect(refused).not.toHaveProperty("changes");
  });

  it("ignores a list that is empty or not shaped like one", () => {
    for (const bad of [{ ...changes, total: 0, rows: [] }, { digest: 1 }, "changes"]) {
      const refused = transferRefusal(refusal({ changes: bad }), false, "M3", "M4");
      expect(refused).not.toHaveProperty("changes");
      expect(refused.notice).toContain("Copy again before moving the coordinator");
    }
  });

  it("keeps recovery once context was published, list or not", () => {
    const refused = transferRefusal(refusal({ changes }), true, "M3", "M4");
    expect(refused.recovery).toBe(true);
    expect(refused).not.toHaveProperty("changes");
  });

  it("leaves busy and destination refusals as they were", () => {
    expect(
      transferRefusal(Object.assign(new Error("busy"), { code: "busy" }), false, "M3", "M4"),
    ).toMatchObject({ recovery: false, copyAgain: null });
    expect(
      transferRefusal(new DestinationContextPreviewError(new Error("No.")), false, "M3", "M4"),
    ).toMatchObject({ recovery: false, copyAgain: null });
  });
});
