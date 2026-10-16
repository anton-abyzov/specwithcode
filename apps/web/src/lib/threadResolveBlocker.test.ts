import { describe, expect, it } from "vite-plus/test";

import { describeThreadResolveBlocker, threadStopAndResolveMessage } from "./threadResolveBlocker";

const NOW = Date.parse("2026-10-15T15:00:00.000Z");

function shell(overrides: Partial<Parameters<typeof describeThreadResolveBlocker>[0]> = {}) {
  return {
    title: "SpecWithCode logo",
    runtime: null,
    hasPendingApprovals: false,
    ...overrides,
  } as Parameters<typeof describeThreadResolveBlocker>[0];
}

function runtime(status: string, activityStartedAt: string | null = null) {
  return {
    status,
    activeRunId: null,
    activityStartedAt,
    providerInstanceId: "grok",
    providerName: "Grok",
    lastError: null,
    updatedAt: "2026-10-15T06:06:48.362Z",
  } as never;
}

describe("describeThreadResolveBlocker", () => {
  it("returns null for an idle thread", () => {
    expect(describeThreadResolveBlocker(shell(), NOW)).toBeNull();
    expect(describeThreadResolveBlocker(shell({ runtime: runtime("completed") }), NOW)).toBeNull();
  });

  it("names a long-running turn with its age", () => {
    expect(
      describeThreadResolveBlocker(
        shell({ runtime: runtime("running", "2026-10-15T06:36:00.000Z") }),
        NOW,
      ),
    ).toBe("A turn has been running for 8 hr 24 min");
  });

  it("joins a running turn and a waiting approval", () => {
    expect(
      describeThreadResolveBlocker(
        shell({ runtime: runtime("running"), hasPendingApprovals: true }),
        NOW,
      ),
    ).toBe("A turn is still running and an approval is waiting for you");
  });

  it("builds a confirm message without raw ids", () => {
    const message = threadStopAndResolveMessage(shell(), "A turn is still running");
    expect(message).toContain('Stop and resolve "SpecWithCode logo"?');
    expect(message).toContain("A turn is still running.");
    expect(message).not.toContain("thread:");
  });
});
