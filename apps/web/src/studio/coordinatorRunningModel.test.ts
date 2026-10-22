import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveCoordinatorTurnSelection } from "@specweave-studio/shared/providerFallback";

import { coordinatorModelDisplay, type CoordinatorRunSummary } from "./coordinatorRunningModel";

const nowMs = Date.parse("2026-10-21T12:00:00.000Z");
const resetsAt = "2026-10-26T20:00:00.000Z";

function provider(id: string, weeklyUsed: number | null): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-21T11:59:00.000Z",
    version: null,
    models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(weeklyUsed === null
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-10-21T11:59:00.000Z",
            windows: [
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: weeklyUsed, resetsAt },
            ],
          },
        }),
  } as ServerProvider;
}

const select = (instanceId: string, model: string): ModelSelection =>
  ({ instanceId: ProviderInstanceId.make(instanceId), model }) as ModelSelection;
const codex = select("codex", "gpt-6.1-sol");
const copilot = select("copilot", "gpt-6.1-sol");
const claude = select("claudeAgent", "claude-opus-5-5");

const run = (
  ordinal: number,
  selection: ModelSelection,
  status: CoordinatorRunSummary["status"],
): CoordinatorRunSummary =>
  ({
    id: RunId.make(`run-${ordinal}`),
    threadId: ThreadId.make("coordinator"),
    ordinal,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    status,
  }) as CoordinatorRunSummary;

const rule = {
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 100,
  defaultModelSelection: null,
};
const limitedCodex = [
  provider("codex", 100),
  provider("copilot", null),
  provider("claudeAgent", 10),
];

const display = (over: Partial<Parameters<typeof coordinatorModelDisplay>[0]>) =>
  coordinatorModelDisplay({
    picked: codex,
    saved: codex,
    thread: codex,
    runs: [],
    latestFailureClass: null,
    providers: limitedCodex,
    rule,
    nowMs,
    ...over,
  });

describe("coordinatorModelDisplay", () => {
  it("shows the saved model when nothing moved the coordinator", () => {
    expect(display({ runs: [run(1, codex, "completed")] })).toEqual({
      shown: codex,
      fallback: null,
    });
    // Codex has room again: a Copilot run left over from the fallback is no limit.
    expect(
      display({
        thread: copilot,
        runs: [run(1, copilot, "completed")],
        providers: [provider("codex", 40), provider("copilot", null)],
      }),
    ).toEqual({ shown: codex, fallback: null });
  });

  it("shows Copilot while the Codex limit runs the coordinator there", () => {
    const result = display({
      runs: [run(1, codex, "failed"), run(2, copilot, "running")],
    });
    expect(result.shown).toEqual(copilot);
    expect(result.fallback).toMatchObject({ saved: codex, now: copilot, spent: false });
    expect(result.fallback?.reason).toEqual({
      text: "weekly limit reached",
      resetsAt: Date.parse(resetsAt),
    });
  });

  it("follows the thread itself before its runs are loaded", () => {
    expect(display({ thread: copilot, runs: null }).shown).toEqual(copilot);
  });

  it("says the fallback is out of usage too once its own run stopped on the limit", () => {
    const result = display({
      thread: copilot,
      runs: [run(1, codex, "failed"), run(2, copilot, "failed")],
      latestFailureClass: "usage_limit",
    });
    expect(result.shown).toEqual(copilot);
    expect(result.fallback).toMatchObject({ now: copilot, spent: true });
  });

  it("shows Claude once the run moved on from a spent Copilot", () => {
    const result = display({
      thread: copilot,
      runs: [run(1, codex, "failed"), run(2, copilot, "failed"), run(3, claude, "running")],
      latestFailureClass: null,
    });
    expect(result.shown).toEqual(claude);
    expect(result.fallback).toMatchObject({ saved: codex, now: claude, spent: false });
  });

  it("shows a model picked by hand after the fallback", () => {
    const runs = [run(1, codex, "failed"), run(2, copilot, "completed")];
    // Picked Claude, which has room: the fallback is over and the pick is shown.
    expect(display({ picked: claude, saved: claude, thread: copilot, runs })).toEqual({
      shown: claude,
      fallback: null,
    });
    // Picked the model it was already running on.
    expect(display({ picked: copilot, saved: copilot, thread: copilot, runs })).toEqual({
      shown: copilot,
      fallback: null,
    });
  });

  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "honors Switch back after a %s fallback run under ask policy",
    (status) => {
      const ask = { ...rule, providerLimitAction: "ask" as const };
      const result = display({
        thread: codex,
        runs: [run(1, codex, "failed"), run(2, copilot, status)],
        rule: ask,
        latestFailureClass: "usage_limit",
      });
      const next = resolveCoordinatorTurnSelection({
        saved: codex,
        thread: codex,
        providers: limitedCodex,
        rule: ask,
        nowMs,
      });
      expect(next.reason).toBe("no-fallback");
      expect(result).toEqual({ shown: next.selection, fallback: null });
    },
  );

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "keeps the actual %s fallback visible ahead of thread metadata",
    (status) => {
      expect(display({ thread: codex, runs: [run(2, copilot, status)] }).fallback).toMatchObject({
        now: copilot,
        spent: false,
      });
    },
  );

  it("does not attach an old failed provider's limit to a new selection", () => {
    expect(
      display({
        thread: claude,
        runs: [run(2, copilot, "failed")],
        latestFailureClass: "usage_limit",
      }).fallback,
    ).toMatchObject({ now: claude, spent: false });
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "shows the admitted %s model when the saved provider regains quota",
    (status) => {
      expect(
        display({
          thread: codex,
          runs: [run(2, copilot, status)],
          providers: [provider("codex", 40), provider("copilot", null)],
        }),
      ).toEqual({ shown: copilot, fallback: null });
    },
  );

  it("keeps an ongoing model visible across preference and provider-data changes", () => {
    const runs = [run(2, copilot, "running")];
    expect(display({ runs, saved: claude, picked: claude }).shown).toEqual(copilot);
    expect(display({ runs, providers: null }).shown).toEqual(copilot);
    expect(display({ runs, rule: null }).shown).toEqual(copilot);
    expect(display({ runs, saved: null }).shown).toEqual(copilot);
    const differentModel = { ...codex, model: "gpt-6-astra" };
    expect(display({ runs: [run(2, differentModel, "running")] }).shown).toEqual(differentModel);
  });
});
