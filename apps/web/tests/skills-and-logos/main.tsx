import { createRoot } from "react-dom/client";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { ProjectSkillsView } from "../../src/components/settings/ProjectSkillsSettings";
import { ProviderLogo, type ProviderBrand } from "../../src/components/ProviderLogo";
import { ProviderInstanceIcon } from "../../src/components/chat/ProviderInstanceIcon";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

// The Skills page as it renders inside the Settings dialog (same layer classes).
function Fixture() {
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-xs dark:bg-black/55" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <div
          role="dialog"
          aria-label="Settings"
          className="flex h-full max-h-[52rem] w-full max-w-6xl flex-col overflow-y-auto rounded-2xl border bg-background"
        >
          <ProjectSkillsView
            environmentId={EnvironmentId.make("local")}
            projectId={ProjectId.make("fixture")}
            folder="/Users/developer/scratch"
          />
        </div>
      </div>
    </>
  );
}
const BRANDS: ReadonlyArray<ProviderBrand> = [
  "claude",
  "openai",
  "grok",
  "gemini",
  "copilot",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "meta",
  "ollama",
  "qwen",
  "kimi",
  "mistral",
  "kiro",
  "goose",
  "cline",
  "auggie",
  "factory",
  "amp",
  "junie",
];
const INSTANCES: ReadonlyArray<readonly [string, string, string?]> = [
  ["claudeAgent", "Claude"],
  ["codex", "Codex"],
  ["grok", "Grok"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["antigravity", "Antigravity"],
  ["pi", "Pi"],
  ["muse", "Muse Code"],
  ["acpRegistry", "Copilot", "github-copilot-cli"],
  ["acpRegistry", "Gemini", "gemini"],
  ["acpRegistry", "Qwen Code", "qwen-code"],
  ["acpRegistry", "Unknown agent"],
];

// Every provider mark through the shared component, at the sizes the app uses.
function Logos() {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="mb-4 text-sm font-semibold">Provider marks (ProviderLogo)</h1>
      <div className="grid grid-cols-7 gap-3">
        {BRANDS.map((brand) => (
          <div key={brand} className="flex flex-col items-center gap-2 rounded-lg border p-3">
            <div className="flex items-end gap-3">
              <ProviderLogo brand={brand} className="size-3.5" />
              <ProviderLogo brand={brand} className="size-5" />
              <ProviderLogo brand={brand} className="size-8" />
            </div>
            <span className="text-xs text-muted-foreground">{brand}</span>
          </div>
        ))}
      </div>
      <h2 className="mt-6 mb-3 text-sm font-semibold">Provider instances (ProviderInstanceIcon)</h2>
      <div className="flex flex-wrap gap-2">
        {INSTANCES.map(([driver, name, agentId]) => (
          <span
            key={name}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
          >
            <ProviderInstanceIcon
              driverKind={driver as never}
              displayName={name}
              acpRegistryAgentId={agentId}
              iconClassName="size-4"
            />
            {name}
          </span>
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  params.get("view") === "logos" ? <Logos /> : <Fixture />,
);
