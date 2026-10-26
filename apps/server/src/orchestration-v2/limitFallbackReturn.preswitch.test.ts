import {
  CommandId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../studio/fixtures.ts";
import {
  isLimitWayBack,
  isServerSelectionMove,
  preswitchReturnBlock,
  preswitchReturnCommand,
} from "./limitFallbackReturn.ts";

// 1075: the way back from a usage pre-switch, which has no stopped run to follow.
const nowMs = Date.parse("2026-10-26T12:00:00.000Z");
const resetAt = "2026-10-26T15:00:00.000Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const opus = "claude-opus-5-5";
const preswitchId = `limit-preswitch:t1:${claudeId}:${resetAt}`;
const origin = {
  modelSelection: { instanceId: claudeId, model: opus },
  commandId: CommandId.make(preswitchId),
  resetAt,
};
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitSwitchAtPercent: 90,
  providerLimitWaitUnderMinutes: 0,
  providerLimitExcludedModels: [],
};
const thread = {
  id: ThreadId.make("t1"),
  providerInstanceId: codexId,
  modelSelection: { instanceId: codexId, model: "gpt-6" },
  status: "completed" as const,
  lastErrorClass: null,
  latestRunId: RunId.make("r1"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
};

function claude(windows: ReadonlyArray<{ usedPercent: number; resetsAt: string }>) {
  const base = provider(claudeId, "claudeAgent", nowMs);
  return {
    ...base,
    usageLimits: {
      ...base.usageLimits!,
      windows: windows.map((window) => ({
        id: "five_hour",
        kind: "session" as const,
        label: "Session",
        ...window,
      })),
    },
  } satisfies ServerProvider;
}

const providers = (home: ServerProvider) => [home, provider(codexId, "codex", nowMs)];

describe("preswitchReturnCommand", () => {
  it("goes back once the original reads below the switch threshold", () => {
    expect(
      preswitchReturnCommand(
        thread,
        origin,
        providers(claude([{ usedPercent: 40, resetsAt: resetAt }])),
        rule,
        nowMs,
      ),
    ).toEqual({
      type: "thread.model-selection.set",
      commandId: `limit-preswitch-return:t1:${claudeId}:${resetAt}`,
      threadId: thread.id,
      modelSelection: origin.modelSelection,
    });
  });

  it("stays while the original is at the threshold, though under its limit", () => {
    expect(
      preswitchReturnCommand(
        thread,
        origin,
        providers(claude([{ usedPercent: 92, resetsAt: resetAt }])),
        rule,
        nowMs,
      ),
    ).toBeNull();
  });

  it("goes back once the window it moved in has reset and nothing reads it since", () => {
    const after = Date.parse(resetAt) + 60_000;
    const stale = providers(claude([{ usedPercent: 95, resetsAt: resetAt }]));
    expect(preswitchReturnCommand(thread, origin, stale, rule, after)?.commandId).toBe(
      `limit-preswitch-return:t1:${claudeId}:${resetAt}`,
    );
    // A fresh read of the next window at the threshold keeps it on the fallback.
    const next = providers(claude([{ usedPercent: 95, resetsAt: "2026-10-26T20:00:00.000Z" }]));
    expect(preswitchReturnCommand(thread, origin, next, rule, after)).toBeNull();
  });

  it("goes back below the limit once the rule no longer switches", () => {
    expect(
      preswitchReturnCommand(
        thread,
        origin,
        providers(claude([{ usedPercent: 92, resetsAt: resetAt }])),
        { ...rule, providerLimitAction: "ask" as const },
        nowMs,
      ),
    ).not.toBeNull();
  });

  it("never moves a busy, failed, settled or already-home thread, and numbers retries", () => {
    const room = providers(claude([{ usedPercent: 10, resetsAt: resetAt }]));
    expect(
      preswitchReturnCommand(
        { ...thread, activeRunId: RunId.make("r2") },
        origin,
        room,
        rule,
        nowMs,
      ),
    ).toBeNull();
    expect(
      preswitchReturnCommand({ ...thread, status: "failed" }, origin, room, rule, nowMs),
    ).toBeNull();
    expect(
      preswitchReturnCommand({ ...thread, settledOverride: "settled" }, origin, room, rule, nowMs),
    ).toBeNull();
    expect(
      preswitchReturnCommand(
        { ...thread, providerInstanceId: claudeId, modelSelection: origin.modelSelection },
        origin,
        room,
        rule,
        nowMs,
      ),
    ).toBeNull();
    expect(preswitchReturnCommand(thread, origin, room, rule, nowMs, 2)?.commandId).toBe(
      `limit-preswitch-return:t1:${claudeId}:${resetAt}:2`,
    );
  });

  it("never returns to an excluded, per-token or Gemini origin, and says why", () => {
    const room = claude([{ usedPercent: 10, resetsAt: resetAt }]);
    const excluded = { ...rule, providerLimitExcludedModels: [{ model: opus }] };
    expect(preswitchReturnBlock(origin, providers(room), excluded)).toBe("excluded");
    expect(preswitchReturnCommand(thread, origin, providers(room), excluded, nowMs)).toBeNull();

    const apiKey = { ...room, auth: { ...room.auth, type: "apiKey" } };
    expect(preswitchReturnBlock(origin, providers(apiKey), rule)).toBe("per-token");
    expect(preswitchReturnCommand(thread, origin, providers(apiKey), rule, nowMs)).toBeNull();

    const geminiId = ProviderInstanceId.make("acpRegistry_gemini");
    const gemini = { ...provider(geminiId, "acpRegistry", nowMs), usageLimits: room.usageLimits };
    const geminiOrigin = { ...origin, modelSelection: { instanceId: geminiId, model: "gemini-3" } };
    expect(preswitchReturnBlock(geminiOrigin, [gemini], rule)).toBe("gemini");
    expect(preswitchReturnCommand(thread, geminiOrigin, [gemini], rule, nowMs)).toBeNull();

    expect(preswitchReturnBlock(origin, providers(room), rule)).toBeNull();
  });
});

describe("the pre-switch way back's command id", () => {
  it("is a way back, so the queued sends go home with the thread", () => {
    const id = `limit-preswitch-return:t1:${claudeId}:${resetAt}`;
    expect(isLimitWayBack(id)).toBe(true);
    expect(isServerSelectionMove(id)).toBe(true);
    expect(isLimitWayBack(preswitchId)).toBe(false);
  });
});
