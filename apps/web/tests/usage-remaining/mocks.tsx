import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import type { ReactNode } from "react";

// The fleet from the reported screenshot: M4 has room, both MacBook Pros
// have spent their Claude session window (all accounts fictitious).
const HOUR = 60 * 60_000;
const now = Date.now();
const at = (hours: number) => new Date(now + hours * HOUR).toISOString();
const checkedAt = new Date(now - 60_000).toISOString();

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  hours: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  windowDurationMins: kind === "session" ? 300 : 7 * 24 * 60,
  resetsAt: at(hours),
});

function provider(
  driver: string,
  name: string,
  email: string,
  plan: string,
  windows: ServerProviderUsageWindow[],
  bankedResets = 0,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated", email, label: plan },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows,
      ...(bankedResets > 0
        ? {
            resetCredits: {
              availableCount: bankedResets,
              nextExpiresAt: at(7 * 24),
            },
          }
        : {}),
    },
  } as ServerProvider;
}

const claude = (email: string, used: [number, number, number], banked = 0) =>
  provider(
    "claudeAgent",
    "Claude",
    email,
    "Claude Max Subscription",
    [
      window("five_hour", "session", "Session", used[0], 2.53),
      window("seven_day", "weekly", "Weekly", used[1], 130),
      window("seven_day_fable", "weekly", "Weekly · Fable", used[2], 130),
    ],
    banked,
  );
const codex = (email: string, used: [number, number]) =>
  provider("codex", "Codex", email, "ChatGPT Pro", [
    window("primary", "session", "Session", used[0], 3.1),
    window("secondary", "weekly", "Weekly", used[1], 90),
  ]);
const grok = (email: string, used: number) =>
  provider("grok", "Grok", email, "SuperGrok", [
    window("subscription", "weekly", "Weekly", used, 120),
  ]);

function machine(label: string, providers: ServerProvider[]) {
  return {
    entry: { target: { label } },
    connection: { phase: "connected" },
    serverConfig: { providers, usageLimitSources: [] },
  };
}

export const projectHost = EnvironmentId.make("m4max");
const presentations = new Map([
  [
    projectHost,
    machine("Anton's MacBook M4MAX (149)", [
      claude("team@example.com", [23, 10, 0], 1),
      codex("team@example.com", [6, 18]),
      grok("team@example.com", 42),
    ]),
  ],
  [
    EnvironmentId.make("mbp"),
    machine("Anton's MacBook Pro", [
      claude("personal@example.com", [100, 64, 20]),
      codex("personal@example.com", [7, 85]),
    ]),
  ],
  [
    EnvironmentId.make("m1max"),
    machine("Anton's MacBook Pro M1Max (190)", [
      claude("work@example.com", [100, 96, 30]),
      codex("work@example.com", [0, 4]),
    ]),
  ],
]);

export const environmentPresentations = { presentationsAtom: Atom.make(presentations) };
export const usePrimarySettings = (select: (settings: { timestampFormat: "locale" }) => unknown) =>
  select({ timestampFormat: "locale" });
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = () => true;
export const serverEnvironment = { consumeResetCredit: Symbol("fixture-consume") };
export const useAtomCommand = () => () => {
  throw new Error("Fixture forbids server commands");
};
export const ensureLocalApi = () => ({ shell: { openExternal: () => {} } });
export const useNavigate = () => () => {};
export const Link = ({ children, className }: { children: ReactNode; className?: string }) => (
  <a className={className}>{children}</a>
);
