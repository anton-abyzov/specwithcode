// The usage ring panel's "Used before reset" summary over fictional accounts,
// with a frozen clock (Tuesday November 17, 2026, 10 AM), and the Subscriptions
// view's "Agents and models" section over fictional machine reports (1455).
// Query: ?theme=light|dark
import {
  ProviderDriverKind,
  type UsageMachineReport,
  type UsageResetPeriod,
} from "@specweave-studio/contracts";
import { ArrowRightIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { EffectivenessSummaryView } from "~/components/usage/subscriptions/EffectivenessSummary";
import { RegistryAgentsView } from "~/components/usage/subscriptions/RegistryAgentsView";
import { effectivenessIndex } from "~/components/usage/subscriptions/effectivenessIndex";
import { providerGroupOf } from "~/components/usage/subscriptions/providerGroups";
import { agentStats } from "~/components/usage/subscriptions/registryAgents";
import type { SubscriptionRow } from "~/components/usage/subscriptions/subscriptionRows";
import { Button } from "~/components/ui/button";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 17, 10, 0).getTime();
const at = (month: number, day: number) => new Date(2026, month, day, 12).getTime();
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const grok = ProviderDriverKind.make("grok");
const acp = ProviderDriverKind.make("acpRegistry");
const copilotIcon = "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg";

const period = (accountKey: string, driver: ProviderDriverKind, endedAt: number, used: number) =>
  ({
    accountKey,
    driver,
    windowId: "weekly",
    windowKind: "weekly",
    endedAt: new Date(endedAt).toISOString(),
    lastReadAt: new Date(endedAt - HOUR).toISOString(),
    usedPercentAtReset: used,
    lostPercent: 100 - used,
    cause: "scheduled",
  }) as UsageResetPeriod;

const periods = [
  period("claude:one@example.com", claude, at(10, 6), 100),
  period("claude:one@example.com", claude, at(10, 13), 69),
  period("claude:two@example.com", claude, at(10, 7), 97),
  period("claude:three@example.com", claude, at(10, 11), 99),
  period("claude:four@example.com", claude, at(10, 14), 88),
  period("codex:one@example.com", codex, at(10, 4), 98),
];

const row = (
  driver: ProviderDriverKind,
  leftPercent: number,
  resetsAt: number,
  extra: Partial<SubscriptionRow> = {},
): SubscriptionRow => ({
  key: `${driver}`,
  accountKey: `${driver}:one@example.com`,
  renewalKey: `${driver}:one@example.com`,
  driver,
  displayName: null,
  iconUrl: null,
  plan: null,
  email: null,
  machines: [],
  offline: false,
  checkedAt: now,
  windows: [
    {
      id: "weekly",
      title: "Weekly",
      leftPercent,
      resetsAt,
      expiring: false,
      long: true,
      scoped: false,
      durationMs: 7 * DAY,
      kind: "weekly",
      accountWide: true,
      spent: leftPercent === 0,
      amounts: null,
    },
  ],
  renewal: null,
  credits: null,
  lastLoss: null,
  atLimit: false,
  note: null,
  ...extra,
});

const index = effectivenessIndex(
  [
    row(claude, 30, now + 11 * HOUR),
    row(codex, 60, now + 3 * DAY),
    row(grok, 72, now + 7 * HOUR),
    // Two Copilot accounts, both spent until their monthly reset, and Gemini CLI.
    row(acp, 0, now + 13 * DAY, {
      key: "copilot-one",
      accountKey: "acpRegistry:one@example.com",
      displayName: "GitHub Copilot",
      iconUrl: copilotIcon,
      atLimit: true,
    }),
    row(acp, 0, now + 14 * DAY, {
      key: "copilot-two",
      accountKey: "acpRegistry:two@example.com",
      displayName: "GitHub Copilot Enterprise",
      atLimit: true,
    }),
    row(acp, 55, now + 9 * DAY, {
      key: "gemini",
      accountKey: "acpRegistry:three@example.com",
      displayName: "Gemini CLI",
    }),
  ],
  periods,
  now,
);

// Fictional machine reports: Copilot turns on Opus, Gemini 4 Neon and GPT models on
// two machines, Gemini CLI on one, and Antigravity read from its transcripts.
const dayOf = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
const cell = (
  accountKey: string,
  model: string,
  offset: number,
  requests: number,
  tokens: number,
) => ({
  day: dayOf(offset),
  accountKey,
  model,
  origin: "app",
  tokens,
  costUsd: 0,
  requests,
  unpricedRequests: 0,
  sessions: 1,
});
const pattern = [
  3, 0, 5, 8, 2, 0, 0, 6, 9, 4, 7, 1, 0, 3, 10, 6, 2, 0, 4, 8, 5, 0, 1, 7, 9, 3, 0, 2, 6, 4,
];
const machineReport = (cells: ReturnType<typeof cell>[], accounts: Array<[string, string]>) =>
  ({
    version: 1,
    readAt: new Date(now).toISOString(),
    timeZone: "UTC",
    sinceDay: dayOf(29),
    untilDay: dayOf(0),
    accounts: accounts.map(([accountKey, label]) => ({
      accountKey,
      driver: accountKey.split(":")[0],
      label,
      identity: "recorded",
      signedIn: true,
    })),
    sources: [],
    projects: [],
    cells,
    hourly: [],
    hourlySinceMs: 0,
  }) as unknown as UsageMachineReport;
const reports = [
  machineReport(
    pattern.flatMap((count, offset) => [
      cell("acpRegistry:one@example.com", "claude-opus-5.5", offset, count, count * 31_000),
      cell(
        "acpRegistry:one@example.com",
        "gemini-4-neon",
        offset,
        Math.floor(count / 3),
        count * 9_000,
      ),
    ]),
    [["acpRegistry:one@example.com", "GitHub Copilot"]],
  ),
  machineReport(
    pattern.flatMap((count, offset) => [
      cell(
        "acpRegistry:two@example.com",
        "claude-opus-5.5",
        offset,
        Math.floor(count / 2),
        count * 20_000,
      ),
      cell("acpRegistry:two@example.com", "gpt-6.2-sol", offset, offset % 5 === 0 ? 1 : 0, 12_000),
      cell("acpRegistry:instance:gemini", "gemini-4-neon", offset, offset % 4 === 0 ? 2 : 0, 0),
      cell(
        "antigravity:me@example.com",
        "gemini-3.8-flash-high",
        offset,
        offset % 6 === 0 ? 1 : 0,
        4_000,
      ),
    ]),
    [
      ["acpRegistry:two@example.com", "GitHub Copilot Enterprise"],
      ["acpRegistry:instance:gemini", "Gemini CLI"],
    ],
  ),
];
const agents = agentStats(
  reports,
  (accountKey, driver, label) =>
    providerGroupOf({
      driver: driver as ProviderDriverKind,
      displayName: label,
      iconUrl: accountKey === "acpRegistry:one@example.com" ? copilotIcon : null,
    }),
  { sinceDay: dayOf(29), untilDay: dayOf(0) },
);

createRoot(document.getElementById("root")!).render(
  <main className="flex min-h-screen flex-wrap items-start justify-center gap-6 p-6">
    <div
      className="sws-usage-popover flex w-[344px] max-w-full flex-col gap-3 rounded-xl border bg-popover p-3 text-xs shadow-lg"
      data-fixture-panel=""
    >
      <h2 className="m-0 text-[length:var(--text-compact)] font-medium">Limits by account</h2>
      <EffectivenessSummaryView index={index} now={now} />
      <footer className="flex gap-2 border-t pt-2">
        <Button variant="outline" size="xs">
          Effectiveness <ArrowRightIcon aria-hidden />
        </Button>
        <Button variant="outline" size="xs">
          All accounts <ArrowRightIcon aria-hidden />
        </Button>
      </footer>
    </div>
    <div className="w-[640px] max-w-full min-w-0" data-fixture-agents="">
      <RegistryAgentsView view={agents} loading={false} unreached={["laptop"]} />
    </div>
  </main>,
);
