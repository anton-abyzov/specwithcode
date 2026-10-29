import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { LifecycleReceipt as LifecycleReceiptSchema } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import {
  lifecycleGoalUpdateError,
  pendingLifecycleGoalObligations,
  currentLifecycleRequest,
  evaluateLifecycleEvidence,
  lifecycleDeliveryStatus,
  lifecycleWaitGroup,
  type LifecycleReceipt,
  type LifecycleObligation,
} from "./threadLifecycleEvidence.ts";

const request = {
  requestId: "request-1",
  runId: "run-1",
  acceptanceRevision: "acceptance-1",
  requestedAt: "2026-10-25T00:00:00Z",
};
const now = Date.parse("2026-10-25T02:00:00Z");
const evidence = {
  status: "verified" as const,
  reference: "receipt://delivery/1",
  observedAt: "2026-10-25T01:00:00Z",
  scopeRevision: "revision-1",
};
const ready: LifecycleReceipt = {
  ...request,
  kind: "code",
  scope: "Deploy and verify requested feature",
  scopeRevision: "revision-1",
  recordedAt: "2026-10-25T01:30:00Z",
  validUntil: "2026-10-26T00:00:00Z",
  reportedBy: "completion-owner",
  obligations: [],
  push: evidence,
  merge: evidence,
  deployment: evidence,
  deliverable: evidence,
  verification: evidence,
};
const decide = (receipt: LifecycleReceipt | null) =>
  evaluateLifecycleEvidence(request, receipt, now);

describe("request-bound lifecycle evidence", () => {
  it("requires affirmative delivery evidence, not a terminal turn", () => {
    expect(decide(null)).toBe("missing_evidence");
    expect(decide(ready)).toBe("accepted");
  });
  it.each(["push", "merge", "deployment", "deliverable", "verification"] as const)(
    "does not accept code work missing %s",
    (gate) => {
      expect(decide({ ...ready, [gate]: { status: "pending", reason: "Not yet verified" } })).toBe(
        "incomplete_evidence",
      );
      expect(decide({ ...ready, [gate]: { ...evidence, scopeRevision: "old-source" } })).toBe(
        "incomplete_evidence",
      );
    },
  );
  it("accepts delivered research with justified N/A code gates", () => {
    const na = { status: "not_applicable" as const, rationale: "Research answer; no code changed" };
    const receipt = { ...ready, kind: "no_code" as const, push: na, merge: na, deployment: na };
    expect(decide(receipt)).toBe("accepted");
    expect(decide({ ...receipt, push: { ...na, rationale: " " } })).toBe("incomplete_evidence");
    expect(decide({ ...receipt, verification: na })).toBe("incomplete_evidence");
    expect(decide({ ...ready, push: na })).toBe("incomplete_evidence");
  });
  it.each(["requestId", "runId", "acceptanceRevision", "requestedAt"] as const)(
    "rejects superseded %s even after restart",
    (key) => {
      const restored = JSON.parse(JSON.stringify(ready)) as LifecycleReceipt;
      expect(evaluateLifecycleEvidence({ ...request, [key]: "new" }, restored, now)).toBe(
        "superseded_request",
      );
    },
  );
  it("rejects expired, future and malformed evidence", () => {
    for (const patch of [
      { validUntil: "2026-10-25T02:00:00Z" },
      { recordedAt: "2026-10-25T03:00:00Z" },
      { recordedAt: "2026-10-24T23:00:00Z" },
      { validUntil: "invalid" },
    ])
      expect(decide({ ...ready, ...patch })).toBe("stale_evidence");
    expect(
      decide({ ...ready, verification: { ...evidence, observedAt: "2026-10-24T23:00:00Z" } }),
    ).toBe("incomplete_evidence");
    expect(decide({ ...ready, verification: { ...evidence, reference: " " } })).toBe(
      "incomplete_evidence",
    );
  });
  it("preserves unfinished acceptance after disk recovery and restart", () => {
    const disk: LifecycleObligation = {
      kind: "resource",
      reason:
        "ENOSPC: no space left on device stopped testing; 162 MiB remains. Please free disk space before resuming. 1006 stays open.",
      owner: "cleanup-owner",
      nextEvent: "Verify recovered test capacity",
      needsUserOutput: false,
    };
    expect(lifecycleWaitGroup(disk)).toBe("Operational wait");
    expect(decide({ ...ready, obligations: [disk] })).toBe("outstanding_obligations");
    const recovered = JSON.parse(
      JSON.stringify({
        ...ready,
        obligations: [
          {
            kind: "deployment",
            reason: "Compatibility and installed checks remain",
            owner: "release-owner",
            nextEvent: "Installed acceptance receipt",
            needsUserOutput: false,
          },
        ],
      }),
    ) as LifecycleReceipt;
    expect(decide(recovered)).toBe("outstanding_obligations");
    expect(lifecycleWaitGroup(recovered.obligations[0]!)).toBe("Operational wait");
  });
  it("never turns Stop or unknown state into recovery permission", () => {
    const wait = { reason: "Wait", owner: "owner", nextEvent: "Evidence", needsUserOutput: false };
    for (const kind of [
      "stopped",
      "unknown",
      "nested_work",
      "authentication",
      "provider",
      "usage_limit",
      "review",
      "dependency",
      "network",
      "tool",
    ] as const) {
      expect(decide({ ...ready, obligations: [{ ...wait, kind }] })).toBe(
        "outstanding_obligations",
      );
    }
    expect(lifecycleWaitGroup({ ...wait, kind: "stopped", needsUserOutput: true })).toBe("Stopped");
    expect(lifecycleWaitGroup({ ...wait, kind: "unknown" })).toBe("Unknown");
    expect(lifecycleWaitGroup({ ...wait, kind: "authentication" })).toBe("Operational wait");
    expect(lifecycleWaitGroup({ ...wait, kind: "authentication", needsUserOutput: true })).toBe(
      "Waiting on you",
    );
  });
});

describe("thread view delivery status", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const projection = (
    extra: {
      runStatus?: string;
      laterMessage?: boolean;
      steer?: boolean;
      extraRuns?: ReadonlyArray<Record<string, unknown>>;
    } = {},
  ) =>
    ({
      thread: { lifecycleRevision: undefined },
      runs: [
        {
          id: "run-1",
          ordinal: 1,
          status: extra.runStatus ?? "completed",
          userMessageId: "request-1",
          requestedAt: at("2026-10-25T00:00:00Z"),
          startedAt: at("2026-10-25T00:00:01Z"),
          completedAt: at("2026-10-25T00:30:00Z"),
        },
        ...(extra.extraRuns ?? []),
      ],
      messages: [
        { id: "request-1", runId: "run-1", role: "user", createdAt: at("2026-10-25T00:00:00Z") },
        ...(extra.steer
          ? [{ id: "steer-1", runId: "run-1", role: "user", createdAt: at("2026-10-25T00:10:00Z") }]
          : []),
        {
          id: "answer-1",
          runId: "run-1",
          role: "assistant",
          createdAt: at("2026-10-25T00:30:00Z"),
        },
        ...(extra.laterMessage
          ? [{ id: "request-2", runId: null, role: "user", createdAt: at("2026-10-25T01:00:00Z") }]
          : []),
      ],
    }) as unknown as Parameters<typeof currentLifecycleRequest>[0];

  it("binds the latest completed turn and its acceptance revision", () => {
    expect(currentLifecycleRequest(projection())).toEqual({
      requestId: "request-1",
      runId: "run-1",
      acceptanceRevision: "run-1",
      requestedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(currentLifecycleRequest(projection({ runStatus: "running" }))).toBeNull();
    expect(currentLifecycleRequest(projection({ laterMessage: true }))).toBeNull();
  });

  it("keeps a steer into the turn with its request", () => {
    expect(currentLifecycleRequest(projection({ steer: true }))?.runId).toBe("run-1");
  });

  it("binds the turn that ran last and waits while another is pending", () => {
    // A queued turn cancelled before it started never ran.
    expect(
      currentLifecycleRequest(
        projection({
          extraRuns: [
            { id: "run-2", ordinal: 2, status: "cancelled", startedAt: null, completedAt: null },
          ],
        }),
      )?.runId,
    ).toBe("run-1");
    // A delegated completion delivered before an older queued request ran last.
    expect(
      currentLifecycleRequest(
        projection({
          extraRuns: [
            {
              id: "run-0",
              ordinal: 0,
              status: "completed",
              userMessageId: "request-1",
              requestedAt: at("2026-10-24T23:00:00Z"),
              startedAt: at("2026-10-25T00:40:00Z"),
              completedAt: at("2026-10-25T00:50:00Z"),
            },
          ],
        }),
      )?.runId,
    ).toBe("run-0");
    expect(
      currentLifecycleRequest(
        projection({ extraRuns: [{ id: "run-2", ordinal: 2, status: "queued" }] }),
      ),
    ).toBeNull();
  });

  const bound = { ...request, requestedAt: "2026-10-25T00:00:00Z" };
  it("names owned waits, the most urgent first, and never shows superseded evidence", () => {
    const waits: LifecycleObligation[] = [
      {
        kind: "resource",
        reason: "ENOSPC stopped the test run.",
        owner: "cleanup-owner",
        nextEvent: "verify free space",
        needsUserOutput: false,
      },
      {
        kind: "user_action",
        reason: "Choose the release channel.",
        owner: "Anton",
        nextEvent: "his answer",
        needsUserOutput: true,
      },
    ];
    const status = lifecycleDeliveryStatus({ ...ready, obligations: waits }, bound, now);
    expect(status?.title).toBe("Waiting on you");
    expect(status?.lines).toEqual([
      "Operational wait: ENOSPC stopped the test run. Owner: cleanup-owner. Next: verify free space.",
      "Choose the release channel. Owner: Anton. Next: his answer.",
    ]);
    expect(lifecycleDeliveryStatus(ready, null, now)).toBeNull();
    expect(lifecycleDeliveryStatus(null, bound, now)).toBeNull();
    expect(lifecycleDeliveryStatus(ready, { ...bound, runId: "run-2" }, now)).toBeNull();
  });

  it("reports verified, expired and pending gates", () => {
    expect(lifecycleDeliveryStatus(ready, bound, now)?.tone).toBe("verified");
    expect(
      lifecycleDeliveryStatus({ ...ready, validUntil: "2026-10-25T01:45:00Z" }, bound, now)?.title,
    ).toBe("Delivery evidence expired");
    expect(
      lifecycleDeliveryStatus(
        { ...ready, deployment: { status: "pending", reason: "Release held" } },
        bound,
        now,
      ),
    ).toEqual({
      tone: "unverified",
      title: "Delivery not verified",
      lines: ["Deployment: Release held"],
    });
  });
});

describe("goal obligations independent of the latest assignment", () => {
  const goal = {
    id: "disk",
    scope: "Cleanup and activate",
    scopeRevision: "disk-v1",
    obligations: [
      {
        id: "cleanup",
        kind: "dependency" as const,
        reason: "Remove eligible worktrees",
        owner: "HOME-DISK",
        nextEvent: "Removal receipt",
        needsUserOutput: false,
        completion: { status: "pending" as const, reason: "Still required" },
      },
    ],
  };
  it("keeps pending goal owner/reason visible after a new run supersedes the receipt", () => {
    const restored = JSON.parse(JSON.stringify({ ...ready, goal }));
    for (const bound of [null, { ...request, runId: "new-run" }]) {
      const status = lifecycleDeliveryStatus(restored, bound, now);
      expect(status?.title).toBe("Goal still open");
      expect(status?.lines.join(" ")).toContain("HOME-DISK");
    }
    expect(decide({ ...ready, goal })).toBe("outstanding_obligations");
  });
  it("requires goal-revision evidence, not N/A or a future/malformed reference", () => {
    for (const completion of [
      { status: "not_applicable" as const, rationale: "Source milestone complete" },
      { ...evidence, scopeRevision: "source-only" },
      { ...evidence, scopeRevision: goal.scopeRevision, observedAt: "invalid" },
      { ...evidence, scopeRevision: goal.scopeRevision, observedAt: "2026-10-26T01:00:00Z" },
      { ...evidence, scopeRevision: goal.scopeRevision, reference: " " },
    ])
      expect(
        pendingLifecycleGoalObligations(
          { ...goal, obligations: [{ ...goal.obligations[0]!, completion }] },
          now,
        ),
      ).toHaveLength(1);
    expect(
      pendingLifecycleGoalObligations(
        {
          ...goal,
          obligations: [
            {
              ...goal.obligations[0]!,
              completion: { ...evidence, scopeRevision: goal.scopeRevision },
            },
          ],
        },
        now,
      ),
    ).toEqual([]);
  });
  it("inherits omitted goals and permits explicit valid requirement updates", () => {
    expect(lifecycleGoalUpdateError(goal, undefined, now)).toBeNull();
    expect(lifecycleGoalUpdateError(goal, { ...goal, obligations: [] }, now)).not.toBeNull();
    expect(lifecycleGoalUpdateError(goal, { ...goal, scope: "Source only" }, now)).not.toBeNull();
    expect(
      lifecycleGoalUpdateError(
        goal,
        {
          ...goal,
          obligations: [
            {
              ...goal.obligations[0]!,
              completion: { ...evidence, scopeRevision: goal.scopeRevision },
            },
          ],
        },
        now,
      ),
    ).toBeNull();
    expect(pendingLifecycleGoalObligations(undefined, now)).toEqual([]);
  });
});

it("decodes legacy receipts without inventing goal evidence and round-trips optional goals", () => {
  const decode = Schema.decodeUnknownSync(LifecycleReceiptSchema);
  expect(decode(ready)).toEqual(ready);
  expect(decode(ready).goal).toBeUndefined();
  const goal = {
    id: "disk",
    scope: "Cleanup",
    scopeRevision: "goal-1",
    obligations: [
      {
        id: "cleanup",
        kind: "dependency",
        reason: "Retire worktrees",
        owner: "HOME-DISK",
        nextEvent: "Removal receipt",
        needsUserOutput: false,
        completion: { status: "pending", reason: "Not removed" },
      },
    ],
  };
  expect(decode(JSON.parse(JSON.stringify({ ...ready, goal }))).goal).toEqual(goal);
  expect(() => decode({ ...ready, goal: { ...goal, obligations: [] } })).toThrow();
  expect(() =>
    decode({
      ...ready,
      goal: {
        ...goal,
        obligations: [{ ...goal.obligations[0], completion: { status: "verified" } }],
      },
    }),
  ).toThrow();
});

it("future goal evidence cannot mature with time without a new valid report", () => {
  const goal = {
    id: "disk",
    scope: "Cleanup",
    scopeRevision: "goal-1",
    obligations: [
      {
        id: "cleanup",
        kind: "dependency" as const,
        reason: "Retire worktrees",
        owner: "HOME-DISK",
        nextEvent: "Removal receipt",
        needsUserOutput: false,
        completion: { ...evidence, scopeRevision: "goal-1", observedAt: "2026-10-25T03:00:00Z" },
      },
    ],
  };
  expect(lifecycleGoalUpdateError(undefined, goal, now)).not.toBeNull();
  const future = Date.parse("2026-10-25T04:00:00Z");
  expect(evaluateLifecycleEvidence(request, { ...ready, goal }, future)).toBe(
    "outstanding_obligations",
  );
  expect(lifecycleDeliveryStatus({ ...ready, goal }, request, future)?.title).toBe(
    "Goal still open",
  );
});
