// Four Claude subscriptions across machines, as the Limits view meets them:
// two pooled live, one hidden behind a Console API sign-in, one recently
// read that no machine reports now. Plus two Codex accounts. All fictional.
import type { ServerProvider, ServerProviderUsageWindow } from "@specweave-studio/contracts";

export const NOW = Date.parse("2026-10-28T15:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const win = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  resetIn: number,
  modelScope?: string,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  resetsAt: iso(NOW + resetIn),
  windowDurationMins: kind === "session" ? 300 : 10_080,
  ...(modelScope ? { modelScope } : {}),
});

const provider = (over: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: "ready",
    version: "fixture",
    checkedAt: iso(NOW - 2 * MIN),
    models: [],
    slashCommands: [],
    skills: [],
    auth: { status: "authenticated" },
    ...over,
  }) as ServerProvider;

const claude = (email: string, windows: ServerProviderUsageWindow[]) =>
  provider({
    auth: { status: "authenticated", email, label: "Claude Max 20x", type: "subscription" },
    usageLimits: { checkedAt: iso(NOW - 2 * MIN), windows },
  });
const codex = (email: string, used: number, resetIn: number) =>
  provider({
    instanceId: "codex" as never,
    driver: "codex" as never,
    displayName: "Codex",
    auth: { status: "authenticated", email, label: "ChatGPT Pro", type: "chatgpt" },
    usageLimits: {
      checkedAt: iso(NOW - 2 * MIN),
      windows: [win("primary", "weekly", "Weekly", used, resetIn)],
    },
  });

const presentation = (label: string, providers: ServerProvider[], connected = true) => ({
  entry: { target: { label } },
  connection: { phase: connected ? "connected" : "disconnected" },
  serverConfig: { providers, usageLimitSources: [] },
});

export const fixturePresentations = new Map([
  [
    "env-m4",
    presentation("MacBook M4 Max", [
      provider({
        auth: {
          status: "authenticated",
          email: "console@example.com",
          label: "Claude Console (API Usage Billing)",
          type: "apiKey",
          apiKeyBilling: true,
        },
        usageLimits: {
          checkedAt: iso(NOW - 2 * MIN),
          windows: [],
          unavailable: {
            reason: "unsupported",
            message:
              "Claude Code here uses a Claude Console API sign-in (console@example.com, Example Org), so turns bill the API and no subscription limits apply. It takes precedence over the claude.ai subscription max@example.com. Sign out of the Console profile (~/.config/anthropic) to use that subscription again.",
          },
        },
      }),
      codex("team@example.com", 2, 6 * 24 * HOUR + 15 * HOUR),
    ]),
  ],
  [
    "env-mini",
    presentation("Ministorm", [
      claude("anton@example.com", [
        win("five_hour", "session", "Session", 38, 2 * HOUR + 14 * MIN),
        win("seven_day", "weekly", "Weekly", 64, 2 * 24 * HOUR + 5 * HOUR),
        win("seven_day_fable", "weekly", "Weekly · Fable", 22, 30 * HOUR, "Fable"),
      ]),
    ]),
  ],
  [
    "env-m1",
    presentation("MacBook M1 Max", [
      claude("team@example.com", [
        win("five_hour", "session", "Session", 81, 47 * MIN),
        win("seven_day", "weekly", "Weekly", 91, 4 * 24 * HOUR),
        win("seven_day_fable", "weekly", "Weekly · Fable", 60, 4 * 24 * HOUR, "Fable"),
      ]),
      codex("personal@example.com", 46, 3 * 24 * HOUR),
    ]),
  ],
]);

const series = (
  accountKey: string,
  windowId: string,
  windowKind: "session" | "weekly",
  points: Array<[number, number]>,
  resetIn: number,
) => ({
  accountKey,
  driver: accountKey.split(":")[0]!,
  windowId,
  windowKind,
  windowDurationMins: windowKind === "session" ? 300 : 10_080,
  samples: points.map(([ago, used]) => ({
    at: iso(NOW - ago),
    usedPercent: used,
    resetsAt: iso(NOW + resetIn),
  })),
});

const ramp = (from: number, to: number, hours: number) =>
  Array.from({ length: hours * 2 + 1 }, (_, step): [number, number] => [
    (hours * 2 - step) * 30 * MIN,
    Math.round(from + ((to - from) * step) / (hours * 2)),
  ]);

export const fixtureHistory = [
  series("claudeAgent:anton@example.com", "seven_day", "weekly", ramp(40, 64, 30), 53 * HOUR),
  series("claudeAgent:team@example.com", "seven_day", "weekly", ramp(70, 91, 30), 96 * HOUR),
  series("claudeAgent:anton@example.com", "five_hour", "session", ramp(10, 38, 3), 134 * MIN),
  series("claudeAgent:team@example.com", "five_hour", "session", ramp(50, 81, 3), 47 * MIN),
  // Switched away from in the CLI two days ago: no machine reports it now.
  series("claudeAgent:old@example.com", "five_hour", "session", [[50 * HOUR, 12]], -45 * HOUR),
  series("claudeAgent:old@example.com", "seven_day", "weekly", [[50 * HOUR, 57]], 70 * HOUR),
];
