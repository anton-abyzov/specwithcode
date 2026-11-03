import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { coordinatorSelectionProblem, coordinatorUnavailableDetail } from "./coordinatorDefault.ts";
import {
  coordinatorFallbackReason,
  coordinatorOnLimitFallback,
  resolveCoordinatorTurnSelection,
} from "./providerFallback.ts";
import { providerSetupProblem } from "./providerSetup.ts";

const now = Date.parse("2026-11-03T06:30:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const UNPREPARED =
  "ACP Registry agent 'github-copilot-cli' has not been prepared on this environment.";

function provider(
  id: string,
  driver: string,
  used: number | null,
  models: ReadonlyArray<{ slug: string; name: string }>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(now),
    version: null,
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: iso(now),
            windows: [
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: iso(now + 24 * 60 * 60_000),
              },
            ],
          },
        }),
    ...over,
  };
}

// The M1 on 2026-11-03: Copilot saved but never prepared, Codex spent, Claude at 95%.
const copilotModels = [
  { slug: "default", name: "Default" },
  { slug: "auto", name: "Auto" },
];
const unprepared = provider("acpRegistry_copilot", "acpRegistry", null, copilotModels, {
  displayName: "Copilot",
  installed: false,
  status: "warning",
  auth: { status: "unknown" },
  message: UNPREPARED,
});
const prepared = provider("acpRegistry_copilot", "acpRegistry", null, copilotModels, {
  displayName: "Copilot",
  auth: { status: "unknown" },
});
const codex = (used: number) =>
  provider("codex", "codex", used, [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }], {
    displayName: "Codex",
  });
const claude = (used: number) =>
  provider("claudeAgent", "claudeAgent", used, [{ slug: "claude-opus-5-5", name: "Opus 5.5" }]);
const saved = { instanceId: ProviderInstanceId.make("acpRegistry_copilot"), model: "auto" };
const onCodex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const rule = (action: "ask" | "wait" | "switch") => ({
  providerLimitAction: action,
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 95,
  providerLimitWaitUnderMinutes: 0,
  defaultModelSelection: null,
});
const input = (
  providers: ReadonlyArray<ServerProvider>,
  action: "ask" | "wait" | "switch" = "switch",
) => ({ saved, thread: onCodex, providers, rule: rule(action), nowMs: now });

describe("a saved coordinator pick that cannot run", () => {
  it("is not chosen for the next turn because it reports no usage", () => {
    // Before the fix this returned the saved pick ("saved") and every send failed.
    expect(resolveCoordinatorTurnSelection(input([unprepared, codex(100), claude(95)]))).toEqual({
      selection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
      reason: "fallback",
    });
  });

  it("keeps a working fallback under any limit rule", () => {
    for (const action of ["ask", "wait", "switch"] as const)
      expect(resolveCoordinatorTurnSelection(input([unprepared, codex(20)], action))).toEqual({
        selection: onCodex,
        reason: "staying-on-fallback",
      });
  });

  it("is refused with its own reason only when nothing else has room", () => {
    const providers = [unprepared, codex(100), claude(100)];
    expect(resolveCoordinatorTurnSelection(input(providers))).toEqual({
      selection: saved,
      reason: "saved-unavailable",
    });
    // The banner must not say the pick "has room again".
    expect(coordinatorOnLimitFallback(input(providers))).toBe(true);
    expect(coordinatorFallbackReason(input(providers))).toEqual({
      text: UNPREPARED,
      resetsAt: null,
      setup: true,
    });
    expect(coordinatorSelectionProblem(saved, providers)).toBe("provider_unavailable");
    expect(coordinatorUnavailableDetail(saved, providers, { nothingElseHasRoom: true })).toBe(
      `Copilot · Auto cannot run on this machine: ${UNPREPARED} No other provider has room to run the coordinator instead. Open Settings > Providers > Copilot on that machine and choose Install / update agent, or choose another coordinator model.`,
    );
  });

  it("goes back to the pick once it is prepared", () => {
    expect(resolveCoordinatorTurnSelection(input([prepared, codex(100), claude(95)]))).toEqual({
      selection: saved,
      reason: "saved",
    });
    expect(coordinatorOnLimitFallback(input([prepared, codex(20)]))).toBe(false);
  });

  it("names off, signed-out and missing providers in plain words", () => {
    expect(providerSetupProblem({ ...prepared, enabled: false }, "auto")).toBe(
      "is turned off in Settings > Providers",
    );
    expect(
      providerSetupProblem({ ...codex(10), auth: { status: "unauthenticated" } }, "gpt-6.1-sol"),
    ).toBe("is not signed in");
    expect(providerSetupProblem(undefined, "auto")).toBe("is not set up on this machine");
    expect(providerSetupProblem(prepared, "auto")).toBeNull();
    expect(
      coordinatorUnavailableDetail(
        onCodex,
        [{ ...codex(10), auth: { status: "unauthenticated" } }],
        { nothingElseHasRoom: false },
      ),
    ).toBe(
      "Codex · GPT-6.1 Sol is not signed in. Fix it under Settings > Providers > Codex on that machine, or choose another coordinator model.",
    );
  });
});
