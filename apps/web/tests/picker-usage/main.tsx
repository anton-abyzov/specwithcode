// The real composer model picker over fictional provider snapshots.
// `?case=` picks the usage state; `?theme=dark` the theme. Nothing here talks to a server.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { ProviderModelPicker } from "../../src/components/chat/ProviderModelPicker";
import type { ModelPickerUsageConfig } from "../../src/components/chat/ModelUsage";
import { deriveProviderInstanceEntries } from "../../src/providerInstances";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("case") ?? "room";
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

// Keep usage reads deterministic in both the verifier and browser previews.
const NOW = Date.parse("2026-10-21T15:00:00Z");
Date.now = () => NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const window = (
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
  ...(modelScope ? { modelScope } : {}),
});

const claudeWindows: Record<string, ServerProviderUsageWindow[]> = {
  room: [
    window("five_hour", "session", "Session", 38, 2 * HOUR + 14 * MIN),
    window("seven_day", "weekly", "Weekly", 82, 2 * 24 * HOUR + 5 * HOUR),
    window("seven_day_fable", "weekly", "Weekly · Fable", 64, 30 * HOUR, "Fable"),
  ],
  account: [
    window("five_hour", "session", "Session", 12, 4 * HOUR),
    window("seven_day", "weekly", "Weekly", 100, 2 * 24 * HOUR + 5 * HOUR),
    window("seven_day_fable", "weekly", "Weekly · Fable", 64, 30 * HOUR, "Fable"),
  ],
  model: [
    window("five_hour", "session", "Session", 22, 3 * HOUR),
    window("seven_day", "weekly", "Weekly", 41, 4 * 24 * HOUR),
    window("seven_day_fable", "weekly", "Weekly · Fable", 100, 30 * HOUR, "Fable"),
  ],
  stale: [
    window("five_hour", "session", "Session", 100, 40 * MIN),
    window("seven_day", "weekly", "Weekly", 77, 3 * 24 * HOUR),
  ],
  reset: [
    window("five_hour", "session", "Session", 100, -20 * MIN),
    window("seven_day", "weekly", "Weekly", 54, 3 * 24 * HOUR),
  ],
};

const limits = (
  windows: ServerProviderUsageWindow[],
  readAgo = 2 * MIN,
  over: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({ checkedAt: iso(NOW - readAgo), windows, ...over });

const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  models: Array<{ slug: string; name: string; badge?: "new" }>,
  usageLimits: ServerProviderUsageLimits | undefined,
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: instanceId as never,
  driver: driver as never,
  displayName,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "subscription" },
  version: "fixture",
  checkedAt: iso(NOW),
  models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })) as never,
  slashCommands: [],
  skills: [],
  ...(usageLimits ? { usageLimits } : {}),
  ...over,
});

const claudeLimits = (scenario: string): ServerProviderUsageLimits | undefined => {
  if (scenario === "loading") return undefined;
  if (scenario === "stale") return limits(claudeWindows.stale!, 2 * HOUR + 10 * MIN);
  if (scenario === "unknown")
    return limits([], 2 * MIN, { unavailable: { reason: "probeFailed" } });
  return limits(claudeWindows[scenario] ?? claudeWindows.room!);
};
const codexLimits = (scenario: string): ServerProviderUsageLimits | undefined =>
  scenario === "loading"
    ? undefined
    : scenario === "unknown"
      ? limits([], 2 * MIN, { unavailable: { reason: "probeFailed" } })
      : limits([
          window("primary", "session", "Session", 38, 3 * HOUR + 2 * MIN),
          window("secondary", "weekly", "Weekly", 12, 5 * 24 * HOUR),
        ]);

const scenarioProviders = (scenario: string): ServerProvider[] => [
  provider(
    "grok",
    "grok",
    "Grok",
    [{ slug: "grok-4.7", name: "Grok 4.7" }],
    limits(
      [],
      2 * MIN,
      scenario === "grok-probe-failed" ? { unavailable: { reason: "probeFailed" } } : {},
    ),
  ),
  provider(
    "codex",
    "codex",
    "Codex",
    [
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
      { slug: "gpt-6-astra", name: "GPT-6-Astra" },
    ],
    codexLimits(scenario),
  ),
  provider(
    "claudeAgent",
    "claudeAgent",
    "Claude",
    [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", badge: "new" },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", badge: "new" },
    ],
    claudeLimits(scenario),
  ),
  // Claude models through GitHub Copilot: another account, no usage reported.
  provider(
    "github-copilot",
    "acpRegistry",
    "GitHub Copilot",
    [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    ],
    undefined,
  ),
  // The managed Copilot agent: in `unprepared`, configured but never prepared here.
  provider(
    "github-copilot-cm",
    "acpRegistry",
    "Copilot managed",
    [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { slug: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    ],
    undefined,
    scenario === "unprepared"
      ? {
          installed: false,
          status: "warning",
          setup: { canAuthenticate: false, canInstall: true },
          message:
            "ACP Registry agent 'github-copilot-cli' has not been prepared on this environment.",
        }
      : {},
  ),
];

const pickerData = (scenario: string) => {
  const entries = deriveProviderInstanceEntries(scenarioProviders(scenario));
  const options = new Map(
    entries.map((entry) => [
      entry.instanceId,
      entry.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        ...((model as { badge?: "new" }).badge ? { badge: "new" as const } : {}),
      })),
    ]),
  );
  return { entries, options };
};

function Composer(props: {
  readonly scenario: string;
  readonly initial: { instanceId: string; model: string };
  readonly running?: boolean;
  readonly label?: string;
}) {
  const [selection, setSelection] = useState(props.initial);
  const [{ entries, options }] = useState(() => pickerData(props.scenario));
  const [usage] = useState<ModelPickerUsageConfig>(() => ({
    connected: props.scenario !== "offline",
    machineLabel: "Studio Mac",
    running: props.running
      ? { instanceId: "claudeAgent" as ProviderInstanceId, model: "claude-opus-5-5" }
      : null,
  }));
  return (
    <div className="flex flex-col gap-1">
      {props.label ? <p className="text-xs text-muted-foreground">{props.label}</p> : null}
      <div className="@container/composer-surface flex min-w-0 items-center gap-2 rounded-2xl border bg-card px-3 py-2">
        <ProviderModelPicker
          activeInstanceId={selection.instanceId as ProviderInstanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          size="sm"
          usage={usage}
          usageValueHiddenClassName="@max-[520px]/composer-surface:hidden"
          onOpenProviderSetup={() => {}}
          onManageProviders={() => {}}
          onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
        />
        <span className="ms-auto text-xs text-muted-foreground">Full access</span>
      </div>
      <output className="text-2xs text-muted-foreground" data-testid="selection">
        {`${selection.instanceId}:${selection.model}`}
      </output>
    </div>
  );
}

const TRIGGER_CASES = [
  "room",
  "account",
  "model",
  "stale",
  "reset",
  "loading",
  "unknown",
  "offline",
];
const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

function Fixture() {
  if (scenario === "triggers") {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 p-4">
        <h1 className="text-sm font-medium">Composer model trigger, one usage state per row</h1>
        {TRIGGER_CASES.map((name) => (
          <Composer key={name} scenario={name} label={name} initial={OPUS} />
        ))}
      </main>
    );
  }
  const running = scenario === "running";
  const initial = running
    ? { instanceId: "codex", model: "gpt-6.1-sol" }
    : scenario.startsWith("grok-")
      ? { instanceId: "grok", model: "grok-4.7" }
      : scenario === "unprepared"
        ? { instanceId: "github-copilot-cm", model: "claude-opus-5.5" }
        : OPUS;
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-3 p-4 pb-6">
      <p className="text-sm text-muted-foreground">
        Fixture: {scenario}. Provider, account and machine data are fictional.
      </p>
      <Composer scenario={scenario} running={running} initial={initial} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
