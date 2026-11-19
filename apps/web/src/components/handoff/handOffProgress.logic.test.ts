import {
  HandOffMachineInput,
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
  HandoffModeSnapshot383,
  HandOffMachineInput383,
  HandoffResumeFencedInput383,
  SNAPSHOT_FROM_383,
} from "./handoffMode383.fixture";
import {
  automaticGroupToOpen,
  automaticProgressStep,
  progressGroups,
  progressNotes,
  progressReason,
  progressRow,
  progressSummary,
  progressSummaryText,
  progressTitle,
  releaseInput,
  rowStateOf,
  submittedGroups,
  threadTransfer,
  trackOutView,
} from "./handOffProgress.logic";

const encodeResume = Schema.encodeSync(HandoffResumeFencedInput);
const decodeResume = Schema.decodeUnknownSync(HandoffResumeFencedInput);
const decodeResume383 = Schema.decodeUnknownSync(HandoffResumeFencedInput383);
const decodeSnapshot = Schema.decodeUnknownSync(HandoffModeSnapshot);
const decodeSnapshot383 = Schema.decodeUnknownSync(HandoffModeSnapshot383);
const encodeSnapshot = Schema.encodeSync(HandoffModeSnapshot);
const encodeMachineInput = Schema.encodeSync(HandOffMachineInput);
const decodeMachineInput = Schema.decodeUnknownSync(HandOffMachineInput);
const decodeMachineInput383 = Schema.decodeUnknownSync(HandOffMachineInput383);

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
    // Not held yet: the batch that planned it still owns it, so the row offers nothing.
    expect(progressRow(record("pending")).action).toBeNull();
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

const batchOf = (
  batchId: string,
  operationIds: string[],
  target: EnvironmentId = TARGET,
): HandoffTransferBatch => ({
  batchId,
  targetEnvironmentId: target,
  trigger: { kind: "manual" },
  operationIds,
  createdAt: "2026-11-19T07:00:00.000Z",
});

describe("a batch this machine keeps only part of", () => {
  // What the machine's view sent before it kept batches whole: the batch names
  // two operations, and only the one that arrived is still a record.
  const arrived = record("ready", { operationId: "op-arrived", batchId: "mixed" });
  const batch = batchOf("mixed", ["op-stayed", "op-arrived"]);

  it("marks the group incomplete and never says all arrived", () => {
    const [group] = progressGroups([arrived], [batch]);
    expect(group?.incomplete).toBe(true);
    const summary = progressSummary(group!.rows, group!.incomplete);
    expect(summary.allArrived).toBe(false);
    expect(progressSummaryText(summary, "Desk", englishPhrase)).toBe("1 of 1 finished: 1 ready");
    expect(progressNotes(group!.rows, names, englishPhrase, group!.incomplete)).toContain(
      "Laptop no longer keeps every thread of this hand off, so this list is not all of it.",
    );
  });

  it("is complete, and says all arrived, when every operation of the batch is here", () => {
    const stayed = record("ready", { operationId: "op-stayed", batchId: "mixed" });
    const [group] = progressGroups([stayed, arrived], [batch]);
    expect(group?.incomplete).toBe(false);
    const summary = progressSummary(group!.rows, group!.incomplete);
    expect(progressSummaryText(summary, "Desk", englishPhrase)).toBe("All 2 on Desk");
    expect(progressNotes(group!.rows, names, englishPhrase, group!.incomplete)).toHaveLength(1);
  });
});

describe("the hand off this window asked for", () => {
  const MINI = "env-mini" as EnvironmentId;
  const thread = "thread-shared" as ThreadId;
  const lineage = { sourceEnvironmentId: SOURCE, sourceThreadId: thread, epoch: 1 };
  // Two windows pressed Hand off for the same thread: this one to Desk, the other to Mini.
  const mine = record("failed", { operationId: "op-desk", batchId: "window-desk", lineage });
  const theirs = record("sent", {
    operationId: "op-mini",
    batchId: "window-mini",
    targetEnvironmentId: MINI,
    lineage: { ...lineage, epoch: 2 },
  });
  const batches = [batchOf("window-desk", ["op-desk"]), batchOf("window-mini", ["op-mini"], MINI)];

  it("shows only the batch this window named, whatever is newer on the thread", () => {
    const groups = progressGroups([mine, theirs], batches);
    expect(groups.map((group) => group.batchId)).toEqual(["window-mini", "window-desk"]);
    const shown = submittedGroups(groups, "window-desk", null);
    expect(shown.map((group) => group.targetEnvironmentId)).toEqual([TARGET]);
    expect(shown.flatMap((group) => group.rows.map((row) => row.operationId))).toEqual(["op-desk"]);
  });

  it("shows nothing while its own batch has no record, so the form and its error stay", () => {
    const groups = progressGroups([theirs], [batches[1]!]);
    expect(submittedGroups(groups, "window-desk", null)).toEqual([]);
    expect(submittedGroups(groups, null, null)).toEqual([]);
  });

  it("keeps to one project when the dialog has that scope", () => {
    const other = record("pending", {
      operationId: "op-other",
      batchId: "window-desk",
      projectId: "project-other" as ProjectId,
    });
    const groups = progressGroups([mine, other], [batchOf("window-desk", ["op-desk", "op-other"])]);
    expect(submittedGroups(groups, "window-desk", null)).toHaveLength(2);
    expect(submittedGroups(groups, "window-desk", PROJECT).map((g) => g.projectId)).toEqual([
      PROJECT,
    ]);
  });

  it("sends the batch's name with the request, and a 1.0.383 machine still takes it", () => {
    const sent = encodeMachineInput({
      destinationEnvironmentId: TARGET,
      reason: "manual",
      threadIds: [thread],
      batchId: "window-desk",
    } as HandOffMachineInput);
    expect(decodeMachineInput(sent)).toMatchObject({ batchId: "window-desk" });
    expect(() => decodeMachineInput383(sent)).not.toThrow();
  });
});

describe("Resume here names its operation", () => {
  it("sends the row's operation with the thread", () => {
    const row = progressRow(record("held", { operationId: "op-held" }));
    expect(releaseInput(row)).toEqual({ threadId: row.threadId, operationId: "op-held" });
    expect(decodeResume(encodeResume(releaseInput(row)))).toEqual({
      threadId: row.threadId,
      operationId: "op-held",
    });
  });
});

describe("an automatic start opens its own progress view", () => {
  const automatic = { kind: "automatic", key: "limit:1", usageWindowKey: "w" } as const;
  const auto = (state: HandoffTransferState, id: string) =>
    progressGroups([record(state, { operationId: id, batchId: null, trigger: automatic })], [])[0]!;
  const manual = progressGroups([record("held", { operationId: "op-manual", batchId: null })], []);

  it("opens the newest automatic hand off this window has not seen", () => {
    const first = auto("sent", "op-auto-1");
    const second = auto("pending", "op-auto-2");
    const seen = new Set([...first.rows.map((row) => row.operationId), "op-manual"]);
    expect(automaticGroupToOpen(seen, [second, first, ...manual])).toBe(second.key);
    // Nothing new: nothing opens again.
    expect(automaticGroupToOpen(new Set([...seen, "op-auto-2"]), [second, first])).toBeNull();
  });

  it("never opens for a hand off a person asked for", () => {
    expect(automaticGroupToOpen(new Set(), manual)).toBeNull();
  });

  it("on a window's first read opens only one still under way", () => {
    expect(automaticGroupToOpen(null, [auto("resumed", "op-auto-done")])).toBeNull();
    const open = auto("sent", "op-auto-open");
    expect(automaticGroupToOpen(null, [open])).toBe(open.key);
  });
});

describe("what a window has seen of automatic hand offs", () => {
  const automatic = { kind: "automatic", key: "limit:1", usageWindowKey: "w" } as const;
  const done = progressGroups(
    [record("resumed", { operationId: "op-auto-old", batchId: null, trigger: automatic })],
    [],
  );

  it("opens nothing after a read that carried no records", () => {
    // The machine could not read its records for one snapshot: that is not "none".
    const first = automaticProgressStep(null, done);
    expect(first.open).toBeNull();
    const blind = automaticProgressStep(first.seen, null);
    expect(blind).toEqual({ seen: first.seen, open: null });
    expect(automaticProgressStep(blind.seen, done).open).toBeNull();
  });

  it("never forgets a record it has seen", () => {
    const first = automaticProgressStep(null, done);
    const emptied = automaticProgressStep(first.seen, []);
    expect([...(emptied.seen ?? [])]).toEqual(["op-auto-old"]);
    expect(automaticProgressStep(emptied.seen, done).open).toBeNull();
  });

  it("opens a new one once", () => {
    const first = automaticProgressStep(null, done);
    const started = progressGroups(
      [record("pending", { operationId: "op-auto-new", batchId: null, trigger: automatic })],
      [],
    );
    const next = automaticProgressStep(first.seen, [...started, ...done]);
    expect(next.open).toBe(started[0]!.key);
    expect(automaticProgressStep(next.seen, [...started, ...done]).open).toBeNull();
  });
});

describe("automatic hand offs that overlap", () => {
  const trigger = (key: string) => ({ kind: "automatic", key, usageWindowKey: "w" }) as const;
  const pending = (id: string, project: string) =>
    progressGroups(
      [
        record("pending", {
          operationId: id,
          batchId: null,
          projectId: project as ProjectId,
          trigger: trigger(id),
        }),
      ],
      [],
    )[0]!;
  // An empty first read: the window has seen that this machine has no records.
  const baseline = automaticProgressStep(null, []).seen;

  it("shows each of two that start between two reads, one after the other, exactly once", () => {
    const a = pending("op-a", "project-a");
    const b = pending("op-b", "project-b");
    const groups = [b, a];
    const first = automaticProgressStep(baseline, groups, false);
    expect(first.open).toBe(b.key);
    // The first view is open: nothing replaces it, and the other is not lost.
    const during = automaticProgressStep(first.seen, groups, true);
    expect(during.open).toBeNull();
    // Done was pressed.
    const second = automaticProgressStep(during.seen, groups, false);
    expect(second.open).toBe(a.key);
    const third = automaticProgressStep(second.seen, groups, true);
    expect(automaticProgressStep(third.seen, groups, false).open).toBeNull();
  });

  it("shows one that starts while a view is open, once that view is closed", () => {
    const a = pending("op-a", "project-a");
    const first = automaticProgressStep(baseline, [a], false);
    expect(first.open).toBe(a.key);
    const b = pending("op-b", "project-b");
    // It arrives before Done: the open view stays, and the arrival is not marked seen.
    const arrived = automaticProgressStep(first.seen, [b, a], true);
    expect(arrived.open).toBeNull();
    const afterDone = automaticProgressStep(arrived.seen, [b, a], false);
    expect(afterDone.open).toBe(b.key);
    expect(automaticProgressStep(afterDone.seen, [b, a], false).open).toBeNull();
  });

  it("on a first read with two under way, shows both in turn and no finished one", () => {
    const a = pending("op-a", "project-a");
    const b = pending("op-b", "project-b");
    const done = progressGroups(
      [record("resumed", { operationId: "op-done", batchId: null, trigger: trigger("done") })],
      [],
    )[0]!;
    const groups = [b, a, done];
    const first = automaticProgressStep(null, groups, false);
    expect(first.open).toBe(b.key);
    const second = automaticProgressStep(first.seen, groups, false);
    expect(second.open).toBe(a.key);
    expect(automaticProgressStep(second.seen, groups, false).open).toBeNull();
  });
});

/**
 * Version-pinned in both directions with the shapes of tag v1.0.383, the
 * release before transfer records: its snapshot has no `transfers`, and its
 * "Resume here" input is `{}`.
 */
describe("with a machine on 1.0.383", () => {
  it("reads its snapshot as nothing to show: no row, so no Resume here", () => {
    const decoded = decodeSnapshot(SNAPSHOT_FROM_383);
    expect(decoded.transfers).toBeUndefined();
    expect(progressGroups(decoded.transfers, decoded.transferBatches)).toEqual([]);
  });

  it("a 1.0.383 window reads today's snapshot and drops the records it does not know", () => {
    const today = encodeSnapshot({
      ...decodeSnapshot(SNAPSHOT_FROM_383),
      transfers: [record("held")],
      transferBatches: [batchOf("batch-1", ["op-x"])],
    });
    const old = decodeSnapshot383(today);
    expect(old).not.toHaveProperty("transfers");
    expect(old.machineLabel).toBe("Old Mac");
  });

  it("sends a per-thread Resume here that the 1.0.383 input shape still decodes", () => {
    const sent = encodeResume({ threadId: "thread-1" as ThreadId, operationId: "op-1" });
    // The 1.0.383 payload schema takes it, and its handler reads no field of it.
    expect(() => decodeResume383(sent)).not.toThrow();
    // And the window never sends it there: that machine lists no record to press it on.
    expect(decodeResume({})).toEqual({});
  });
});
