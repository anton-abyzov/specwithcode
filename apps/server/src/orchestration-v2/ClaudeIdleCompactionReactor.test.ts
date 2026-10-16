import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import {
  claudeIdleCompactionPolicy,
  idleCompactMinTokens,
  idleCompactionUsedTokens,
  isIdleCompactionCandidate,
} from "./ClaudeIdleCompactionReactor.ts";

const completedAt = Date.parse("2026-10-15T10:00:00.000Z");
const idleThread = {
  archivedAt: null,
  status: "idle" as const,
  activeRunId: null,
  pendingRuntimeRequest: null,
  activeProviderThreadId: "provider-thread-1" as never,
  latestRunCompletedAt: DateTime.makeUnsafe(completedAt),
  settledAt: null,
  settledOverride: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t") },
};
const minutes = (value: number) => completedAt + value * 60_000;

describe("isIdleCompactionCandidate", () => {
  it("fires only in the window before the hour-long cache lapses", () => {
    expect(isIdleCompactionCandidate(idleThread, minutes(30))).toBe(false);
    expect(isIdleCompactionCandidate(idleThread, minutes(54))).toBe(true);
    expect(isIdleCompactionCandidate(idleThread, minutes(58))).toBe(true);
    expect(isIdleCompactionCandidate(idleThread, minutes(59))).toBe(false);
    expect(isIdleCompactionCandidate(idleThread, minutes(120))).toBe(false);
  });

  it("leaves busy, archived, settled and subagent threads alone", () => {
    const at = minutes(55);
    expect(isIdleCompactionCandidate({ ...idleThread, status: "running" }, at)).toBe(false);
    expect(isIdleCompactionCandidate({ ...idleThread, activeRunId: "run" as never }, at)).toBe(
      false,
    );
    expect(
      isIdleCompactionCandidate({ ...idleThread, pendingRuntimeRequest: {} as never }, at),
    ).toBe(false);
    expect(
      isIdleCompactionCandidate({ ...idleThread, archivedAt: DateTime.makeUnsafe(at) }, at),
    ).toBe(false);
    expect(
      isIdleCompactionCandidate({ ...idleThread, settledAt: DateTime.makeUnsafe(at) }, at),
    ).toBe(false);
    expect(
      isIdleCompactionCandidate(
        { ...idleThread, settledAt: DateTime.makeUnsafe(at), settledOverride: "active" },
        at,
      ),
    ).toBe(true);
    expect(
      isIdleCompactionCandidate(
        {
          ...idleThread,
          lineage: { ...idleThread.lineage, relationshipToParent: "subagent" },
        },
        at,
      ),
    ).toBe(false);
  });
});

describe("idleCompactionUsedTokens", () => {
  const turn = (ordinal: number, usedTokens: number, providerThreadId = "provider-thread-1") => ({
    providerThreadId: providerThreadId as never,
    ordinal,
    status: "completed" as const,
    tokenUsage: { usedTokens, updatedAt: "2026-10-15T10:00:00.000Z" },
  });

  it("reads the last finished turn on the active provider thread", () => {
    expect(
      idleCompactionUsedTokens(
        [turn(1, 50_000), turn(3, 111_000), turn(2, 90_000), turn(4, 400_000, "other")],
        "provider-thread-1",
        "fix the tests",
      ),
    ).toBe(111_000);
  });

  it("skips a thread whose last turn was already a compaction", () => {
    expect(idleCompactionUsedTokens([turn(1, 300_000)], "provider-thread-1", " /Compact ")).toBe(
      null,
    );
  });
});

describe("idle compaction policy", () => {
  it("never goes below Claude Code's 100K floor", () => {
    expect(idleCompactMinTokens(undefined)).toBe(100_000);
    expect(idleCompactMinTokens("50000")).toBe(100_000);
    expect(idleCompactMinTokens("250000")).toBe(250_000);
    expect(idleCompactMinTokens("nope")).toBe(100_000);
  });

  it("is on by default for Claude and can be turned off", () => {
    expect(
      claudeIdleCompactionPolicy(DEFAULT_SERVER_SETTINGS, ProviderInstanceId.make("claudeAgent")),
    ).toEqual({
      minTokens: idleCompactMinTokens(process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS),
    });
    expect(
      claudeIdleCompactionPolicy(DEFAULT_SERVER_SETTINGS, ProviderInstanceId.make("codex")),
    ).toBeNull();
    expect(
      claudeIdleCompactionPolicy(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            claudeAgent: {
              ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
              idleCompaction: false,
            },
          },
        },
        ProviderInstanceId.make("claudeAgent"),
      ),
    ).toBeNull();
  });

  it("reads the minimum from the instance environment", () => {
    expect(
      claudeIdleCompactionPolicy(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              environment: [
                { name: "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", value: "200000", sensitive: false },
              ],
              config: {},
            },
          } as never,
        },
        ProviderInstanceId.make("claude_work"),
      ),
    ).toEqual({ minTokens: 200_000 });
  });
});
