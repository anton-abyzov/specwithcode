import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";

import { callerLiveness, type CallerLivenessInput } from "./McpCallerLiveness.ts";

const threadId = ThreadId.make("thread-1");
const codex = ProviderInstanceId.make("codex");

const input = (thread: Partial<CallerLivenessInput["thread"]> = {}): CallerLivenessInput => ({
  thread: { id: threadId, archivedAt: null, providerInstanceId: codex, ...thread },
  activeTurnProviderInstanceId: codex,
  caller: { threadId, providerSessionId: "session-1", providerInstanceId: codex },
});

describe("callerLiveness and handoff mode", () => {
  it("lets the provider of the live turn act", () => {
    expect(callerLiveness(input())).toEqual({ live: true, turn: "active" });
  });

  it("refuses a copy that handed off, even during its live turn", () => {
    const verdict = callerLiveness(input({ movedTo: { kind: "handoff" } }));
    expect(verdict.live).toBe(false);
    expect(!verdict.live && verdict.code).toBe("thread_fenced");
    expect(!verdict.live && verdict.message).toContain("on another machine");
  });

  it("names the machine a fenced thread runs on", () => {
    const verdict = callerLiveness(
      input({ executionState: "fenced", executionMachineLabel: "Minis" }),
    );
    expect(!verdict.live && verdict.code).toBe("thread_fenced");
    expect(!verdict.live && verdict.message).toContain("on Minis");
  });

  it("does not fence a project move or an unknown execution machine", () => {
    expect(callerLiveness(input({ movedTo: { kind: "project" } })).live).toBe(true);
    expect(callerLiveness(input({ executionState: "unknown" })).live).toBe(true);
  });

  it("reports an archived thread before the fence", () => {
    const verdict = callerLiveness(
      input({ archivedAt: "2026-10-20T14:00:00.000Z", movedTo: { kind: "handoff" } }),
    );
    expect(!verdict.live && verdict.code).toBeUndefined();
    expect(!verdict.live && verdict.message).toContain("archived");
  });
});
