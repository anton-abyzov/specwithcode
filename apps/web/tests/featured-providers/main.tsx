import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FeaturedAcpProviderCards } from "../../src/components/settings/FeaturedAcpProviders";
import {
  type AcpRegistrySearchAgent,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@specweave-studio/contracts";
import { AcpRegistryRepair } from "../../src/components/settings/AcpRegistryRepair";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const state = params.get("state") || "ready";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.documentElement.dir = params.get("dir") || "ltr";
const agent = (id: string): AcpRegistrySearchAgent => ({
  id,
  name: id,
  version: "1.2.3-fixture",
  description: "Fixture metadata",
  authors: [],
  license: null,
  website: null,
  repository: null,
  icon: null,
  distribution: "npx",
  integrity: "registry",
});
function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const query = (id: string) => ({
    data: state === "missing" ? { agents: [] } : { agents: [agent(id)] },
    error: state === "error" && !retried ? "Registry unavailable" : null,
    isPending: state === "loading",
    refresh: () => setRetried(true),
  });
  return (
    <main className="mx-auto min-h-screen max-w-2xl space-y-5 p-4 sm:p-8">
      <div>
        <p className="text-xs text-muted-foreground">
          Isolated UI fixture · no provider installation
        </p>
        <h1 className="mt-2 text-xl font-semibold">
          {params.get("view") === "repair" ? "Provider settings" : "Add provider"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Connected environment: Remote worker</p>
      </div>
      {params.get("view") === "repair" ? (
        <AcpRegistryRepair
          environmentId={EnvironmentId.make("remote-worker")}
          instanceId={ProviderInstanceId.make("copilot_work")}
          instance={{
            driver: ProviderDriverKind.make("acpRegistry"),
            config: {
              agentId: "github-copilot-cli",
              ...(state === "override" ? { commandPath: "/custom/copilot" } : {}),
            },
          }}
          readOnly={state === "readonly"}
        />
      ) : (
        <FeaturedAcpProviderCards
          providerInstances={
            state === "added"
              ? {
                  gemini_work: {
                    driver: ProviderDriverKind.make("acpRegistry"),
                    config: { agentId: "gemini" },
                  },
                }
              : {}
          }
          canManageProviders={state !== "readonly"}
          preparingId={state === "preparing" ? "grok-build" : null}
          onPrepare={(entry) => setSelected(entry.id)}
          onManage={(instanceId) => setSelected(`manage:${instanceId}`)}
          copilot={query("github-copilot-cli")}
          grok={query("grok-build")}
          gemini={query("gemini")}
        />
      )}
      <p data-testid="selected" role="status" className="text-sm text-muted-foreground">
        {selected ? `Selected ${selected}` : "No installation requested"}
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <div
    style={{
      minHeight: "100vh",
      background: params.get("theme") === "dark" ? "#0a0a0a" : "#fafafa",
    }}
  >
    <Fixture />
  </div>,
);
