import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@specweave-studio/contracts";

import { workBoundaryCheckpoint } from "./HandoffModeReactor.ts";

const subagent = (status: string) =>
  ({
    type: "subagent.updated",
    threadId: "thread:parent",
    payload: { id: "node:review", threadId: "thread:parent", status },
  }) as unknown as OrchestrationV2DomainEvent;

describe("work-boundary checkpoints", () => {
  it("checkpoints the parent when a child starts and when its result lands", () => {
    assert.deepEqual(workBoundaryCheckpoint(subagent("pending")), {
      threadId: "thread:parent" as never,
      key: "subagent:node:review:started",
    });
    // Every active status is the same fan-out boundary, so it checkpoints once.
    assert.equal(
      workBoundaryCheckpoint(subagent("running"))?.key,
      workBoundaryCheckpoint(subagent("pending"))?.key,
    );
    for (const status of ["completed", "failed", "cancelled", "interrupted"])
      assert.equal(workBoundaryCheckpoint(subagent(status))?.key, "subagent:node:review:settled");
    assert.isNull(workBoundaryCheckpoint(subagent("idle")));
  });

  it("checkpoints before a provider session retires", () => {
    const detached = {
      type: "provider-session.detached",
      threadId: "thread:parent",
      payload: { providerSessionId: "session:old-account" },
    } as unknown as OrchestrationV2DomainEvent;
    assert.deepEqual(workBoundaryCheckpoint(detached), {
      threadId: "thread:parent" as never,
      key: "session:session:old-account",
    });
  });

  it("leaves runs to the turn-end checkpoint and ignores other events", () => {
    for (const type of ["run.updated", "turn-item.updated", "provider-thread.updated"])
      assert.isNull(
        workBoundaryCheckpoint({
          type,
          threadId: "t",
          payload: {},
        } as unknown as OrchestrationV2DomainEvent),
      );
  });
});
