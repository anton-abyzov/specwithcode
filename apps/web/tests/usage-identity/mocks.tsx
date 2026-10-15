import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@specweave-studio/contracts";

// Three machines shaped like the real fleet: one Claude, Codex and Grok
// account per machine, each reporting its own email (all fictitious).
export const scenario = new URLSearchParams(location.search).get("setup") ?? "ready";
const HOUR = 60 * 60_000;
const now = Date.now();
const at = (hours: number) => new Date(now + hours * HOUR).toISOString();
const checkedAt = new Date(now - 60_000).toISOString();

const session = (usedPercent: number, hours: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  windowDurationMins: 300,
  resetsAt: at(hours),
});
const weekly = (id: string, label: string, usedPercent: number, hours: number) =>
  ({
    id,
    kind: "weekly",
    label,
    usedPercent,
    windowDurationMins: 7 * 24 * 60,
    resetsAt: at(hours),
  }) satisfies ServerProviderUsageWindow;

function provider(
  driver: string,
  name: string,
  auth: ServerProvider["auth"],
  windows: ServerProviderUsageWindow[],
  status: ServerProvider["status"] = "ready",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    version: "fixture",
    status,
    auth,
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows },
  };
}

const claude = (email: string, used: [number, number, number], hours: number) =>
  provider("claudeAgent", "Claude", { status: "authenticated", email, label: "Claude Max" }, [
    { ...session(used[0], hours) },
    weekly("seven_day", "Weekly", used[1], 50),
    weekly("seven_day_fable", "Weekly · Fable", used[2], 50),
  ]);
const codex = (email: string, used: [number, number], hours: number) =>
  provider(
    "codex",
    "Codex",
    { status: "authenticated", type: "chatgpt", email, label: "ChatGPT Pro" },
    [{ ...session(used[0], hours), id: "primary" }, weekly("secondary", "Weekly", used[1], 90)],
  );
const grok = (email: string | undefined, used: number) =>
  provider(
    "grok",
    "Grok",
    { status: "authenticated", ...(email ? { email } : {}), label: "SuperGrok" },
    [weekly("subscription", "Weekly", used, 120)],
  );

function machine(label: string, providers: ServerProvider[]) {
  return {
    entry: { target: { label } },
    connection: { phase: "connected" },
    serverConfig: { providers, usageLimitSources: [] },
  };
}

const presentations = new Map([
  [
    EnvironmentId.make("m1max"),
    machine("Anton's MacBook Pro M1Max (190)", [
      claude("studio.work@example.com", [2, 41, 12], 3.2),
      codex("studio.work@example.com", [18, 52], 1.5),
      grok("grok.work@example.com", 30),
    ]),
  ],
  [
    EnvironmentId.make("mbp"),
    machine(
      "Anton's MacBook Pro",
      scenario === "one"
        ? [
            // Quota still reads, but nobody is signed in to chat here.
            provider(
              "claudeAgent",
              "Claude",
              { status: "unauthenticated" },
              [session(0, 4)],
              "error",
            ),
          ]
        : [claude("anton.personal@example.com", [0, 9, 3], 4.4), grok(undefined, 64)],
    ),
  ],
  [
    EnvironmentId.make("m4max"),
    machine("Anton's MacBook M4MAX (149)", [
      claude("anton.team-account@example.com", [0, 77, 50], 4.9),
      codex("anton.team-account@example.com", [6, 23], 2.8),
      grok("anton.team-account@example.com", 12),
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
