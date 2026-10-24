import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@specweave-studio/contracts";
import { ProviderInstanceCard } from "../../src/components/settings/ProviderInstanceCard";
import { getDriverOption } from "../../src/components/settings/providerDriverMeta";
import {
  SettingsRow,
  SettingsSection,
  scrollToSettingsTarget,
} from "../../src/components/settings/settingsLayout";
import { SettingsGroup } from "../../src/components/settings/SettingsGroup";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
applyThemePalette("studio-chat", query.get("theme") === "dark" ? "dark" : "light");
const initial: Record<string, ProviderInstanceConfig> = {
  opencode: {
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    displayName: "OpenCode research account with custom endpoint",
    config: {},
  },
  codex: {
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: "Codex",
    config: { setupMode: "manual", binaryPath: "codex" },
  },
  claudeAgent: {
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    displayName: "Claude Code",
    config: {},
  },
  copilot: {
    driver: ProviderDriverKind.make("acpRegistry"),
    enabled: true,
    displayName: "GitHub Copilot",
    config: { agentId: "github-copilot" },
  },
  "copilot-cli": {
    driver: ProviderDriverKind.make("acpRegistry"),
    enabled: true,
    displayName: "GitHub Copilot CLI",
    config: { agentId: "github-copilot-cli" },
  },
  cursor: {
    driver: ProviderDriverKind.make("cursor"),
    enabled: false,
    displayName: "Cursor",
    config: {},
  },
};
(
  window as unknown as { settingsDesignSearch: typeof scrollToSettingsTarget }
).settingsDesignSearch = scrollToSettingsTarget;
function App() {
  const [instances, setInstances] = useState(initial);
  const [selected, setSelected] = useState("cursor");
  const [favorites, setFavorites] = useState<Record<string, readonly string[]>>({});
  const [hidden, setHidden] = useState<Record<string, readonly string[]>>({});
  const [orders, setOrders] = useState<Record<string, readonly string[]>>({});
  const [writes, setWrites] = useState(0);
  const card = (id: string, mode: "list" | "editor") => (
    <ProviderInstanceCard
      key={`${id}-${mode}`}
      instanceId={ProviderInstanceId.make(id)}
      instance={instances[id]!}
      driverOption={getDriverOption(instances[id]!.driver)}
      mode={mode}
      selected={selected === id}
      onSelect={() => setSelected(id)}
      environmentLabel="M4"
      readOnly={query.has("readonly")}
      liveProvider={{
        instanceId: ProviderInstanceId.make(id),
        driver: instances[id]!.driver,
        enabled: !!instances[id]!.enabled,
        installed: id !== "cursor",
        version: "1.0.99",
        status: id === "cursor" ? "disabled" : "ready",
        auth: { status: id === "cursor" ? "unknown" : "authenticated" },
        models: id === "cursor" ? [] : [{ slug: "fixture-model", name: "Fixture model" }],
        checkedAt: "2026-10-24T00:00:00.000Z",
        slashCommands: [],
        skills: [],
      }}
      onUpdate={(next) => {
        setInstances((old) => ({ ...old, [id]: next }));
        setWrites((n) => n + 1);
      }}
      hiddenModels={hidden[id] ?? []}
      favoriteModels={favorites[id] ?? []}
      modelOrder={orders[id] ?? []}
      onHiddenModelsChange={(next) => setHidden((old) => ({ ...old, [id]: next }))}
      onFavoriteModelsChange={(next) => setFavorites((old) => ({ ...old, [id]: next }))}
      onModelOrderChange={(next) => setOrders((old) => ({ ...old, [id]: next }))}
    />
  );
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-6xl space-y-8 p-4 sm:p-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">SpecWithCode</p>
            <h1 className="text-2xl font-semibold">Settings</h1>
          </div>
          <button
            onClick={() => {
              setSelected("codex");
              requestAnimationFrame(() =>
                scrollToSettingsTarget("provider-instance-codex-runtime"),
              );
            }}
            className="rounded-md border px-3 py-2 text-sm"
          >
            Find runtime settings
          </button>
        </header>
        <SettingsSection title="Providers" reach={{ kind: "machine", name: "M4" }} variant="plain">
          <SettingsGroup
            divided={false}
            className="overflow-hidden md:grid md:grid-cols-[minmax(17rem,30%)_minmax(0,1fr)]"
          >
            <nav
              aria-label="Providers"
              className="divide-y divide-border/50 border-b md:border-b-0 md:border-r"
            >
              {Object.keys(instances).map((id) => card(id, "list"))}
            </nav>
            <div className="min-w-0 space-y-6 p-4">{card(selected, "editor")}</div>
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title="Appearance">
          <SettingsRow
            title="Theme"
            reach={{ kind: "device" }}
            description="Choose how the app looks here."
            control={
              <select
                aria-label="Theme"
                value={query.get("theme") ?? "light"}
                onChange={(event) => {
                  location.search = `theme=${event.target.value}`;
                }}
                className="rounded-md border bg-background p-2 text-sm"
              >
                <option>light</option>
                <option>dark</option>
              </select>
            }
          />
        </SettingsSection>
        <SettingsSection title="Project defaults" reach={{ kind: "project" }}>
          <SettingsRow
            title="Working directory"
            description="A project setting example."
            control={
              <input
                aria-label="Working directory"
                className="min-w-0 rounded-md border px-3 py-2 text-sm"
                defaultValue="/fixture/project"
              />
            }
          />
        </SettingsSection>
        <SettingsSection title="Connected machine preferences" reach={{ kind: "all" }}>
          <SettingsRow
            title="Notifications"
            description="Applies only to machines connected when this setting is saved."
            control={<input aria-label="Notifications" type="checkbox" defaultChecked />}
          />
        </SettingsSection>
        <output data-testid="writes" className="text-xs text-muted-foreground">
          Fixture writes: {writes}
        </output>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
