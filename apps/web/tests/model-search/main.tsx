// The real composer model picker over one model offered by many providers.
// `?theme=dark` picks the theme. Nothing here talks to a server; all data is fictional.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { ProviderModelPicker } from "../../src/components/chat/ProviderModelPicker";
import { useClientSettings } from "../../src/hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../src/providerInstances";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

type FixtureModel = { slug: string; name: string; badge?: "new"; isLegacy?: boolean };
const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  auth: ServerProvider["auth"],
  models: FixtureModel[],
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: instanceId as never,
  driver: driver as never,
  displayName,
  enabled: true,
  installed: true,
  status: "ready",
  auth,
  version: "fixture",
  checkedAt: "2026-10-30T12:00:00.000Z",
  models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })) as never,
  slashCommands: [],
  skills: [],
  ...over,
});
const subscription = (label: string) =>
  ({ status: "authenticated", type: "subscription", label }) as ServerProvider["auth"];
const signedIn = { status: "authenticated" } as ServerProvider["auth"];

// Listed in the order a user might have added them, not the order search should show.
const PROVIDERS: ServerProvider[] = [
  provider("opencode", "opencode", "OpenCode", signedIn, [
    { slug: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5" },
    { slug: "anthropic/claude-opus-4.6", name: "Anthropic: Claude Opus 4.6" },
  ]),
  provider("cursor", "cursor", "Cursor", signedIn, [
    { slug: "opus-5.5", name: "Opus 5.5" },
    { slug: "opus-4.8", name: "Opus 4.8" },
    { slug: "composer-2.5", name: "Composer 2.5" },
  ]),
  provider(
    "github-copilot",
    "acpRegistry",
    "GitHub Copilot",
    subscription("Copilot Pro"),
    [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { slug: "claude-opus-4.8", name: "Claude Opus 4.8" },
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    ],
    { acpRegistryAgentId: "github-copilot-cli" } as never,
  ),
  provider(
    "github-copilot-enterprise",
    "acpRegistry",
    "Copilot Enterprise",
    subscription("Copilot Enterprise"),
    [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { slug: "claude-opus-5", name: "Claude Opus 5" },
      { slug: "claude-opus-4.8", name: "Claude Opus 4.8" },
    ],
    { acpRegistryAgentId: "github-copilot-cli" } as never,
  ),
  provider("codex", "codex", "Codex", subscription("ChatGPT Plus"), [
    { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
  ]),
  provider("claudeAgent", "claudeAgent", "Claude", subscription("Claude Max"), [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", badge: "new" },
    { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { slug: "claude-opus-5", name: "Claude Opus 5" },
    { slug: "claude-opus-4-8", name: "Claude Opus 4.8", isLegacy: true },
  ]),
];

function Composer() {
  const [selection, setSelection] = useState({ instanceId: "codex", model: "gpt-6.1-sol" });
  const [{ entries, options }] = useState(() => {
    const entries = deriveProviderInstanceEntries(PROVIDERS);
    const options = new Map(
      entries.map((entry) => [
        entry.instanceId,
        entry.models.map((model) => {
          const extra = model as { badge?: "new"; isLegacy?: boolean };
          return {
            slug: model.slug,
            name: model.name,
            ...(extra.badge ? { badge: extra.badge } : {}),
            ...(extra.isLegacy ? { isLegacy: true } : {}),
          };
        }),
      ]),
    );
    return { entries, options };
  });
  return (
    <div className="flex flex-col gap-1">
      <div className="@container/composer-surface flex min-w-0 items-center gap-2 rounded-2xl border bg-card px-3 py-2">
        <ProviderModelPicker
          activeInstanceId={selection.instanceId as ProviderInstanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          size="sm"
          onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
        />
      </div>
      <output className="text-2xs text-muted-foreground" data-testid="selection">
        {`${selection.instanceId}:${selection.model}`}
      </output>
      <output className="text-2xs text-muted-foreground" data-testid="follow">
        {JSON.stringify(useClientSettings((s) => s.modelFollowLatest ?? {}))}
      </output>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-3 p-4 pb-6">
    <p className="text-sm text-muted-foreground">
      Fixture: one model across providers. Provider and account data are fictional.
    </p>
    <Composer />
  </main>,
);
