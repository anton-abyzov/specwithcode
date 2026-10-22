import { NodeId, RunId, RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  isBlockingRuntimeRequest,
  openMessageQuestionIds,
  openQuestionReminder,
  pendingRequestDetailMemo,
  type PendingRequestSummary,
  withPendingRequestDetail,
} from "./blockingRuntimeRequest.ts";

/** A shell summary: the request's id and kind, without its detail. */
const summaryOf = (
  id: string,
): { readonly pendingRuntimeRequest: PendingRequestSummary & { readonly id: string } } => ({
  pendingRuntimeRequest: { id: RuntimeRequestId.make(id), kind: "user_input" },
});

const r1 = RunId.make("r1");
const request = (
  id: string,
  capability: "message" | "live",
  nodeId: string,
  kind: "user_input" | "command" = "user_input",
) => ({
  id: RuntimeRequestId.make(id),
  kind,
  status: "pending" as const,
  nodeId: NodeId.make(nodeId),
  responseCapability:
    capability === "message"
      ? ({ type: "message" } as const)
      : ({ type: "live", providerSessionId: "provider-session:1" } as never),
});

describe("a request that belongs to no run", () => {
  it("holds the thread, as the candidate read takes it", () => {
    // A node that names no run, and no run it is the root of.
    const nodes = [{ id: NodeId.make("orphan"), runId: null }];
    expect(
      isBlockingRuntimeRequest({ runtimeRequests: [request("q1", "live", "orphan")], nodes }, r1),
    ).toBe(true);
    expect(
      isBlockingRuntimeRequest(
        { pendingRuntimeRequest: { kind: "command", responseCapability: undefined, runId: null } },
        r1,
      ),
    ).toBe(true);
    // A question the next message answers still holds nothing.
    expect(
      isBlockingRuntimeRequest(
        { runtimeRequests: [request("q2", "message", "orphan")], nodes },
        r1,
      ),
    ).toBe(false);
  });

  it("belongs to the run it is the root of when its node names none", () => {
    const records = {
      runtimeRequests: [request("q1", "live", "r0-root")],
      nodes: [{ id: NodeId.make("r0-root"), runId: null }],
      runs: [{ id: RunId.make("r0"), rootNodeId: NodeId.make("r0-root") }],
    };
    // Left behind by an earlier run, so it holds nothing now.
    expect(isBlockingRuntimeRequest(records, r1)).toBe(false);
    const shell = summaryOf("q1");
    expect(withPendingRequestDetail(shell, records).pendingRuntimeRequest?.runId).toBe("r0");
  });

  it("is carried as null by the summary detail, so it keeps holding", () => {
    const shell = summaryOf("q1");
    const detailed = withPendingRequestDetail(shell, {
      runtimeRequests: [request("q1", "live", "orphan")],
      nodes: [{ id: NodeId.make("orphan"), runId: null }],
    });
    expect(detailed.pendingRuntimeRequest?.runId).toBeNull();
    expect(isBlockingRuntimeRequest(detailed, r1)).toBe(true);
  });
});

describe("an open question a continuation repeats", () => {
  const thread = {
    runtimeRequests: [
      request("asked", "message", "r1-root"),
      request("live", "live", "r1-root"),
      request("earlier", "message", "r0-root"),
      { ...request("answered", "message", "r1-root"), status: "resolved" as const },
    ],
    nodes: [{ id: NodeId.make("r0-root"), runId: RunId.make("r0") }],
    runs: [{ id: r1, rootNodeId: NodeId.make("r1-root") }],
  };

  it("is a pending question of the continued run answered by message", () => {
    expect(openMessageQuestionIds(thread, r1)).toEqual(["asked"]);
    expect(openMessageQuestionIds(thread, RunId.make("r0"))).toEqual(["earlier"]);
  });

  it("is repeated word for word, and marked as not the answer", () => {
    const text = openQuestionReminder([{ question: "Ship the build to TestFlight now?" }]);
    expect(text).toContain("still unanswered");
    expect(text).toContain("- Ship the build to TestFlight now?");
    expect(text).toContain("This message is not their answer.");
    expect(openQuestionReminder([])).toBe("");
  });
});

describe("the request detail memo", () => {
  const at = (ms: number) => DateTime.makeUnsafe(ms);
  const thread = {
    id: ThreadId.make("t1"),
    latestRunId: r1,
    updatedAt: at(1_000),
    pendingRuntimeRequest: { id: "q1" },
  };

  it("serves a detail only while the thread is unchanged", () => {
    const memo = pendingRequestDetailMemo<string>();
    memo.set(thread, "blocking");
    expect(memo.get(thread)).toBe("blocking");
    // Another request answered or raised moves the thread's updatedAt.
    expect(memo.get({ ...thread, updatedAt: at(2_000) })).toBeUndefined();
    expect(memo.get({ ...thread, pendingRuntimeRequest: { id: "q2" } })).toBeUndefined();
    expect(memo.get({ ...thread, latestRunId: RunId.make("r2") })).toBeUndefined();
    // One entry per thread: a newer read replaces the older one.
    memo.set({ ...thread, updatedAt: at(2_000) }, "free");
    expect(memo.size).toBe(1);
    expect(memo.get(thread)).toBeUndefined();
  });

  it("drops threads the sweep no longer lists", () => {
    const memo = pendingRequestDetailMemo<string>();
    memo.set(thread, "blocking");
    memo.set({ ...thread, id: ThreadId.make("t2") }, "free");
    memo.retain(["t2"]);
    expect(memo.size).toBe(1);
    expect(memo.get(thread)).toBeUndefined();
    expect(memo.get({ ...thread, id: ThreadId.make("t2") })).toBe("free");
  });
});
