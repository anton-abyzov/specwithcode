import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HANDOFF_LEASE_STALE_MS,
  ProjectId,
  ThreadId,
  type ThreadSideEffect,
} from "@specweave-studio/contracts";

import {
  acquireLease,
  checkEpoch,
  deriveHandoffBadge,
  EMPTY_HANDOFF_DOCUMENT,
  effectiveHandoffMode,
  emptyThreadRecord,
  fenceRecord,
  guardSideEffect,
  HANDOFF_RUN_EPOCHS_MAX,
  type HandoffThreadRecord,
  isLeaseStale,
  mergeSideEffects,
  noteRunEpoch,
  recordSideEffect,
  renewLease,
} from "./handoffState.ts";

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-10-20T14:00:00.000Z";

const leased = (holder = m4, epoch = 1): HandoffThreadRecord => ({
  ...emptyThreadRecord(projectId),
  mode: "on",
  lease: {
    holderEnvironmentId: holder,
    holderLabel: holder === m4 ? "M4" : "Minis",
    holderThreadId: threadId,
    epoch,
    renewedAt: now,
    state: "active",
  },
});

const effect = (overrides: Partial<ThreadSideEffect> = {}): ThreadSideEffect => ({
  turnKey: `${threadId}/run-1`,
  kind: "pr-create",
  target: "branch:feat/x",
  epoch: 1,
  environmentId: m4,
  at: now,
  result: "github.com/o/r#7",
  ...overrides,
});

describe("lease", () => {
  it("gives every new holder a strictly greater epoch", () => {
    const first = acquireLease(null, { environmentId: m4, label: "M4", threadId }, now);
    expect(first.epoch).toBe(1);
    const second = acquireLease(first, { environmentId: minis, label: "Minis", threadId }, now);
    expect(second.epoch).toBe(2);
    const floored = acquireLease(second, { environmentId: m4, label: "M4", threadId }, now, 9);
    expect(floored.epoch).toBe(10);
  });

  it("renews only for the active holder", () => {
    const lease = leased().lease;
    const later = "2026-10-20T14:01:00.000Z";
    expect(renewLease(lease, m4, later)?.renewedAt).toBe(later);
    expect(renewLease(lease, minis, later)).toBe(lease);
    const fenced = lease === null ? null : { ...lease, state: "fenced" as const };
    expect(renewLease(fenced, m4, later)).toBe(fenced);
  });

  it("goes stale after the stale window", () => {
    const lease = leased().lease!;
    const renewed = Date.parse(now);
    expect(isLeaseStale(lease, renewed + HANDOFF_LEASE_STALE_MS)).toBe(false);
    expect(isLeaseStale(lease, renewed + HANDOFF_LEASE_STALE_MS + 1)).toBe(true);
  });

  it("remembers the first epoch a run started under and keeps the newest runs", () => {
    let epochs: Record<string, number> = {};
    epochs = noteRunEpoch(epochs, "run-1", 1);
    epochs = noteRunEpoch(epochs, "run-1", 5);
    expect(epochs["run-1"]).toBe(1);
    for (let index = 2; index <= HANDOFF_RUN_EPOCHS_MAX + 5; index += 1) {
      epochs = noteRunEpoch(epochs, `run-${index}`, index);
    }
    expect(Object.keys(epochs)).toHaveLength(HANDOFF_RUN_EPOCHS_MAX);
    expect(epochs["run-1"]).toBeUndefined();
    expect(epochs[`run-${HANDOFF_RUN_EPOCHS_MAX + 5}`]).toBe(HANDOFF_RUN_EPOCHS_MAX + 5);
  });
});

describe("checkEpoch", () => {
  it("leaves a thread that never used handoff mode alone", () => {
    expect(checkEpoch(undefined, m4).kind).toBe("unleased");
    expect(checkEpoch(emptyThreadRecord(projectId), m4).kind).toBe("unleased");
  });

  it("accepts the holder at the current epoch", () => {
    expect(checkEpoch(leased(m4, 3), m4, 3)).toEqual({ kind: "ok", epoch: 3 });
    expect(checkEpoch(leased(m4, 3), m4)).toEqual({ kind: "ok", epoch: 3 });
  });

  it("refuses a stale epoch from the holder", () => {
    expect(checkEpoch(leased(m4, 3), m4, 2).kind).toBe("stale");
  });

  it("refuses a machine that does not hold the lease", () => {
    const verdict = checkEpoch(leased(minis, 4), m4, 3);
    expect(verdict.kind).toBe("fenced");
    expect(verdict.kind === "fenced" && verdict.message).toContain("Minis");
  });

  it("refuses a copy that handed off, whatever epoch it claims", () => {
    const fenced = fenceRecord(
      leased(m4, 3),
      { environmentId: minis, machineLabel: "Minis", threadId, at: now },
      "handoff",
    );
    expect(fenced.lease?.state).toBe("fenced");
    expect(fenced.fencedBy).toBe("handoff");
    expect(checkEpoch(fenced, m4, 3).kind).toBe("fenced");
  });

  it("refuses the holder while its handoff is in flight, and accepts it once released", () => {
    const record = leased(m4, 3);
    const handingOff: HandoffThreadRecord = {
      ...record,
      lease: { ...record.lease!, state: "handing-off" },
    };
    const verdict = checkEpoch(handingOff, m4, 3);
    expect(verdict).toEqual({
      kind: "fenced",
      message:
        "This thread is being handed off; it performs no side effects until the handoff finishes.",
    });
    expect(checkEpoch(handingOff, m4).kind).toBe("fenced");
    expect(checkEpoch(record, m4, 3)).toEqual({ kind: "ok", epoch: 3 });
  });
});

describe("guardSideEffect", () => {
  const input = (record: HandoffThreadRecord | undefined, turnKey = `${threadId}/run-1`) => ({
    record,
    environmentId: m4,
    turnKey,
    kind: "pr-create" as const,
    target: "branch:feat/x",
  });

  it("proceeds with the current epoch the first time", () => {
    expect(guardSideEffect({ ...input(leased(m4, 2)), epoch: 2 })).toEqual({
      kind: "proceed",
      epoch: 2,
      turnKey: `${threadId}/run-1`,
    });
  });

  it("proceeds at epoch 0 without handoff mode", () => {
    expect(guardSideEffect(input(undefined)).kind).toBe("proceed");
  });

  it("reuses a result the same turn already journaled", () => {
    const record = recordSideEffect(leased(), effect());
    const verdict = guardSideEffect(input(record));
    expect(verdict.kind).toBe("reuse");
    expect(verdict.kind === "reuse" && verdict.effect.result).toBe("github.com/o/r#7");
  });

  it("reuses what the source did when the continuation resumes its turn", () => {
    const record: HandoffThreadRecord = {
      ...recordSideEffect(leased(minis, 2), effect({ environmentId: m4, epoch: 1 })),
      resumeTurnKey: `${threadId}/run-1`,
    };
    const verdict = guardSideEffect({
      ...input(record, `${threadId}/run-on-minis`),
      environmentId: minis,
      epoch: 2,
    });
    expect(verdict.kind).toBe("reuse");
  });

  it("proceeds for a different target or kind", () => {
    const record = recordSideEffect(leased(), effect());
    expect(guardSideEffect({ ...input(record), target: "branch:other" }).kind).toBe("proceed");
    expect(guardSideEffect({ ...input(record), kind: "pr-merge" }).kind).toBe("proceed");
  });

  it("refuses on a stale epoch or a fenced copy before reusing anything", () => {
    const record = recordSideEffect(leased(m4, 3), effect());
    expect(guardSideEffect({ ...input(record), epoch: 2 }).kind).toBe("refuse");
    expect(guardSideEffect({ ...input(record), environmentId: minis }).kind).toBe("refuse");
  });

  it("refuses every side effect while the thread is being handed off", () => {
    const record = leased(m4, 3);
    const handingOff: HandoffThreadRecord = {
      ...record,
      lease: { ...record.lease!, state: "handing-off" },
    };
    const verdict = guardSideEffect({ ...input(handingOff), epoch: 3 });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.kind === "refuse" && verdict.message).toContain("being handed off");
    // Journaling what already happened is never blocked by the hold.
    expect(recordSideEffect(handingOff, effect()).sideEffects).toHaveLength(1);
  });
});

describe("mergeSideEffects", () => {
  it("keeps one entry per turn, kind and target, newest result last", () => {
    const merged = mergeSideEffects(
      [effect({ at: "2026-10-20T14:00:00.000Z", result: "a" })],
      [effect({ at: "2026-10-20T14:05:00.000Z", result: "b" }), effect({ kind: "git-push" })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.kind === "pr-create")?.result).toBe("b");
  });
});

describe("effectiveHandoffMode and badge", () => {
  it("prefers the thread, then the project, then the default", () => {
    const document = { ...EMPTY_HANDOFF_DOCUMENT, projectModes: { [projectId]: "on" as const } };
    expect(effectiveHandoffMode(document, projectId, "off")).toBe("off");
    expect(effectiveHandoffMode(document, projectId, "inherit")).toBe("on");
    expect(effectiveHandoffMode(EMPTY_HANDOFF_DOCUMENT, projectId, "inherit")).toBe("off");
  });

  it("reads continued for a fenced copy even with the mode off", () => {
    const record = fenceRecord(
      leased(),
      { environmentId: minis, machineLabel: "Minis", threadId, at: now },
      null,
    );
    expect(deriveHandoffBadge({ record, effectiveMode: "off", paused: false })).toBe("continued");
  });

  it("reads ready only once the checkpoint reached every replica, never from origin alone", () => {
    const base = leased();
    expect(deriveHandoffBadge({ record: base, effectiveMode: "on", paused: false })).toBeNull();
    const checkpoint = {
      sequence: 2,
      commit: "c",
      baseCommit: "b",
      branch: "main",
      ref: "refs/specwithcode/handoff/thread-1",
      createdAt: now,
      reason: "turn-end" as const,
      skipped: [],
      excludedSecretCount: 0,
      transcriptMessageCount: 2,
      note: null,
      pushedToOrigin: false,
      epoch: 1,
      latestRunId: null,
      turnKey: null,
      runEnding: "completed" as const,
      sideEffects: [],
      sourceRoot: {
        environmentId: m4,
        projectId,
        threadId,
        workspaceRoot: "/repo",
        branch: "main",
      },
    };
    const withCheckpoint = { ...base, checkpoint };
    // No other machine holds a copy: nothing can continue it, origin backup or not.
    expect(
      deriveHandoffBadge({ record: withCheckpoint, effectiveMode: "on", paused: false }),
    ).toBeNull();
    expect(
      deriveHandoffBadge({
        record: { ...withCheckpoint, checkpoint: { ...checkpoint, pushedToOrigin: true } },
        effectiveMode: "on",
        paused: false,
      }),
    ).toBeNull();
    const replica = {
      environmentId: minis,
      machineLabel: "Minis",
      state: "current" as const,
      sequence: 2,
      detail: null,
      updatedAt: now,
    };
    expect(
      deriveHandoffBadge({
        record: { ...withCheckpoint, replicas: [replica] },
        effectiveMode: "on",
        paused: false,
      }),
    ).toBe("ready");
    expect(
      deriveHandoffBadge({
        record: { ...withCheckpoint, replicas: [{ ...replica, sequence: 1 }] },
        effectiveMode: "on",
        paused: false,
      }),
    ).toBe("behind");
  });
});
