import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderLimitMachineTarget,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeMachineWait,
  firstEligibleMachine,
  judgeMachineCandidate,
  type MachineView,
  orderFallbackCandidates,
} from "./machineFallback.ts";

const now = Date.parse("2026-10-20T14:00:00.000Z");
const fresh = "2026-10-20T13:58:00.000Z";
const stale = "2026-10-20T13:30:00.000Z";
const laterReset = "2026-10-20T18:00:00.000Z";
const poolA = `sha256:${"a".repeat(64)}`;
const poolB = `sha256:${"b".repeat(64)}`;

const minisId = EnvironmentId.make("env-minis");
const target: ProviderLimitMachineTarget = {
  environmentId: minisId,
  label: "Minis",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  modelLabel: "Claude Opus 5.5",
};
const source = {
  machineLabel: "M4",
  driverKind: "claudeAgent",
  accountFingerprint: poolA,
};

function machine(
  overrides: Partial<MachineView> = {},
  usage: Partial<NonNullable<NonNullable<MachineView["providers"]>[number]["usage"]>> | null = {},
  provider: Partial<NonNullable<MachineView["providers"]>[number]> = {},
): MachineView {
  return {
    label: "Minis",
    environmentId: minisId,
    status: "ready",
    project: { match: "configured", projectId: "p" as never, title: "EasyChamp" },
    providers: [
      {
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        driverKind: ProviderDriverKind.make("claudeAgent"),
        models: ["claude-opus-5-5"],
        available: true,
        ...(usage === null
          ? {}
          : {
              usage: {
                accountFingerprint: poolB,
                usedPercent: 40,
                resetsAt: laterReset,
                signedIn: true,
                observedAt: fresh,
                ...usage,
              },
            }),
        ...provider,
      },
    ],
    ...overrides,
  };
}

const judge = (
  view: MachineView | undefined,
  unknownUsageEligible = false,
  threshold: number | null = 95,
) =>
  judgeMachineCandidate({
    target,
    machine: view,
    source,
    projectTitle: "EasyChamp",
    thresholdPercent: threshold,
    unknownUsageEligible,
    nowMs: now,
  });

describe("judgeMachineCandidate", () => {
  it("never hands off to a model billed per token, even with the unknown-usage policy on", () => {
    const paid = machine({}, null, { paidModels: ["claude-opus-5-5"] });
    expect(judge(paid, true)).toMatchObject({
      eligible: false,
      reason: "unavailable",
      text: "Minis: Claude Opus 5.5 is billed per token",
    });
    expect(judge(machine({}, {}, { paidModels: ["claude-opus-5-5"] }), true).eligible).toBe(false);
    expect(judge(machine({}, null, { paidModels: ["other"] }), true).eligible).toBe(true);
  });

  it("accepts a machine on another account with room", () => {
    const verdict = judge(machine());
    expect(verdict).toMatchObject({
      eligible: true,
      reason: "eligible",
      text: "Minis: Claude at 40%",
    });
  });

  it("skips a machine signed in to the same account as the exhausted provider", () => {
    const verdict = judge(machine({}, { accountFingerprint: poolA }));
    expect(verdict).toMatchObject({
      eligible: false,
      reason: "same_account",
      text: "Minis: same Claude account as M4",
    });
  });

  it("skips offline machines, missing grants and projects outside the grant", () => {
    expect(judge(machine({ status: "unreachable" })).text).toBe("Minis: offline");
    expect(judge(machine({ status: "needs_grant" })).text).toBe("Minis: no work grant");
    expect(judge(machine({ project: { match: "none" } })).text).toBe(
      "Minis: no work grant for EasyChamp",
    );
    expect(judge(undefined).reason).toBe("not_paired");
    expect(judge(machine({}, {}, { allowedByGrant: false })).reason).toBe("account_not_granted");
  });

  it("tells a project that isn't linked to the machine from one the grant leaves out", () => {
    const linkedTo = (ids: ReadonlyArray<string>) =>
      judgeMachineCandidate({
        target,
        machine: machine({ project: { match: "none" } }),
        source,
        projectTitle: "EasyChamp",
        linkedEnvironmentIds: ids,
        thresholdPercent: 95,
        unknownUsageEligible: false,
        nowMs: now,
      });
    expect(linkedTo(["env-m4"])).toMatchObject({
      reason: "not_linked",
      text: "Minis: EasyChamp isn't linked there",
    });
    expect(linkedTo(["env-m4", target.environmentId]).text).toBe(
      "Minis: no work grant for EasyChamp",
    );
  });

  it("skips usage at or above the threshold, and a stale reading still inside its window", () => {
    expect(judge(machine({}, { usedPercent: 97 }))).toMatchObject({
      eligible: false,
      reason: "at_threshold",
      text: "Minis: Claude at 97%",
    });
    expect(judge(machine({}, { usedPercent: 96, observedAt: stale })).reason).toBe("at_threshold");
    expect(judge(machine({}, { usedPercent: 60 }), false, 50).reason).toBe("at_threshold");
    expect(judge(machine({}, { usedPercent: 99 }), false, null).eligible).toBe(true);
  });

  it("refuses signed-out, limited, missing and unavailable providers", () => {
    expect(judge(machine({}, { signedIn: false })).reason).toBe("signed_out");
    expect(judge(machine({}, { limited: true })).reason).toBe("limited");
    expect(judge(machine({}, {}, { models: ["other"] })).text).toBe(
      "Minis: Claude has no Claude Opus 5.5",
    );
    expect(judge(machine({}, {}, { available: false })).reason).toBe("unavailable");
    expect(judge(machine({ providers: [] })).reason).toBe("not_installed");
  });

  it("treats unknown usage, unknown accounts and stale usage as ineligible unless the policy allows", () => {
    for (const view of [
      machine({}, null),
      machine({}, { usedPercent: null }),
      machine({}, { accountFingerprint: null }),
      machine({}, { usedPercent: 30, observedAt: stale, resetsAt: null }),
    ]) {
      const strict = judge(view);
      expect(strict.eligible).toBe(false);
      expect(["unknown_usage", "unknown_account", "stale_usage"]).toContain(strict.reason);
      expect(judge(view, true).eligible).toBe(true);
    }
  });

  it("never treats a different provider as the same pool", () => {
    const codex = machine(
      {},
      { accountFingerprint: null },
      { driverKind: ProviderDriverKind.make("codex") },
    );
    expect(judge(codex)).toMatchObject({ eligible: true, reason: "eligible" });
  });
});

describe("fallback order and wait text", () => {
  const local = [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" }];
  it("puts the chosen list first", () => {
    expect(
      orderFallbackCandidates("other-machine-first", local, [target]).map((c) => c.kind),
    ).toEqual(["machine", "local"]);
    expect(
      orderFallbackCandidates("same-machine-first", local, [target]).map((c) => c.kind),
    ).toEqual(["local", "machine"]);
  });

  it("names every skipped machine and picks the first eligible one", () => {
    const skipped = judge(machine({}, { accountFingerprint: poolA }));
    const offline = judgeMachineCandidate({
      target: { ...target, environmentId: EnvironmentId.make("env-m3"), label: "M3" },
      machine: { ...machine({ status: "unreachable" }), label: "M3" },
      source,
      projectTitle: "EasyChamp",
      thresholdPercent: 95,
      unknownUsageEligible: false,
      nowMs: now,
    });
    expect(describeMachineWait([skipped, offline])).toBe(
      "No other machine has room: Minis: same Claude account as M4; M3: offline.",
    );
    expect(firstEligibleMachine([skipped, offline, judge(machine())])?.reason).toBe("eligible");
  });
});
