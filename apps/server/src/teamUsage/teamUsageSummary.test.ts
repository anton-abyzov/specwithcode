/**
 * 0898 AC-02: the summary allowlist. A provider snapshot with every optional
 * identity field set goes through the real builder and the real request
 * shaper; the whole request (URL, headers, body) may carry only the listed
 * fields, and none of the identities.
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  TEAM_USAGE_SUMMARY_KEYS,
  type UsageLimitHistorySeries,
  teamUsageSummaryExtraKeys,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTeamUsageSummary } from "./teamUsageSummary.ts";
import { teamUsageSendRequest } from "./teamUsageTransport.ts";

const NOW = Date.parse("2026-11-19T15:00:00.000Z");
const EMAIL = "member@example.com";
const SUBSCRIPTION_KEY = `claude:sha256:${"b".repeat(64)}`;
const POOL = `codex:sha256:${"c".repeat(64)}`;
const FINGERPRINT = "fingerprint-secret-0898";
const EXTERNAL_URL = "https://cursor.com/dashboard?team=secret-team";
const HOME = "/Users/member/.claude-work";
const TOKEN = "vsk_testtoken0898";

/** Every optional field a snapshot can carry that must never leave the machine. */
function fullProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude-work"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude work",
    accentColor: "#ff8800",
    badgeLabel: "Work",
    enabled: true,
    installed: true,
    version: "2.1.302",
    status: "ready",
    auth: {
      status: "authenticated",
      type: "max",
      label: "Claude Max",
      email: EMAIL,
      login: "member-login",
      profileId: "profile-secret",
    },
    checkedAt: "2026-11-19T14:59:00.000Z",
    message: "Signed in as member@example.com",
    runtimePaths: { homePath: HOME, shadowHomePath: null },
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-19T14:59:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "5-hour",
          usedPercent: 36,
          resetsAt: "2026-11-19T18:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          resetsAt: "2026-11-24T00:00:00.000Z",
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Fable weekly",
          usedPercent: 50,
          modelScope: "Fable",
        },
      ],
      subscriptionKey: SUBSCRIPTION_KEY,
      quotaPoolId: POOL,
      credentialFingerprint: FINGERPRINT,
      externalUsage: { label: "Dashboard", url: EXTERNAL_URL },
      credits: { hasCredits: true, unlimited: false, balance: "12.5" },
      resetCredits: { availableCount: 1, nextCreditId: "credit-secret" },
      planLabel: "Max 20x",
      renewsAt: "2026-12-01T00:00:00.000Z",
      accountChangedAt: "2026-11-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

const history: UsageLimitHistorySeries[] = [
  {
    accountKey: `claudeAgent:${EMAIL}`,
    driver: ProviderDriverKind.make("claudeAgent"),
    windowId: "five_hour",
    windowKind: "session",
    samples: [
      // Yesterday's peak is not today's.
      { at: "2026-11-18T23:00:00.000Z", usedPercent: 99 },
      { at: "2026-11-19T09:00:00.000Z", usedPercent: 88 },
      { at: "2026-11-19T12:00:00.000Z", usedPercent: 5 },
    ],
  },
];

function summary() {
  return buildTeamUsageSummary({
    providers: [
      fullProvider(),
      // A Cursor seat without a reading: "usage not readable yet".
      fullProvider({
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        displayName: "Cursor",
        usageLimits: {
          checkedAt: "2026-11-19T14:59:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported", message: "Turn on the Cursor reader" },
        },
      }),
      // Disabled instances are not seats here.
      fullProvider({ instanceId: ProviderInstanceId.make("off"), enabled: false }),
    ],
    config: { enabled: true, accountLabels: { [ProviderInstanceId.make("claude-work")]: "  Work Max  " } },
    defaultMachineLabel: "M4",
    history,
    counts: new Map([["claude-work", { limitHits: 2, handoffs: 1, providerSwitches: 3 }]]),
    nowMs: NOW,
  });
}

function allKeys(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => allKeys(item, `${at}[]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    `${at}${at === "" ? "" : "."}${key}`,
    ...allKeys(child, `${at}${at === "" ? "" : "."}${key}`),
  ]);
}

describe("team usage summary (0898 AC-02)", () => {
  it("builds the listed fields from a snapshot", () => {
    expect(summary()).toEqual({
      machineLabel: "M4",
      at: "2026-11-19T15:00:00.000Z",
      accounts: [
        {
          provider: "claudeAgent",
          accountLabel: "Work Max",
          planTier: "Max 20x",
          windows: [
            {
              kind: "session",
              remainingPercent: 64,
              lowestRemainingPercent: 12,
              resetsAt: "2026-11-19T18:00:00.000Z",
            },
            {
              kind: "weekly",
              remainingPercent: 90,
              lowestRemainingPercent: 90,
              resetsAt: "2026-11-24T00:00:00.000Z",
            },
          ],
          limitHits: 2,
          handoffs: 1,
          providerSwitches: 3,
        },
        {
          provider: "cursor",
          accountLabel: "Cursor",
          windows: [],
          limitHits: 0,
          handoffs: 0,
          providerSwitches: 0,
        },
      ],
    });
  });

  it("sends nothing outside the allowlist: URL, headers and body", () => {
    const result = teamUsageSendRequest(
      { kind: "hosted", tenantId: "tenant-1" },
      { hostedToken: TOKEN, selfHostedCredential: "other-secret" },
      summary(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { request } = result;
    expect(Object.keys(request).toSorted()).toEqual(["body", "headers", "method", "url"]);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://verified-skill.com/api/v1/tenants/tenant-1/usage-summaries");
    expect(request.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });

    const body = JSON.parse(request.body!) as unknown;
    const allowed = new Set([
      ...TEAM_USAGE_SUMMARY_KEYS.summary,
      ...TEAM_USAGE_SUMMARY_KEYS.account.map((key) => `accounts[].${key}`),
      ...TEAM_USAGE_SUMMARY_KEYS.window.map((key) => `accounts[].windows[].${key}`),
    ]);
    const sent = allKeys(body);
    expect(sent.filter((key) => !allowed.has(key))).toEqual([]);
    expect(teamUsageSummaryExtraKeys(body)).toEqual([]);

    const wire = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body}`;
    for (const secret of [
      EMAIL,
      "member-login",
      "profile-secret",
      SUBSCRIPTION_KEY,
      "b".repeat(64),
      POOL,
      FINGERPRINT,
      EXTERNAL_URL,
      "secret-team",
      HOME,
      "credit-secret",
      "other-secret",
      "claude-work",
      "Fable",
      "Signed in as",
    ])
      expect(wire).not.toContain(secret);
  });

  it("refuses a body with any key outside the list", () => {
    const leaky = summary();
    const withEmail = {
      ...leaky,
      accounts: [{ ...leaky.accounts[0]!, email: EMAIL }],
    } as unknown as typeof leaky;
    const result = teamUsageSendRequest(
      { kind: "hosted", tenantId: "tenant-1" },
      { hostedToken: TOKEN, selfHostedCredential: undefined },
      withEmail,
    );
    expect(result).toEqual({
      ok: false,
      reason: "Refused to send fields outside the list: accounts[0].email",
    });
    const nested = {
      ...leaky,
      accounts: [
        { ...leaky.accounts[0]!, windows: [{ ...leaky.accounts[0]!.windows[0]!, id: "five_hour" }] },
      ],
    } as unknown as typeof leaky;
    expect(teamUsageSummaryExtraKeys(nested)).toEqual(["accounts[0].windows[0].id"]);
    expect(teamUsageSummaryExtraKeys({ ...leaky, threadTitle: "x" })).toEqual(["threadTitle"]);
  });
});
