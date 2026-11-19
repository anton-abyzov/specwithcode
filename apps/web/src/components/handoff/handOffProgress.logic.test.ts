import {
  HandoffModeEmptyInput,
  HandoffModeSnapshot,
  HandoffResumeFencedInput,
  type EnvironmentId,
  type HandoffTransferBatch,
  type HandoffTransferRecord,
  type HandoffTransferState,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { englishPhrase } from "../../i18n";
import {
  progressGroups,
  progressNotes,
  progressReason,
  progressRow,
  progressSummary,
  progressSummaryText,
  progressTitle,
  rowStateOf,
  threadTransfer,
  trackOutView,
} from "./handOffProgress.logic";

const encodeResume = Schema.encodeSync(HandoffResumeFencedInput);
const decodeResume = Schema.decodeUnknownSync(HandoffResumeFencedInput);
const decodeResume383 = Schema.decodeUnknownSync(HandoffModeEmptyInput);

const SOURCE = "env-source" as EnvironmentId;
const TARGET = "env-target" as EnvironmentId;
const PROJECT = "project-atlas" as ProjectId;
const names = { source: "Laptop", target: "Desk" };

let counter = 0;
function record(
  state: HandoffTransferState,
  patch: Partial<HandoffTransferRecord> = {},
): HandoffTransferRecord {
  counter += 1;
  const at = `2026-11-19T07:${String(counter).padStart(2, "0")}:00.000Z`;
  return {
    operationId: `op-${counter}`,
    batchId: "batch-1",
    lineage: {
      sourceEnvironmentId: SOURCE,
      sourceThreadId: `thread-${counter}` as ThreadId,
      epoch: 1,
    },
    projectId: PROJECT,
    targetEnvironmentId: TARGET,
    sequence: 3,
    disposition: "resume",
    state,
    legacy: false,
    candidates: [],
    trigger: { kind: "manual" },
    reason: "manual",
    modelSelection: null,
    receipt: null,
    detail: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
    ...patch,
  };
}

const receipt = (threadId: string) => ({
  threadId: threadId as ThreadId,
  machineLabel: "Desk",
  modelSelection: null,
  resumed: true,
  notice: null,
});

describe("rowStateOf", () => {
  it("maps each record state to one row", () => {
    expect(rowStateOf("pending")).toBe("pending");
    expect(rowStateOf("held")).toBe("held");
    expect(rowStateOf("sent")).toBe("waiting");
    expect(rowStateOf("accepted")).toBe("waiting");
    expect(rowStateOf("unknown")).toBe("waiting");
    expect(rowStateOf("resumed")).toBe("resumed");
    expect(rowStateOf("ready")).toBe("ready");
    expect(rowStateOf("stayed")).toBe("stayed");
    expect(rowStateOf("failed")).toBe("failed");
  });
});

describe("progressRow", () => {
  it("offers Resume here only for a hold that was never sent", () => {
    expect(progressRow(record("held")).action).toBe("resume-here");
    expect(progressRow(record("pending")).action).toBe("cancel");
    for (const state of ["sent", "accepted", "unknown"] as const)
      expect(progressRow(record(state)).action, state).toBe("wait");
  });

  it("opens an arrived thread on its machine and retries a refused one", () => {
    const arrived = progressRow(record("resumed", { receipt: receipt("thread-there") }));
    expect(arrived.action).toBe("open");
    expect(arrived.continuedThreadId).toBe("thread-there");
    expect(progressRow(record("ready", { receipt: receipt("thread-idle") })).action).toBe("open");
    expect(progressRow(record("failed")).action).toBe("try-again");
    expect(progressRow(record("stayed")).action).toBeNull();
  });

  it("has no link for an arrival without a receipt, and no retry without a destination", () => {
    expect(progressRow(record("resumed")).action).toBeNull();
    expect(progressRow(record("failed", { targetEnvironmentId: null })).action).toBeNull();
  });

  it("never offers a release for a hold from before transfer records", () => {
    // Its destination may have accepted it: only the record's own answers release it.
    expect(progressRow(record("held", { legacy: true })).action).toBe("wait");
    expect(progressRow(record("held", { legacy: true })).state).toBe("waiting");
  });
});

describe("progressSummary", () => {
  it("counts finished as resumed, ready, stayed and failed, from the same rows as the bar", () => {
    const rows = [record("resumed"), record("failed"), record("sent"), record("held")].map((r) =>
      progressRow(r),
    );
    const summary = progressSummary(rows);
    expect(summary).toMatchObject({ finished: 2, total: 4, fraction: 0.5, allArrived: false });
    expect(progressSummaryText(summary, "Desk", englishPhrase)).toBe(
      "2 of 4 finished: 1 resumed, 1 failed",
    );
  });

  it("does not count waiting as failed or finished", () => {
    const rows = [record("sent"), record("accepted"), record("unknown")].map((r) => progressRow(r));
    const summary = progressSummary(rows);
    expect(summary.finished).toBe(0);
    expect(summary.counts.failed).toBe(0);
    expect(summary.fraction).toBe(0);
    expect(progressSummaryText(summary, "Desk", englishPhrase)).toBe("0 of 3 finished");
  });

  it("says all on the machine only when every thread arrived", () => {
    const arrived = [record("resumed"), record("ready")].map((r) => progressRow(r));
    expect(progressSummaryText(progressSummary(arrived), "Desk", englishPhrase)).toBe(
      "All 2 on Desk",
    );
    for (const last of ["stayed", "failed"] as const) {
      const rows = [record("resumed"), record(last)].map((r) => progressRow(r));
      const summary = progressSummary(rows);
      expect(summary.allArrived, last).toBe(false);
      expect(progressSummaryText(summary, "Desk", englishPhrase), last).toBe(
        `2 of 2 finished: 1 resumed, 1 ${last}`,
      );
    }
  });

  it("has an empty bar for no rows", () => {
    expect(progressSummary([])).toMatchObject({ finished: 0, total: 0, fraction: 0 });
  });
});

describe("progressGroups", () => {
  it("groups a batch's threads, newest batch first, one group per project", () => {
    const first = [record("resumed"), record("held")];
    const second = [
      record("sent", { batchId: "batch-2" }),
      record("sent", { batchId: "batch-2", projectId: "project-other" as ProjectId }),
    ];
    const alone = record("failed", { batchId: null });
    const batches: HandoffTransferBatch[] = [
      {
        batchId: "batch-1",
        targetEnvironmentId: TARGET,
        trigger: { kind: "manual" },
        operationIds: first.map((r) => r.operationId),
        createdAt: first[0]!.createdAt,
      },
    ];
    const groups = progressGroups([...first, ...second, alone], batches);
    expect(groups.map((group) => group.rows.length)).toEqual([1, 1, 1, 2]);
    expect(groups[0]!.key).toBe(`${alone.operationId}:${PROJECT}`);
    expect(groups.at(-1)).toMatchObject({
      key: `batch-1:${PROJECT}`,
      projectId: PROJECT,
      targetEnvironmentId: TARGET,
      trigger: { kind: "manual" },
    });
  });

  it("keeps a batch's own order for records written at the same instant", () => {
    const at = "2026-11-19T08:00:00.000Z";
    const one = record("held", { createdAt: at });
    const two = record("sent", { createdAt: at });
    const batches: HandoffTransferBatch[] = [
      {
        batchId: "batch-1",
        targetEnvironmentId: TARGET,
        trigger: { kind: "manual" },
        operationIds: [one.operationId, two.operationId],
        createdAt: at,
      },
    ];
    const [group] = progressGroups([two, one], batches);
    expect(group?.rows.map((row) => row.operationId)).toEqual([one.operationId, two.operationId]);
  });

  it("finds the newest move of one thread", () => {
    const old = record("failed");
    const next = record("sent", { lineage: { ...old.lineage, epoch: 2 } });
    expect(threadTransfer([old, next], old.lineage.sourceThreadId)?.operationId).toBe(
      next.operationId,
    );
    expect(threadTransfer([old, next], "thread-none" as ThreadId)).toBeNull();
    expect(threadTransfer(undefined, old.lineage.sourceThreadId)).toBeNull();
  });
});

describe("progressReason and progressTitle", () => {
  it("says who asked", () => {
    expect(progressReason({ kind: "manual" }, names, englishPhrase)).toBe(
      "You asked to hand off to Desk",
    );
    expect(progressReason({ kind: "pull" }, names, englishPhrase)).toBe(
      "You asked to continue on Desk",
    );
    expect(progressReason({ kind: "manual" }, { ...names, target: null }, englishPhrase)).toBe(
      "You asked to hand off",
    );
  });

  it("uses the server's reason for an automatic start, and names the track when it is known", () => {
    expect(
      progressReason(
        { kind: "automatic", reason: "Complex track out of tokens on Laptop" },
        names,
        englishPhrase,
      ),
    ).toBe("Complex track out of tokens on Laptop");
    expect(progressReason({ kind: "automatic" }, names, englishPhrase, "Complex")).toBe(
      "Complex track out of tokens on Laptop",
    );
    expect(progressReason({ kind: "automatic" }, names, englishPhrase)).toBe(
      "Out of tokens on Laptop",
    );
  });

  it("puts the project's name in quotes", () => {
    expect(progressTitle("atlas", "Desk", englishPhrase)).toBe("Hand off “atlas” to Desk");
    expect(progressTitle("atlas", null, englishPhrase)).toBe("Hand off “atlas”");
  });

  it("explains waiting and ready only when a row has them", () => {
    const rows = [record("sent"), record("ready")].map((r) => progressRow(r));
    expect(progressNotes(rows, names, englishPhrase)).toEqual([
      "Waiting is not failed. Laptop runs none of these threads while Desk has not answered.",
      "Ready means installed idle: nothing starts on Desk until you write.",
    ]);
    expect(progressNotes([progressRow(record("resumed"))], names, englishPhrase)).toEqual([]);
  });
});

describe("trackOutView (no machine has the track)", () => {
  it("names the earliest known reset of two", () => {
    const view = trackOutView({
      track: "Complex",
      staying: 2,
      resets: [
        { machineLabel: "Laptop", resetsAt: "2026-11-19T11:30:00.000Z" },
        { machineLabel: "Desk", resetsAt: "2026-11-19T09:10:00.000Z" },
      ],
    });
    expect(view.reset).toEqual({ machineLabel: "Desk", resetsAt: "2026-11-19T09:10:00.000Z" });
  });

  it("ignores a machine with no reset when another reports one", () => {
    const view = trackOutView({
      track: "Complex",
      staying: 1,
      resets: [
        { machineLabel: "Laptop", resetsAt: null },
        { machineLabel: "Desk", resetsAt: "2026-11-19T09:10:00.000Z" },
        { machineLabel: "Mini", resetsAt: "not a time" },
      ],
    });
    expect(view.reset?.machineLabel).toBe("Desk");
  });

  it("says the reset is unknown when no machine reports one", () => {
    expect(
      trackOutView({
        track: "Complex",
        staying: 2,
        resets: [{ machineLabel: "Laptop", resetsAt: null }],
      }).reset,
    ).toBeNull();
    expect(trackOutView({ track: "Complex", staying: 0, resets: [] }).reset).toBeNull();
  });
});

/**
 * Version-pinned in both directions. 1.0.383 is the release before transfer
 * records: its snapshot has no `transfers`, and its "Resume here" input is `{}`.
 */
describe("with a machine on 1.0.383", () => {
  const snapshot383 = {
    environmentId: SOURCE,
    machineLabel: "Laptop",
    config: undefined as unknown,
    projectModes: {},
    threads: [],
    incoming: [],
    pausedSince: null,
    machineRun: null,
  };

  it("reads its snapshot as nothing to show: no row, so no Resume here", () => {
    const fields = HandoffModeSnapshot.fields;
    const shape = Schema.Struct({
      transfers: fields.transfers,
      transferBatches: fields.transferBatches,
    });
    const decoded = Schema.decodeUnknownSync(shape)(snapshot383);
    expect(decoded.transfers).toBeUndefined();
    expect(progressGroups(decoded.transfers, decoded.transferBatches)).toEqual([]);
  });

  it("sends a per-thread Resume here that the 1.0.383 input shape still decodes", () => {
    const sent = encodeResume({ threadId: "thread-1" as ThreadId });
    // The 1.0.383 payload schema takes it, and its handler reads no field of it.
    expect(() => decodeResume383(sent)).not.toThrow();
    // And the window never sends it there: that machine lists no record to press it on.
    expect(decodeResume({})).toEqual({});
  });
});
