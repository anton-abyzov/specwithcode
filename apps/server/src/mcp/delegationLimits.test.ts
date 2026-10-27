import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@specweave-studio/contracts";

import {
  DEFAULT_DELEGATION_LIMITS,
  delegationParentId,
  delegationLimitRefusal,
} from "./delegationLimits.ts";

const child = (id: string, parent: string | null) => ({
  id: ThreadId.make(id),
  lineage: {
    rootThreadId: ThreadId.make(id),
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    relationshipToParent: parent === null ? null : ("subagent" as const),
  },
});

describe("delegationParentId", () => {
  it("returns the parent of a subagent", () => {
    assert.equal(delegationParentId(child("a", "b"), new Set()), ThreadId.make("b"));
  });
  it("stops at a root or a thread nobody delegated", () => {
    assert.isNull(delegationParentId(child("a", null), new Set()));
    assert.isNull(delegationParentId({ id: ThreadId.make("a") }, new Set()));
  });
  it("stops on a cycle", () => {
    assert.isNull(delegationParentId(child("a", "b"), new Set([ThreadId.make("b")])));
  });
});

describe("delegationLimitRefusal", () => {
  const limits = DEFAULT_DELEGATION_LIMITS;
  it("allows the last child under each limit", () => {
    assert.isNull(
      delegationLimitRefusal({
        liveChildren: limits.maxLiveChildTasks - 1,
        parentDepth: limits.maxDepth - 1,
        limits,
      }),
    );
  });
  it("refuses at each limit", () => {
    assert.include(
      delegationLimitRefusal({ liveChildren: limits.maxLiveChildTasks, parentDepth: 0, limits }),
      "Delegation limit reached",
    );
    assert.include(
      delegationLimitRefusal({ liveChildren: 0, parentDepth: limits.maxDepth, limits }),
      "Delegation limit reached",
    );
  });
});
