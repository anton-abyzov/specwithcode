// The calm model picker, the project's Models popover and machine colors over fictional
// providers and machines. `?scene=` picks the surface, `?theme=dark` the theme.
// Nothing here talks to a server.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { ProviderModelPicker } from "../../src/components/chat/ProviderModelPicker";
import { ThreadMachineComposerChip } from "../../src/components/chat/ThreadMachineComposerChip";
import { TraitsPicker } from "../../src/components/chat/TraitsPicker";
import { MachineChip } from "../../src/components/MachineChip";
import { MachineWindowTint } from "../../src/components/MachineWindowTint";
import { ProjectModelsPopover } from "../../src/components/studio/shell/ProjectModelsPopover";
import { MachineLimitsPanel } from "../../src/components/studio/shell/ProjectUsageIndicator";
import { ModelOrderList } from "../../src/components/settings/FallbackOrderList";
import { CollapsibleSection } from "../../src/components/settings/CollapsibleSection";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { deriveProviderInstanceEntries } from "../../src/providerInstances";
import { machineColorProps, useMachineIdentities } from "../../src/studio/machineIdentity";
import { useClaimWindowMachine } from "../../src/studio/windowMachine";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/usage.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "picker";
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const NOW = Date.parse("2026-11-10T15:00:00Z");
Date.now = () => NOW;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const usageWindow = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  resetIn: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  resetsAt: iso(NOW + resetIn),
  ...(kind === "session" ? { windowDurationMins: 300 } : { windowDurationMins: 10_080 }),
});
const limits = (
  windows: ServerProviderUsageWindow[],
  over: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({ checkedAt: iso(NOW - 120_000), windows, ...over });

const effort = (ids: string[]) => ({
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: ids.map((id) => ({ id, label: id, ...(id === "medium" ? { isDefault: true } : {}) })),
});
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
type FixtureModel = {
  slug: string;
  name: string;
  badge?: "new";
  billing?: string;
  contextWindow?: number;
  imageInput?: boolean;
  fast?: boolean;
  ultracode?: boolean;
  aliases?: string[];
};
const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  models: FixtureModel[],
  usageLimits: ServerProviderUsageLimits | undefined,
  over: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    version: "fixture",
    checkedAt: iso(NOW),
    models: models.map(({ fast, ultracode, ...model }) => ({
      ...model,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          effort(EFFORTS),
          ...(fast ? [{ id: "fastMode", label: "Fast mode", type: "boolean" as const }] : []),
          ...(ultracode ? [{ id: "ultracode", label: "Ultracode", type: "boolean" as const }] : []),
        ],
      },
    })),
    slashCommands: [],
    skills: [],
    ...(usageLimits ? { usageLimits } : {}),
    ...over,
  }) as never;

const OPUS: FixtureModel = {
  slug: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  badge: "new",
  billing: "subscription",
  contextWindow: 1_000_000,
  imageInput: true,
  fast: true,
  ultracode: true,
  aliases: ["opus-5.5"],
};
const PROVIDERS: ServerProvider[] = [
  provider(
    "claudeAgent",
    "claudeAgent",
    "Claude Code",
    [
      OPUS,
      {
        slug: "claude-fable-5-2",
        name: "Claude Fable 5.2",
        billing: "subscription",
        contextWindow: 1_000_000,
        imageInput: true,
        aliases: ["fable"],
      },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1", billing: "subscription" },
      { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", billing: "subscription" },
    ],
    limits([
      usageWindow("five_hour", "session", "Session", 38, 2 * HOUR + 20 * 60_000),
      usageWindow("seven_day", "weekly", "Weekly", 94, 2 * HOUR + 20 * 60_000),
    ]),
    {
      auth: { status: "authenticated", type: "subscription", label: "Ultra subscription" },
    } as never,
  ),
  provider(
    "codex",
    "codex",
    "Codex",
    [
      { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", billing: "subscription", fast: true },
      { slug: "gpt-5.3-codex", name: "GPT-5.3-Codex", billing: "subscription" },
      { slug: "gpt-6.1-mini", name: "GPT-6.1 mini", billing: "subscription" },
    ],
    limits([
      usageWindow("primary", "session", "Session", 22, 3 * HOUR),
      usageWindow("secondary", "weekly", "Weekly", 12, 120 * HOUR),
    ]),
  ),
  provider(
    "openai-api",
    "codex",
    "Codex API key",
    [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", billing: "api" }],
    undefined,
    { auth: { status: "authenticated", type: "apiKey", label: "API key" } } as never,
  ),
  provider(
    "copilot-enterprise",
    "acpRegistry",
    "Copilot Enterprise (fixture-robotics-on)",
    [
      { slug: "gemini-4-carbon", name: "Gemini 4 Carbon", badge: "new", contextWindow: 1_000_000 },
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { slug: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
      { slug: "claude-fable-5", name: "Claude Fable 5" },
    ],
    limits([], { unavailable: { reason: "unsupported" } }),
    { acpRegistryAgentId: "github-copilot" } as never,
  ),
  provider(
    "copilot-personal",
    "acpRegistry",
    "Copilot personal (fixture-person)",
    [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { slug: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
    ],
    limits([usageWindow("chat", "weekly", "Chat", 100, 20 * 24 * HOUR + 60_000)]),
    { acpRegistryAgentId: "github-copilot" } as never,
  ),
  provider(
    "ollama",
    "opencode",
    "Local models",
    [{ slug: "qwen3-coder", name: "Qwen 3 Coder", billing: "local" }],
    undefined,
  ),
  provider("cursor", "cursor", "Cursor", [], undefined, {
    status: "warning",
    auth: { status: "unauthenticated" },
    message: "Sign in with Cursor or add CURSOR_API_KEY",
  } as never),
];
const entries = deriveProviderInstanceEntries(PROVIDERS);
const options = new Map(entries.map((entry) => [entry.instanceId, entry.models] as const)) as never;
const id = (value: string) => value as ProviderInstanceId;

function PickerScene() {
  const [selection, setSelection] = useState({
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
  });
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-3 p-4 pb-6">
      <h1 className="text-sm text-muted-foreground">
        Calm model picker. Providers, accounts and machines are fictional.
      </h1>
      <div className="@container/composer-surface flex min-w-0 items-center gap-2 rounded-2xl border bg-card px-3 py-2">
        <ProviderModelPicker
          activeInstanceId={id(selection.instanceId)}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          size="sm"
          title="Model for this thread"
          triggerParts={{ provider: "Claude Code", model: "Opus 5.5" }}
          usage={{
            connected: true,
            environmentId: "env-m4",
            machineLabel: "M4",
            running: null,
            surface: "thread",
          }}
          secondaryView={{ label: "Limits by account", render: () => <p>Limits by account</p> }}
          onOpenProviderSetup={() => {}}
          onManageProviders={() => {}}
          onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
        />
      </div>
    </main>
  );
}

/**
 * "Limits by account" inside the thread's model picker, with enough accounts on two
 * fictional machines that the panel must scroll.
 */
const account = (
  instanceId: string,
  driver: string,
  displayName: string,
  email: string | undefined,
  plan: string | undefined,
  windows: ServerProviderUsageWindow[],
  over: Partial<ServerProvider> = {},
) =>
  provider(instanceId, driver, displayName, [{ slug: "m", name: "Model" }], limits(windows), {
    auth: {
      status: "authenticated",
      type: "subscription",
      ...(plan ? { label: `${plan} Subscription` } : {}),
      ...(email ? { email } : {}),
    },
    ...over,
  } as never);
const M4_ACCOUNTS = [
  account("claudeAgent", "claudeAgent", "Claude", "dev@example.com", "Claude Ultra", [
    usageWindow("seven_day", "weekly", "Weekly", 68, 48 * HOUR),
    {
      ...usageWindow("seven_day_fable", "weekly", "Fable weekly", 100, 48 * HOUR),
      modelScope: "fable",
    },
  ]),
  account("codex", "codex", "Codex", "ops@example.org", "ChatGPT Pro", [
    usageWindow("monthly", "monthly" as never, "Monthly", 100, 540 * HOUR),
  ]),
  account(
    "copilot-personal",
    "acpRegistry",
    "Copilot personal (fixture-person)",
    undefined,
    undefined,
    [usageWindow("chat", "weekly", "Chat", 100, 442 * HOUR)],
    { acpRegistryAgentId: "github-copilot" } as never,
  ),
  account("cursor", "cursor", "Cursor", "dev@example.com", "Cursor Pro", [
    usageWindow("monthly", "monthly" as never, "Monthly", 41, 300 * HOUR),
  ]),
];
const M1_ACCOUNTS = [
  account("grok", "grok", "Grok", "person@example.net", "SuperGrok", [
    usageWindow("weekly", "weekly", "Weekly", 4, 125 * HOUR),
  ]),
  account("claude-team", "claudeAgent", "Claude team", "team@example.com", "Claude Team", [
    usageWindow("five_hour", "session", "Session", 12, 3 * HOUR),
    usageWindow("seven_day", "weekly", "Weekly", 55, 90 * HOUR),
  ]),
  account("gemini", "gemini", "Gemini", "person@example.net", "Google AI Pro", [
    usageWindow("daily", "daily" as never, "Daily", 20, 9 * HOUR),
  ]),
];
const presentation = (label: string, primary: boolean, providers: ServerProvider[]) => ({
  connection: { phase: "connected" },
  serverConfig: { providers },
  entry: { target: { label, _tag: primary ? "PrimaryConnectionTarget" : "SavedConnectionTarget" } },
});
function LimitsScene() {
  (globalThis as { __fixturePresentations?: Map<string, unknown> }).__fixturePresentations ??=
    new Map([
      ["env-m4", presentation("Fixture MacBook", true, M4_ACCOUNTS)],
      ["env-m1", presentation("Fixture mini", false, M1_ACCOUNTS)],
    ]);
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-3 p-4 pb-6">
      <h1 className="text-sm text-muted-foreground">
        Limits by account. Providers, accounts and machines are fictional.
      </h1>
      <div className="@container/composer-surface flex min-w-0 items-center gap-2 rounded-2xl border bg-card px-3 py-2">
        <ProviderModelPicker
          activeInstanceId={id(params.get("account") ?? "claudeAgent")}
          model={params.has("account") ? "claude-opus-5.5" : "claude-opus-5-5"}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          size="sm"
          title="Model for this thread"
          triggerParts={{ provider: "Claude Code", model: "Opus 5.5" }}
          usage={{
            connected: true,
            environmentId: "env-m4",
            machineLabel: "M4",
            running: null,
            surface: "thread",
          }}
          secondaryView={{
            label: "Limits by account",
            render: ({ back, close }) => (
              <MachineLimitsPanel
                projectEnvironmentId={"env-m4" as never}
                coordinatorInstanceId={id("claudeAgent")}
                fallbackOrder={[
                  { instanceId: "claudeAgent", label: "Claude Code · Opus 5.5" },
                  { instanceId: "codex", label: "Codex · GPT-6.1 Sol" },
                ]}
                surface="thread"
                onBack={back}
                onClose={close}
              />
            ),
          }}
          onOpenProviderSetup={() => {}}
          onManageProviders={() => {}}
          onInstanceModelChange={() => {}}
        />
      </div>
    </main>
  );
}

function ModelsScene() {
  const [threads, setThreads] = useState<ModelSelection | null>({
    instanceId: id("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  });
  const capped = params.has("capped");
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 p-4">
      <h1 className="text-sm text-muted-foreground">Models popover for a project (fictional).</h1>
      <div className="w-fit max-w-full rounded-xl border bg-popover shadow-lg">
        <ProjectModelsPopover
          environmentId={"env-m4" as never}
          entries={entries}
          providers={PROVIDERS}
          modelOptionsByInstance={options}
          coordinator={{
            instanceId: id("claudeAgent"),
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: capped ? "max" : "medium" }],
          }}
          onChooseCoordinator={() => {}}
          threads={{
            value: threads,
            inherited: { instanceId: id("claudeAgent"), model: "claude-fable-5-2" },
            saving: false,
            onChange: setThreads,
          }}
          machines={[{ environmentId: "env-m4" }, { environmentId: "env-m1" }]}
          planModeEnabled={false}
          disabled={false}
          onOpenSettings={() => {}}
          onClose={() => {}}
        />
      </div>
    </main>
  );
}

/**
 * A window on M4 whose coordinator runs on M1: the top edge, the header chip,
 * the composer and Send all wear M1's color; pane separators stay neutral.
 */
function WindowScene() {
  const identityOf = useMachineIdentities();
  const m1 = identityOf("env-m1");
  const m4 = identityOf("env-m4");
  useClaimWindowMachine("env-m1", "project");
  return (
    <div className="flex min-h-screen text-sm" data-scene="window">
      <MachineWindowTint />
      <nav
        aria-label="Projects"
        className="hidden w-56 shrink-0 border-e border-border p-3 md:block"
      >
        <p className="font-semibold">Projects</p>
        <p className="mt-2 flex items-center gap-2">
          specweave <MachineChip identity={m1} label="Runs on M1" />
        </p>
        <p className="mt-2 flex items-center gap-2">
          easychamp <MachineChip identity={m4} label="Runs on M4" />
        </p>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-4 p-4">
        <header className="flex items-center gap-2">
          <h1 className="text-base font-semibold">specweave</h1>
          <MachineChip identity={m1} label="Runs on M1" />
        </header>
        <p className="text-muted-foreground">Coordinator moved to M1 (fictional machines).</p>
        <section
          aria-label="Coordinator on M1"
          className="project-composer sws-composer mt-auto"
          data-scene="coordinator"
        >
          <div className="sws-composer-card machine-composer" {...machineColorProps(m1)}>
            <label className="sr-only" htmlFor="window-prompt">
              Message the project coordinator
            </label>
            <textarea id="window-prompt" rows={1} placeholder="Ask the coordinator…" />
            <button
              type="button"
              className="sws-send sws-send-target machine-send"
              aria-label="Send to M1"
              data-send-label="Send to M1"
              {...machineColorProps(m1)}
            >
              ↑
            </button>
          </div>
        </section>
      </main>
      <aside
        aria-label="Threads"
        className="hidden w-64 shrink-0 border-s border-border p-3 md:block"
      >
        <p className="font-semibold">Threads</p>
      </aside>
    </div>
  );
}

/** Two composers: the coordinator on M4 (this machine) and a thread assigned to M1. */
function ComposerScene() {
  const identityOf = useMachineIdentities();
  const m4 = identityOf("env-m4");
  const m1 = identityOf("env-m1");
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 p-4">
      <MachineWindowTint />
      <h1 className="text-sm text-muted-foreground">Machine colors (fictional machines).</h1>
      <section
        aria-label="Coordinator on M4"
        className="project-composer sws-composer"
        data-scene="coordinator"
      >
        <div className="sws-composer-card machine-composer" {...machineColorProps(m4)}>
          <label className="sr-only" htmlFor="coordinator-prompt">
            Message the project coordinator
          </label>
          <textarea
            id="coordinator-prompt"
            rows={1}
            placeholder="Ask the coordinator a question or start a task…"
          />
          <button type="button" className="sws-send" aria-label="Send to coordinator">
            ↑
          </button>
        </div>
        <div className="sws-composer-foot">
          <span className="sws-composer-meta">
            <MachineChip identity={m4} label="Runs on M4" tabIndex={0} />
          </span>
        </div>
      </section>

      <section aria-label="Thread assigned to M1" data-scene="thread">
        <ComposerSurface.Shell machineColor={m1.color}>
          <ComposerSurface.Host>
            <div className="relative z-10 flex flex-col gap-3 p-3">
              <label className="sr-only" htmlFor="thread-prompt">
                Message
              </label>
              <textarea
                id="thread-prompt"
                rows={1}
                className="w-full resize-none bg-transparent text-sm outline-none"
                placeholder="Fix the flaky Capacity test…"
              />
              <div className="flex min-w-0 items-center gap-1">
                <ThreadMachineComposerChip
                  size="sm"
                  machine={{
                    kind: m1.icon,
                    label: m1.name,
                    tip: "Runs on M1 (Fixture mini, macOS).",
                    warning: null,
                    color: m1.color,
                    isThisMachine: false,
                  }}
                />
                <span className="min-w-0 truncate text-sm font-medium">Fable 5.2</span>
                <button
                  type="button"
                  className="machine-send ms-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold"
                  aria-label="Send to M1"
                  data-send-target=""
                  {...machineColorProps(m1)}
                >
                  ↑ Send to M1
                </button>
              </div>
            </div>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </section>

      <section
        aria-label="Thread header and sidebar"
        className="flex flex-col gap-2"
        data-scene="marks"
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">Fix the flaky Capacity test</span>
          <MachineChip identity={m1} label="Runs on M1" />
        </div>
        <ul className="w-64 rounded-xl border bg-card p-1.5 text-sm">
          {[
            ["Polish the project folder picker", m4],
            ["Fix the flaky Capacity test", m1],
          ].map(([title, machine]) => (
            <li key={String(title)} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">{String(title)}</span>
              <span
                className="sws-row-machine machine-mark"
                {...machineColorProps(machine as typeof m4)}
              >
                <span className="sws-row-machine-name">{(machine as typeof m4).name}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/** The thread's effort, Fast and Ultracode: icon and word with room, icons alone when tight. */
const ORDER: ModelSelection[] = [
  { instanceId: id("claudeAgent"), model: "claude-fable-5-2" },
  { instanceId: id("codex"), model: "gpt-6.1-sol" },
  { instanceId: id("copilot-enterprise"), model: "gemini-4-carbon" },
];

/** A settings order with alternates behind "+N", and a section that rests closed. */
function SettingsScene() {
  const [order, setOrder] = useState<ReadonlyArray<ModelSelection>>(ORDER);
  const alternates = [
    { selection: { instanceId: id("copilot-enterprise"), model: "claude-opus-5.5" } },
    {
      selection: { instanceId: id("copilot-personal"), model: "claude-opus-5.5" },
      status: "full" as const,
      resetAt: NOW + 30 * HOUR,
    },
  ];
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4" data-scene="settings">
      <h1 className="text-sm text-muted-foreground">Settings pieces (fictional).</h1>
      <ModelOrderList
        label="Reviewer order"
        providers={PROVIDERS}
        order={order}
        onChange={setOrder}
        steps={order.map((selection, index) => ({
          selection,
          status: index === 1 ? ("full" as const) : ("ready" as const),
          resetAt: index === 1 ? NOW + 4 * HOUR : null,
          ...(index === 0 ? { alternates } : {}),
        }))}
      />
      <CollapsibleSection id="fixture-advanced" title="Advanced" count={2}>
        <div className="px-4 py-3 text-sm" data-fixture-row>
          Check agents for updates
        </div>
        <div className="px-4 py-3 text-sm">Background activity</div>
      </CollapsibleSection>
    </main>
  );
}

const ICON_ONLY =
  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none";
function TraitsScene() {
  const claude = entries.find((entry) => entry.instanceId === "claudeAgent")!;
  const [traits, setTraits] = useState<NonNullable<ModelSelection["options"]>>([
    { id: "effort", value: "high" },
    { id: "fastMode", value: true },
    { id: "ultracode", value: true },
  ]);
  const picker = (
    <TraitsPicker
      provider={claude.driverKind}
      models={claude.models}
      model="claude-opus-5-5"
      prompt=""
      onPromptChange={() => {}}
      modelOptions={traits}
      allowPromptInjectedEffort={false}
      planModeEnabled={false}
      onModelOptionsChange={(next) => setTraits([...next])}
    />
  );
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-sm text-muted-foreground">Thread traits as icons (fictional model).</h1>
      <div
        className="flex w-fit items-center rounded-2xl border bg-card px-3 py-2"
        data-traits="roomy"
      >
        {picker}
      </div>
      <div
        className={`flex w-fit items-center rounded-2xl border bg-card px-3 py-2 ${ICON_ONLY}`}
        data-traits="tight"
      >
        {picker}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {scene === "limits" ? (
      <LimitsScene />
    ) : scene === "traits" ? (
      <TraitsScene />
    ) : scene === "models" ? (
      <ModelsScene />
    ) : scene === "window" ? (
      <WindowScene />
    ) : scene === "settings" ? (
      <SettingsScene />
    ) : scene === "composer" ? (
      <ComposerScene />
    ) : (
      <PickerScene />
    )}
  </TooltipProvider>,
);
