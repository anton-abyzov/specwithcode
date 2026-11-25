import {
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
  launchReturnCommand,
} from "./limitFallbackReturn.ts";

// 1339: a worker that started on a stand-in goes back to its pick once the pick has room.
const nowMs = Date.parse("2026-11-17T12:00:00.000Z");
const resetAt = "2026-11-17T15:00:00.000Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const home = { instanceId: claudeId, model: "claude-opus-5-5" };
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitSwitchAtPercent: 90,
  providerLimitWaitUnderMinutes: 0,
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

function claude(usedPercent: number): ServerProvider {
  const base = provider(claudeId, "claudeAgent", nowMs);
  return {
    ...base,
    models: [{ slug: home.model, name: "Opus 5.5", isCustom: false, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt: resetAt },
      ],
    },
  };
}
const providers = (pick: ServerProvider) => [pick, provider(codexId, "codex", nowMs)];

describe("launchReturnCommand", () => {
  it("moves the idle thread back to its pick once a read shows room", () => {
    const command = launchReturnCommand(thread, home, providers(claude(40)), rule, nowMs);
    expect(command).toEqual({
      type: "thread.model-selection.set",
      commandId: `limit-launch-return:t1:${claudeId}/${home.model}`,
      threadId: thread.id,
      modelSelection: home,
    });
    // A server move: queued sends follow it, and it never reads as a pick.
    expect(isLimitWayBack(command!.commandId)).toBe(true);
    expect(isServerSelectionMove(command!.commandId)).toBe(true);
    expect(
      launchReturnCommand(thread, home, providers(claude(40)), rule, nowMs, 2)?.commandId,
    ).toBe(`limit-launch-return:t1:${claudeId}/${home.model}:2`);
  });

  it("stays while the pick is at the switch threshold or out of room", () => {
    expect(launchReturnCommand(thread, home, providers(claude(95)), rule, nowMs)).toBeNull();
    expect(launchReturnCommand(thread, home, providers(claude(100)), rule, nowMs)).toBeNull();
    // Under `wait` only a spent window keeps it.
    const wait = { ...rule, providerLimitAction: "wait" as const };
    expect(launchReturnCommand(thread, home, providers(claude(95)), wait, nowMs)).not.toBeNull();
  });

  it("never moves a busy, failed or settled thread", () => {
    const pick = providers(claude(40));
    expect(
      launchReturnCommand({ ...thread, activeRunId: RunId.make("r2") }, home, pick, rule, nowMs),
    ).toBeNull();
    expect(
      launchReturnCommand({ ...thread, status: "failed" }, home, pick, rule, nowMs),
    ).toBeNull();
    expect(
      launchReturnCommand({ ...thread, settledOverride: "settled" }, home, pick, rule, nowMs),
    ).toBeNull();
    expect(
      launchReturnCommand({ ...thread, modelSelection: home }, home, pick, rule, nowMs),
    ).toBeNull();
  });

  it("requires a usage reading or positive evidence that the pick is unmetered", () => {
    const unread = { ...claude(40), usageLimits: undefined };
    const unmetered = {
      ...claude(40),
      usageLimits: {
        ...claude(40).usageLimits!,
        windows: [],
        unavailable: { reason: "unsupported", unmetered: true },
      },
    } as ServerProvider;
    // At launch the pick was held (a limit stop no read shows): it stays.
    const held = new Set<string>([claudeId]);
    expect(launchReturnCommand(thread, home, providers(unread), rule, nowMs, 0, held)).toBeNull();
    // A denial the provider reports keeps it too.
    const denied = {
      ...claude(40),
      usageLimits: { ...claude(40).usageLimits!, windows: [], ordinaryUsageAllowed: false },
    } as ServerProvider;
    expect(launchReturnCommand(thread, home, providers(denied), rule, nowMs)).toBeNull();
    // Once the hold clears, the idle thread goes back.
    expect(launchReturnCommand(thread, home, providers(unread), rule, nowMs)).toBeNull();
    expect(
      launchReturnCommand(thread, home, providers(unmetered), rule, nowMs)?.modelSelection,
    ).toEqual(home);
    // Never onto a pick that cannot take a turn.
    const notReady = { ...unread, status: "error" } as ServerProvider;
    expect(launchReturnCommand(thread, home, providers(notReady), rule, nowMs)).toBeNull();
  });

  it("goes back to Muse, which reports no usage, once nothing holds it", () => {
    const museId = ProviderInstanceId.make("muse");
    const pick = { instanceId: museId, model: "muse-wonder-full-1.0" };
    const muse: ServerProvider = {
      ...provider(museId, "muse", nowMs),
      models: [{ slug: pick.model, name: "Muse Wonder Full", isCustom: false, capabilities: null }],
      usageLimits: undefined,
    };
    const both = [muse, provider(codexId, "codex", nowMs)];
    expect(launchReturnCommand(thread, pick, both, rule, nowMs)?.modelSelection).toEqual(pick);
    expect(launchReturnCommand(thread, pick, both, rule, nowMs, 0, new Set([museId]))).toBeNull();
  });

  it("never goes back to a metered pick whose usage read failed or ran out", () => {
    const failed = {
      ...claude(40),
      usageLimits: {
        ...claude(40).usageLimits!,
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    } as ServerProvider;
    expect(launchReturnCommand(thread, home, providers(failed), rule, nowMs)).toBeNull();
    // A full window whose reset passed with no newer read is no proof of room.
    const expired = claude(100);
    const afterReset = Date.parse(resetAt) + 60_000;
    expect(launchReturnCommand(thread, home, providers(expired), rule, afterReset)).toBeNull();
  });
});
