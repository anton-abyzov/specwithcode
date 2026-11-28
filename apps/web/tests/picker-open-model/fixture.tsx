// The model picker with two open-model routes (increment 1513) beside a Claude plan
// sign-in, over fictional providers. `?theme=dark` picks the theme. Nothing here talks
// to a server, and no key exists: the routes are snapshots as the server reports them.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { ProviderModelPicker } from "../../src/components/chat/ProviderModelPicker";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { deriveProviderInstanceEntries } from "../../src/providerInstances";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/usage.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const NOW = Date.parse("2026-11-28T15:00:00Z");
Date.now = () => NOW;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const usageWindow = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  resetsAt: iso(NOW + 3 * HOUR),
  windowDurationMins: kind === "session" ? 300 : 10_080,
});
const effort = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: ["low", "medium", "high"].map((id) => ({
    id,
    label: id,
    ...(id === "medium" ? { isDefault: true } : {}),
  })),
};
type FixtureModel = { slug: string; name: string; billing: string };
const provider = (
  instanceId: string,
  displayName: string,
  models: FixtureModel[],
  over: Partial<ServerProvider>,
): ServerProvider =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    version: "fixture",
    checkedAt: iso(NOW),
    models: models.map((model) => ({
      ...model,
      isCustom: false,
      capabilities: { optionDescriptors: [effort] },
    })),
    slashCommands: [],
    skills: [],
    ...over,
  }) as never;

// What the server reports for each instance: the plan sign-in carries its usage
// windows; the two preset routes carry the marker and the auth label the driver
// stamps ("Your key", "Local"), with per-model billing from the base URL.
const PROVIDERS: ServerProvider[] = [
  provider(
    "claudeAgent",
    "Claude Code",
    [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", billing: "subscription" },
      { slug: "claude-fable-5-2", name: "Claude Fable 5.2", billing: "subscription" },
    ],
    {
      auth: {
        status: "authenticated",
        type: "subscription",
        label: "Max subscription",
        email: "dev@example.com",
      },
      usageLimits: {
        checkedAt: iso(NOW - 120_000),
        windows: [
          usageWindow("five_hour", "session", "Session", 31),
          usageWindow("seven_day", "weekly", "Weekly", 46),
        ],
      },
    } as never,
  ),
  provider(
    "deepseek-key",
    "DeepSeek",
    [{ slug: "deepseek-flash", name: "deepseek-flash", billing: "api" }],
    {
      openModelPreset: "deepseek",
      auth: { status: "authenticated", type: "apiKey", label: "Your key" },
    } as never,
  ),
  provider(
    "ollama-local",
    "Ollama",
    [{ slug: "qwen3-coder", name: "qwen3-coder", billing: "local" }],
    {
      openModelPreset: "ollama",
      auth: { status: "authenticated", type: "apiKey", label: "Local" },
    } as never,
  ),
];
const entries = deriveProviderInstanceEntries(PROVIDERS);
const options = new Map(entries.map((entry) => [entry.instanceId, entry.models] as const)) as never;

function PickerScene() {
  const [selection, setSelection] = useState({
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
  });
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-3 p-4 pb-6">
      <h1 className="text-sm text-muted-foreground">
        Open-model routes in the model picker. Providers and accounts are fictional.
      </h1>
      <div className="@container/composer-surface flex min-w-0 items-center gap-2 rounded-2xl border bg-card px-3 py-2">
        <ProviderModelPicker
          activeInstanceId={selection.instanceId as ProviderInstanceId}
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
          onOpenProviderSetup={() => {}}
          onManageProviders={() => {}}
          onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <PickerScene />
  </TooltipProvider>,
);
