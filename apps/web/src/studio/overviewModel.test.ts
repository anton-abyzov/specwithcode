import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { ProviderInstanceId, ThreadId, type ServerProvider } from "@specweave-studio/contracts";
import type {
  StudioCapacityAccount,
  StudioCapacitySnapshot,
} from "@specweave-studio/contracts/studio";
import {
  absoluteTime,
  canSelectCapacity,
  capacityLabel,
  capacitySummary,
  deriveSessions,
  quotaFresh,
  resolveNativeModel,
  resolvePolicyDraft,
  sessionStateSince,
  verifiedPoolId,
} from "./overviewModel";

const now = Date.parse("2026-10-07T18:00:00Z");
const recent = new Date(now - 60_000).toISOString();
const old = new Date(now - 16 * 60_000).toISOString();
const pool = `codex:sha256:${"a".repeat(64)}`;
function account(overrides: Partial<StudioCapacityAccount> = {}): StudioCapacityAccount {
  return {
    id: "codex-1",
    provider: "codex",
    label: "Codex 1",
    authenticated: true,
    status: "ready",
    authError: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    quotaPoolId: pool,
    quotaPoolObservedAt: recent,
    quota: {
      window: { usedPercent: 25, resetsAt: now / 1_000 + 3_600 },
      weekly: null,
      observedAt: recent,
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
      source: "native-app-server",
      freshness: "fresh",
    },
    ...overrides,
  };
}
function snapshot(accounts: StudioCapacityAccount[], available = true): StudioCapacitySnapshot {
  return {
    schemaVersion: 1,
    observedAt: recent,
    source: "specweave-switch",
    scope: "environment-local",
    available,
    error: available ? null : "switch-unavailable",
    quotaPoolIdentity: "partial",
    verifiedQuotaPoolCount: 1,
    accounts,
    policy: null,
    recommendations: [],
  };
}
function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "thread",
    environmentId: "host",
    projectId: "project",
    title: "Real session",
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceId: "codex",
    updatedAt: recent,
    createdAt: recent,
    settledOverride: null,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: recent,
    models: [
      {
        slug: "model-real",
        name: "Configured model",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    ...overrides,
  } as ServerProvider;
}

describe("observed native capacity", () => {
  it("deduplicates a shared pool across hosts while retaining unverified profiles", () => {
    const result = capacitySummary(
      [
        snapshot([account()]),
        snapshot([
          account(),
          account({ id: "codex-2", quotaPoolId: null, quotaPoolObservedAt: null }),
        ]),
      ],
      now,
    );
    expect(result).toEqual({ profiles: 3, eligible: 3, verifiedPools: 1, unknownPools: 1 });
  });
  it("does not renew identity through a fresh turn quota observation", () => {
    const a = account({ quotaPoolObservedAt: old });
    expect(quotaFresh(a, now)).toBe(true);
    expect(verifiedPoolId(a, now)).toBeNull();
  });
  it("rejects future and malformed native identity without guessing a subscription", () => {
    expect(
      verifiedPoolId(account({ quotaPoolObservedAt: new Date(now + 6_000).toISOString() }), now),
    ).toBeNull();
    expect(verifiedPoolId(account({ quotaPoolId: "codex:sha256:invalid" }), now)).toBeNull();
    expect(verifiedPoolId(account({ authError: "subscription-auth-unverified" }), now)).toBeNull();
    expect(verifiedPoolId(account({ provider: "claude" }), now)).toBeNull();
  });
  it("expires a formerly ready snapshot at display time", () => {
    const a = account();
    expect(canSelectCapacity(a, now + 20 * 60_000)).toBe(false);
    expect(capacityLabel(a, now + 20 * 60_000)).toBe("Stale observation");
  });
  it("expires capacity when its observed reset passes even before the cache expiry", () => {
    const a = account({
      quota: { ...account().quota, window: { usedPercent: 25, resetsAt: now / 1_000 } },
    });
    expect(quotaFresh(a, now)).toBe(false);
    expect(canSelectCapacity(a, now)).toBe(false);
  });
  it("keeps unknown quota unknown even for a signed-in profile", () => {
    const a = account({
      status: "unknown",
      quota: {
        window: null,
        weekly: null,
        observedAt: null,
        expiresAt: null,
        source: null,
        freshness: "unknown",
      },
      quotaPoolId: null,
      quotaPoolObservedAt: null,
    });
    expect(capacityLabel(a, now)).toBe("Capacity unknown");
    expect(canSelectCapacity(a, now)).toBe(false);
    expect(capacitySummary([snapshot([a])], now).verifiedPools).toBeNull();
  });
  it("excludes exhausted, auth-required and legacy ambiguous accounts from preference", () => {
    for (const a of [
      account({ status: "exhausted" }),
      account({ authenticated: false, status: "auth-required" }),
      account({ authError: "subscription-auth-unverified" }),
      account({ authenticated: null, authError: "profile-isolation-unverified" }),
    ]) {
      expect(canSelectCapacity(a, now)).toBe(false);
      expect(capacitySummary([snapshot([a])], now).eligible).toBe(0);
    }
  });
  it("never uses unavailable-host payloads or an absent binding as ready capacity", () => {
    expect(capacitySummary([snapshot([account()], false)], now)).toEqual({
      profiles: 0,
      eligible: 0,
      verifiedPools: null,
      unknownPools: 0,
    });
    expect(canSelectCapacity(account({ providerInstanceId: null }), now)).toBe(false);
  });
  it("renders absolute reset time with explicit New York zone", () => {
    expect(absoluteTime(now / 1_000)).toContain("2026");
    expect(absoluteTime(now / 1_000)).toContain("2:00 PM EDT");
    expect(absoluteTime(null)).toBe("Time unknown");
  });
});
describe("explicit capacity policy drafts", () => {
  function policySnapshot(): StudioCapacitySnapshot {
    return {
      ...snapshot([
        account(),
        account({
          id: "codex-2",
          label: "Codex 2",
          providerInstanceId: ProviderInstanceId.make("native-second"),
        }),
      ]),
      policy: { mode: "spend-first", preferredProvider: "codex", selectedAccount: null },
      recommendations: [
        {
          provider: "any",
          id: "codex-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          reason: "Observed",
        },
        {
          provider: "codex",
          id: "codex-2",
          providerInstanceId: ProviderInstanceId.make("native-second"),
          reason: "Observed",
        },
      ],
    };
  }
  function providers() {
    return [
      provider(),
      provider({
        instanceId: ProviderInstanceId.make("native-second"),
        models: [
          {
            slug: "second-real-model",
            name: "Second model",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
      }),
    ];
  }
  it("uses the exact host recommendation for its provider policy and configured native model", () => {
    expect(resolvePolicyDraft(policySnapshot(), providers(), now)).toEqual({
      accountId: "codex-2",
      label: "Codex 2",
      model: { instanceId: "native-second", model: "second-real-model" },
    });
  });
  it("never falls back from an ineligible pin to another otherwise-ready account", () => {
    const s = {
      ...policySnapshot(),
      policy: { mode: "balanced", preferredProvider: null, selectedAccount: "codex-2" },
    } as StudioCapacitySnapshot;
    expect(
      resolvePolicyDraft(
        {
          ...s,
          accounts: s.accounts.map((a) => (a.id === "codex-2" ? { ...a, status: "exhausted" } : a)),
        },
        providers(),
        now,
      ),
    ).toBeNull();
    // An inconsistent server recommendation still cannot ignore the pin.
    expect(resolvePolicyDraft(s, providers(), now)).toBeNull();
  });
  it("requires fresh DTO, quota, native authentication and exact instance binding at click time", () => {
    const s = policySnapshot();
    expect(resolvePolicyDraft({ ...s, observedAt: old }, providers(), now)).toBeNull();
    expect(resolvePolicyDraft({ ...s, available: false }, providers(), now)).toBeNull();
    expect(resolvePolicyDraft(s, providers(), now + 20 * 60_000)).toBeNull();
    expect(
      resolvePolicyDraft(
        s,
        [
          provider(),
          provider({
            instanceId: ProviderInstanceId.make("native-second"),
            checkedAt: old,
          }),
        ],
        now,
      ),
    ).toBeNull();
    expect(
      resolvePolicyDraft(
        {
          ...s,
          recommendations: [
            {
              provider: "codex",
              id: "codex-2",
              providerInstanceId: ProviderInstanceId.make("codex"),
              reason: "Mismatched",
            },
          ],
        },
        providers(),
        now,
      ),
    ).toBeNull();
  });
});
describe("native shells and explicit instance selection", () => {
  it("uses exact instance/model and rejects similar guessed IDs", () => {
    expect(resolveNativeModel([provider()], "codex")).toEqual({
      instanceId: "codex",
      model: "model-real",
    });
    expect(resolveNativeModel([provider()], "codex-1")).toBeNull();
    expect(resolveNativeModel([provider()], null)).toBeNull();
  });
  it("requires an enabled installed authenticated native instance", () => {
    for (const p of [
      provider({ enabled: false }),
      provider({ installed: false }),
      provider({ auth: { status: "unknown" } }),
      provider({ status: "error" }),
      provider({ models: [] }),
    ])
      expect(resolveNativeModel([p], "codex")).toBeNull();
  });
  it("preserves real approval/input priority and background waiting semantics", () => {
    const views = deriveSessions(
      [
        shell({ id: ThreadId.make("waiting"), runtime: { status: "idle" } as EnvironmentThreadShell["runtime"] }),
        shell({
          id: ThreadId.make("approval"),
          hasPendingApprovals: true,
          runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
        }),
        shell({ id: ThreadId.make("input"), hasPendingUserInput: true }),
      ],
      [],
      new Set(["host"]),
    );
    expect(views[0]?.attention).toBe("approval");
    expect(views[0]?.working).toBe(true);
    expect(views.find((s) => s.thread.id === "input")?.attention).toBe("input");
    expect(views.find((s) => s.thread.id === "waiting")?.state).toBe("Waiting for background work");
  });
  it("shows actionable native plans and scoped projects without marking a successful run settled", () => {
    const projects = [
      { environmentId: "other", id: "project", title: "Wrong host" },
      { environmentId: "host", id: "project", title: "Correct host" },
    ] as EnvironmentProject[];
    const [view] = deriveSessions(
      [
        shell({
          hasActionableProposedPlan: true,
          latestRun: { status: "completed" } as EnvironmentThreadShell["latestRun"],
        }),
      ],
      projects,
      new Set(["host"]),
    );
    expect(view?.attention).toBe("plan");
    expect(view?.project?.title).toBe("Correct host");
    expect(view?.settled).toBe(false);
  });
  it("keeps the time a limited run stopped when the service restart bumps the thread", () => {
    const limited = shell({
      updatedAt: recent,
      runtime: {
        status: "failed",
        lastErrorClass: "usage_limit",
      } as EnvironmentThreadShell["runtime"],
      latestRun: { status: "failed", completedAt: old } as EnvironmentThreadShell["latestRun"],
    });
    expect(sessionStateSince(limited)).toBe(old);
    expect(sessionStateSince(shell({ updatedAt: recent }))).toBe(recent);
    expect(
      sessionStateSince(
        shell({
          updatedAt: recent,
          runtime: { status: "failed" } as EnvironmentThreadShell["runtime"],
        }),
      ),
    ).toBe(recent);
  });
  it("excludes archived/deleted shells and keeps native usage failure actionable", () => {
    const views = deriveSessions(
      [
        shell({ archivedAt: recent }),
        shell({ deletedAt: recent }),
        shell({
          id: ThreadId.make("limited"),
          runtime: {
            status: "failed",
            lastErrorClass: "usage_limit",
          } as EnvironmentThreadShell["runtime"],
        }),
      ],
      [],
      new Set(["host"]),
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.attention).toBe("limited");
  });
  it("keeps disconnected cached work and approvals as history until the host reconnects", () => {
    const shells = [
      shell({
        id: ThreadId.make("working"),
        runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
      }),
      shell({ id: ThreadId.make("approval"), hasPendingApprovals: true }),
    ];
    const disconnected = deriveSessions(shells, [], new Set());
    expect(disconnected).toHaveLength(2);
    expect(disconnected.filter((view) => view.working || view.attention)).toHaveLength(0);
    expect(disconnected.find((view) => view.thread.id === "working")?.state).toBe(
      "Disconnected · Last observed: Working",
    );
    expect(disconnected.find((view) => view.thread.id === "approval")?.state).toBe(
      "Disconnected · Last observed: Approval requested",
    );
    expect(disconnected.map((view) => view.thread.updatedAt)).toEqual([recent, recent]);

    const reconnected = deriveSessions(shells, [], new Set(["host"]));
    expect(reconnected.find((view) => view.thread.id === "working")?.working).toBe(true);
    expect(reconnected.find((view) => view.thread.id === "working")?.state).toBe("Working");
    expect(reconnected.find((view) => view.thread.id === "approval")?.attention).toBe("approval");
  });
});

it("fresh explicit native allowance supports missing windows without treating credit metadata as permission", () => {
  const a = account(); Object.assign(a.quota, { window: null, weekly: null, ordinaryUsageAllowed: true });
  expect(quotaFresh(a, now)).toBe(true); expect(canSelectCapacity(a, now)).toBe(true);
  Object.assign(a.quota, { ordinaryUsageAllowed: null, credits: { hasCredits: true, unlimited: true } });
  expect(quotaFresh(a, now)).toBe(false); expect(canSelectCapacity(a, now)).toBe(false);
});
