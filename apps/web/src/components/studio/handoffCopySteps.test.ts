import { describe, expect, it } from "vite-plus/test";
import { busyThreadsOf, transferRefusal } from "./handoffCopySteps";
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

  it("carries the threads a busy source named", () => {
    const busy = {
      total: 2,
      threads: [
        { threadId: "a", title: "A", projectId: "p", reason: "waiting_for_answer" },
        { threadId: "b", title: "B", projectId: "p", reason: "pending_approval" },
      ],
    };
    const refused = transferRefusal(
      Object.assign(new Error("busy"), { code: "busy", busy }),
      false,
      "M3",
      "M4",
    );
    expect(refused).toMatchObject({
      recovery: false,
      copyAgain: null,
      busy: { on: "source", busy },
    });
    expect(refused.notice).toBe(
      "2 threads are still working or waiting for you on M4, so the coordinator stayed there. Answer or close each question, or stop the work, then try again. A move waits for them because it would drop a question still waiting for you.",
    );
  });
});

describe("a busy destination after the source published", () => {
  it("names the destination's threads and keeps the recovery pointer", () => {
    const busy = {
      total: 3,
      threads: [{ threadId: "q", title: "Q", projectId: "p", reason: "waiting_for_sign_in" }],
    };
    const refused = transferRefusal(
      Object.assign(new Error("busy"), { code: "busy", busy }),
      true,
      "ministorm",
      "M4",
    );
    expect(refused).toMatchObject({
      recovery: true,
      copyAgain: false,
      busy: { on: "destination", busy },
    });
    expect(refused.notice).toBe(
      "3 threads are still working or waiting for you on ministorm, so the coordinator hasn't started there yet. Answer or close each question, or stop the work, then try again. A move waits for them because it would drop a question still waiting for you.",
    );
  });
  it("keeps the generic notice when the destination named no threads", () => {
    const refused = transferRefusal(
      Object.assign(new Error("Finish active work."), { code: "busy" }),
      true,
      "ministorm",
      "M4",
    );
    expect(refused).toMatchObject({ recovery: true, copyAgain: false });
    expect(refused).not.toHaveProperty("busy");
    expect(refused.notice).toBe("Moving the coordinator didn't finish: Finish active work.");
  });
});

describe("busyThreadsOf", () => {
  const thread = { threadId: "a", title: "A", projectId: "p", reason: "running" };
  it("reads only well-formed rows and never counts fewer than it lists", () => {
    expect(busyThreadsOf({ busy: { total: 0, threads: [thread, { threadId: 1 }] } })).toEqual({
      total: 1,
      threads: [thread],
    });
  });
  it("ignores a refusal from an older machine or an unknown reason", () => {
    for (const cause of [
      null,
      "busy",
      { busy: null },
      { busy: { total: 1 } },
      { busy: { total: 1, threads: [{ ...thread, reason: "later_reason" }] } },
    ])
      expect(busyThreadsOf(cause)).toBeNull();
  });
});
