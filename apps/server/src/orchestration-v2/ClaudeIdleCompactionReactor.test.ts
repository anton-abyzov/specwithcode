import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import * as ServerSettingsModule from "../serverSettings.ts";
import {
  ClaudeIdleCompactionReactor,
  claudeIdleCompactionPolicy,
  idleCompactMinTokens,
  idleCompactionUsedTokens,
  isIdleCompactionCandidate,
  layer,
} from "./ClaudeIdleCompactionReactor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

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

// The policy merges process.env beneath the instance environment, so cache and
// minimum variables inherited from the host shell would decide these cases.
function clearHostCacheVariables() {
  const HOST_VARIABLES = [
    "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS",
    "CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL",
    "CLAUDE_CODE_PROMPT_CACHE_TTL",
    "DISABLE_PROMPT_CACHING",
    "ENABLE_PROMPT_CACHING_1H",
    "FORCE_PROMPT_CACHING_5M",
  ];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of HOST_VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

describe("idle compaction policy", () => {
  clearHostCacheVariables();

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

  it("stays off when the thread's cache lives 5 minutes or not at all", () => {
    const withEnvironment = (name: string, value: string) =>
      claudeIdleCompactionPolicy(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            claude_api: {
              driver: "claudeAgent",
              environment: [{ name, value, sensitive: false }],
              config: {},
            },
          } as never,
        },
        ProviderInstanceId.make("claude_api"),
      );
    expect(withEnvironment("FORCE_PROMPT_CACHING_5M", "1")).toBeNull();
    expect(withEnvironment("CLAUDE_CODE_PROMPT_CACHE_TTL", "5m")).toBeNull();
    expect(withEnvironment("ENABLE_PROMPT_CACHING_1H", "0")).toBeNull();
    expect(withEnvironment("DISABLE_PROMPT_CACHING", "1")).toBeNull();
    expect(withEnvironment("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h")).not.toBeNull();
  });
});

describe("idle compaction sweep", () => {
  clearHostCacheVariables();

  const runId = "run:1";
  const snapshotShell = {
    ...idleThread,
    id: ThreadId.make("thread:idle"),
    projectId: "project:idle",
    latestRunId: runId,
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent") },
  };

  /** Runs one sweep whose snapshot holds `snapshotShell`; returns what was sent. */
  const sweepWithCurrent = (current: object | null) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(minutes(55));
      const sent: Array<string> = [];
      const threads = {
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [snapshotShell],
            archivedThreads: [],
          }),
        getProjectThreadRecords: () =>
          Effect.succeed({
            providerTurns: [
              {
                providerThreadId: "provider-thread-1",
                ordinal: 1,
                status: "completed",
                tokenUsage: { usedTokens: 300_000, updatedAt: "2026-10-15T10:00:00.000Z" },
              },
            ],
            messages: [{ text: "fix the tests" }],
          }),
        getThreadShell: () => Effect.succeed(current),
        sendToThread: (input: { readonly text: string }) =>
          Effect.sync(() => {
            sent.push(input.text);
            return {};
          }),
      } as unknown as ThreadManagementService.ThreadManagementServiceShape;
      yield* Effect.gen(function* () {
        yield* (yield* ClaudeIdleCompactionReactor).sweep;
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
                Layer.succeed(ServerSettingsModule.ServerSettingsService, {
                  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                } as never),
              ),
            ),
          ),
        ),
      );
      return sent;
    });

  it.effect("compacts a thread that is still idle on the same run", () =>
    Effect.gen(function* () {
      expect(yield* sweepWithCurrent(snapshotShell)).toEqual(["/compact"]);
    }),
  );

  it.effect("leaves a thread that moved on after the sweep's snapshot", () =>
    Effect.gen(function* () {
      expect(yield* sweepWithCurrent({ ...snapshotShell, latestRunId: "run:2" })).toEqual([]);
      expect(
        yield* sweepWithCurrent({ ...snapshotShell, settledAt: DateTime.makeUnsafe(minutes(55)) }),
      ).toEqual([]);
      expect(
        yield* sweepWithCurrent({ ...snapshotShell, archivedAt: DateTime.makeUnsafe(minutes(55)) }),
      ).toEqual([]);
      expect(yield* sweepWithCurrent(null)).toEqual([]);
    }),
  );
});
