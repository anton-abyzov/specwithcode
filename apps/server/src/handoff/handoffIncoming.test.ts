import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HANDOFF_LEASE_STALE_MS,
  type HandoffCheckpoint,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  EMPTY_HANDOFF_DOCUMENT,
  findIncoming,
  HANDOFF_INCOMING_MAX,
  HandoffDocument,
  type HandoffDocument as Document,
  heartbeatContinued,
  incomingKey,
  linkedLocalProject,
  markContinued,
  markUnreachable,
  takeoverVerdict,
  upsertIncoming,
} from "./handoffState.ts";
import type { ReplicateMeta, TakeoverRequest, TakeoverResponse } from "./handoffWire.ts";

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const sourceProject = ProjectId.make("project-src");
const localProject = ProjectId.make("project-local");
const sourceThread = ThreadId.make("thread-src");
const now = "2026-10-20T14:00:00.000Z";
const later = "2026-10-20T14:05:00.000Z";

const checkpoint = (sequence: number, epoch = 1): HandoffCheckpoint => ({
  sequence,
  commit: "a".repeat(40),
  baseCommit: "b".repeat(40),
  branch: "feat/x",
  ref: `refs/specwithcode/handoff/${sourceThread}`,
  createdAt: now,
  reason: "turn-end",
  skipped: [],
  excludedSecretCount: 0,
  transcriptMessageCount: 2,
  note: null,
  pushedToOrigin: false,
  epoch,
  latestRunId: null,
  turnKey: `${sourceThread}/run-1`,
  runEnding: "usage-limit",
  sideEffects: [],
  sourceRoot: {
    environmentId: m4,
    projectId: sourceProject,
    threadId: sourceThread,
    workspaceRoot: "/repo",
    branch: "feat/x",
  },
});

const meta = (sequence: number, epoch = 1, threadId = sourceThread): ReplicateMeta => ({
  sourceEnvironmentId: m4,
  sourceLabel: "M4",
  sourceProjectId: sourceProject,
  sourceThreadId: threadId,
  repositoryPath: "",
  title: "Fix the build",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5.5" } as never,
  runtimeMode: "full-access",
  interactionMode: "default",
  checkpoint: checkpoint(sequence, epoch),
  lease: {
    holderEnvironmentId: m4,
    holderLabel: "M4",
    holderThreadId: threadId,
    epoch,
    renewedAt: now,
    state: "active",
  },
  transcript: [{ role: "user", text: "Fix the build" }],
  execution: null,
});

const stored = (document: Document, input: ReplicateMeta): Document => {
  const verdict = upsertIncoming(document, {
    meta: input,
    projectId: localProject,
    machineLabel: "Minis",
    now,
  });
  if (verdict.kind !== "stored") throw new Error(verdict.message);
  return verdict.document;
};

const takeover = (overrides: Partial<TakeoverRequest> = {}): TakeoverRequest => ({
  sourceEnvironmentId: m4,
  sourceThreadId: sourceThread,
  epoch: 2,
  sequence: 3,
  reason: "machine-handoff",
  modelSelection: null,
  ...overrides,
});

const response: TakeoverResponse = {
  threadId: ThreadId.make("thread-dest"),
  machineLabel: "Minis",
  modelSelection: null,
  resumed: true,
  notice: null,
};

const encodeDocument = Schema.encodeSync(HandoffDocument);
const decodeDocument = Schema.decodeUnknownOption(HandoffDocument);

describe("incoming replicas", () => {
  it("stores the newest checkpoint and keeps a newer one over an older resend", () => {
    const first = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
    expect(findIncoming(first, m4, sourceThread)?.checkpoint.sequence).toBe(3);
    expect(first.incomingDetails?.[incomingKey(m4, sourceThread)]?.sourceProjectId).toBe(
      sourceProject,
    );
    const resent = upsertIncoming(first, {
      meta: meta(2),
      projectId: localProject,
      machineLabel: "Minis",
      now: later,
    });
    expect(resent.kind).toBe("stored");
    if (resent.kind !== "stored") return;
    const replica = findIncoming(resent.document, m4, sourceThread);
    expect(replica?.checkpoint.sequence).toBe(3);
    expect(replica?.sourceLastSeenAt).toBe(later);
  });

  it("refuses a replica of a thread this machine already continued", () => {
    const document = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    const verdict = upsertIncoming(document, {
      meta: meta(4),
      projectId: localProject,
      machineLabel: "Minis",
      now,
    });
    expect(verdict).toMatchObject({ kind: "refused", code: "fenced" });
  });

  it("evicts replicas this machine never continued first", () => {
    let document = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    for (let index = 0; index < HANDOFF_INCOMING_MAX; index += 1) {
      document = stored(document, meta(1, 1, ThreadId.make(`thread-${index}`)));
    }
    expect(document.incoming).toHaveLength(HANDOFF_INCOMING_MAX);
    expect(findIncoming(document, m4, sourceThread)?.continuedThreadId).toBe("thread-dest");
    expect(findIncoming(document, m4, ThreadId.make("thread-0"))).toBeUndefined();
    expect(document.incomingDetails?.[incomingKey(m4, "thread-0")]).toBeUndefined();
  });

  it("decodes a document written before incoming details existed", () => {
    const encoded = encodeDocument(EMPTY_HANDOFF_DOCUMENT) as Record<string, unknown>;
    const { incomingDetails: _dropped, ...older } = encoded;
    const decoded = decodeDocument(older);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded).incomingDetails).toEqual({});
  });
});

describe("takeover", () => {
  const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));

  it("proceeds at a newer epoch with the checkpoint in hand", () => {
    expect(takeoverVerdict(document, takeover(), "Minis").kind).toBe("proceed");
  });

  it("refuses without the checkpoint, naming the check", () => {
    expect(takeoverVerdict(EMPTY_HANDOFF_DOCUMENT, takeover(), "Minis")).toMatchObject({
      kind: "refuse",
      code: "not_found",
      check: "checkpoint",
      message: "Minis: no checkpoint for this thread",
    });
    expect(takeoverVerdict(document, takeover({ sequence: 4 }), "Minis")).toMatchObject({
      kind: "refuse",
      check: "checkpoint",
    });
  });

  it("refuses a stale epoch", () => {
    expect(takeoverVerdict(document, takeover({ epoch: 1 }), "Minis")).toMatchObject({
      kind: "refuse",
      code: "fenced",
      check: "lease",
    });
  });

  it("answers a repeated takeover with the same thread and refuses another epoch", () => {
    const continued = markContinued(document, takeover(), response, now);
    expect(takeoverVerdict(continued, takeover(), "Minis")).toEqual({ kind: "repeat", response });
    expect(takeoverVerdict(continued, takeover({ epoch: 3 }), "Minis")).toMatchObject({
      kind: "refuse",
      code: "fenced",
    });
  });
});

describe("heartbeat", () => {
  it("tells the source which threads this machine continued, whatever epoch it names", () => {
    const continued = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    const [fenced, next] = heartbeatContinued(
      continued,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 1 }] },
      later,
    );
    expect(fenced).toEqual([{ sourceThreadId: sourceThread, epoch: 2, threadId: "thread-dest" }]);
    expect(findIncoming(next, m4, sourceThread)?.sourceLastSeenAt).toBe(later);
    // A source that bumped its epoch after an unknown takeover outcome is still fenced.
    const [bumped] = heartbeatContinued(
      continued,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 3 }] },
      later,
    );
    expect(bumped).toEqual([{ sourceThreadId: sourceThread, epoch: 2, threadId: "thread-dest" }]);
    const [none] = heartbeatContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 2 }] },
      later,
    );
    expect(none).toEqual([]);
  });

  it("raises the replica's epoch to the one the source holds, refusing a delayed takeover", () => {
    const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
    const [, next] = heartbeatContinued(
      document,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 3 }] },
      later,
    );
    expect(findIncoming(next, m4, sourceThread)?.lease.epoch).toBe(3);
    expect(takeoverVerdict(next, takeover({ epoch: 2 }), "Minis")).toMatchObject({
      kind: "refuse",
      check: "lease",
    });
    expect(takeoverVerdict(next, takeover({ epoch: 4 }), "Minis").kind).toBe("proceed");
    const [, lower] = heartbeatContinued(
      next,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 1 }] },
      later,
    );
    expect(findIncoming(lower, m4, sourceThread)?.lease.epoch).toBe(3);
  });

  it("renews the replica's lease at the same epoch and clears unknown", () => {
    const document = markUnreachable(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      Date.parse(now) + HANDOFF_LEASE_STALE_MS + 1,
    );
    expect(findIncoming(document, m4, sourceThread)?.sourceUnreachable).toBe(true);
    const [, next] = heartbeatContinued(
      document,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 1 }] },
      later,
    );
    const replica = findIncoming(next, m4, sourceThread);
    expect(replica?.sourceUnreachable).toBe(false);
    expect(replica?.lease.renewedAt).toBe(later);
  });

  it("leaves a recently seen source reachable", () => {
    const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
    expect(markUnreachable(document, Date.parse(now) + HANDOFF_LEASE_STALE_MS)).toBe(document);
  });
});

describe("linked project", () => {
  const project = (id: string, title: string, members: Array<[string, string]>) => ({
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/work/${id}`,
    deletedAt: null,
    workspaceSettings: {
      logicalProject: {
        members: members.map(([environmentId, projectId]) => ({ environmentId, projectId })),
      },
    },
  });

  it("joins only through an explicit link, never by name", () => {
    const sameName = project("p-same", "Fix the build", []);
    const linked = project("p-linked", "Other title", [[m4, sourceProject]]);
    expect(linkedLocalProject([sameName], m4, sourceProject)).toBeNull();
    expect(linkedLocalProject([sameName, linked], m4, sourceProject)?.id).toBe("p-linked");
    expect(linkedLocalProject([linked], minis, sourceProject)).toBeNull();
    expect(linkedLocalProject([{ ...linked, deletedAt: now }], m4, sourceProject)).toBeNull();
  });
});
