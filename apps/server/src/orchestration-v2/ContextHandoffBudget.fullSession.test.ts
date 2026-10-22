import { describe, expect, it } from "vite-plus/test";

import { handoffBudget, nativeSessionTooFullForHandoff } from "./ContextHandoffBudget.ts";

const providerThread = (contextUsage: { usedTokens: number; maxTokens?: number } | null) =>
  ({ contextUsage }) as never;

describe("nativeSessionTooFullForHandoff", () => {
  it("replaces the Codex session the DCFC thread reused instead of failing the handoff", () => {
    const full = providerThread({ usedTokens: 221_400, maxTokens: 258_400 });
    const input = {
      tokenCap: 16_000,
      userText: "why are payments all zeros? complete the job!",
      attachments: [],
    };
    // The reused session leaves no allowance: delivery would refuse before choosing history.
    expect(handoffBudget({ ...input, providerThread: full, nativeContextEstimate: 0 })).toBe(0);
    expect(nativeSessionTooFullForHandoff({ ...input, providerThread: full })).toBe(true);
    // A fresh session of the same model takes the capped handoff.
    expect(
      handoffBudget({
        ...input,
        providerThread: providerThread(null),
        nativeContextEstimate: 0,
        modelContextWindow: 258_400,
      }),
    ).toBe(16_000);
  });

  it("keeps a session with room, an unmeasured one, and one a fresh session would not help", () => {
    const input = { tokenCap: 16_000, userText: "next", attachments: [] };
    expect(
      nativeSessionTooFullForHandoff({
        ...input,
        providerThread: providerThread({ usedTokens: 40_000, maxTokens: 258_400 }),
      }),
    ).toBe(false);
    expect(nativeSessionTooFullForHandoff({ ...input, providerThread: providerThread(null) })).toBe(
      false,
    );
    // A request larger than the whole window: a fresh session would refuse it too.
    expect(
      nativeSessionTooFullForHandoff({
        ...input,
        userText: "x".repeat(250_000),
        providerThread: providerThread({ usedTokens: 200_000, maxTokens: 258_400 }),
      }),
    ).toBe(false);
  });
});
