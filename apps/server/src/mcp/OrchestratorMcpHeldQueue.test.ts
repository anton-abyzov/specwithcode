import { describe, expect, it } from "vite-plus/test";

import { heldQueuedMessagesField, threadSendHeldQueueReport } from "./OrchestratorMcpService.ts";

const held = { status: "queued", queueHeld: true } as const;
const waiting = { status: "queued", queueHeld: false } as const;
const running = { status: "running" } as const;

describe("held queues in MCP results", () => {
  it("tells a sender its message joined a held queue and was not delivered", () => {
    // The release worker's 13 handoffs: each send queued behind a hold and said nothing.
    const report = threadSendHeldQueueReport({
      run: held,
      runs: [running, ...Array.from({ length: 13 }, () => held)],
      releasedHeldMessages: 0,
    });
    expect(report.queueHeld).toBe(true);
    expect(report.heldQueuedMessages).toBe(13);
    expect(report.notice).toMatch(/^Not delivered: this thread's queue is held \(12 queued/);
    expect(report.notice).toContain("studio_queue_resume");
  });

  it("says which held messages a send released, and stays quiet otherwise", () => {
    const released = threadSendHeldQueueReport({
      run: running,
      runs: [running, waiting, waiting],
      releasedHeldMessages: 2,
    });
    expect(released).toEqual({
      releasedHeldMessages: 2,
      notice: "2 queued messages held on this thread will run after this one, in order.",
    });
    const stillHeld = threadSendHeldQueueReport({
      run: running,
      runs: [running, held],
      releasedHeldMessages: 0,
    });
    expect(stillHeld.heldQueuedMessages).toBe(1);
    expect(stillHeld.queueHeld).toBeUndefined();
    expect(
      threadSendHeldQueueReport({
        run: waiting,
        runs: [running, waiting],
        releasedHeldMessages: 0,
      }),
    ).toEqual({});
  });

  it("counts held messages for thread reads and task status, omitting zero", () => {
    expect(heldQueuedMessagesField([running, held, held, waiting])).toEqual({
      heldQueuedMessages: 2,
    });
    expect(heldQueuedMessagesField([running, waiting])).toEqual({});
  });
});
