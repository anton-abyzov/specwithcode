import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { listedSources } from "@specweave-studio/shared/modelSources";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { Card } from "../../src/components/settings/ModelListParts";
import { MissingTrackSource, SourcesCard } from "../../src/components/settings/ModelSourcesCard";
import "./fixture.css";

// Settings > Models on a machine with Codex and Claude on, Muse and
// Antigravity off with no CLI, Cursor signed out, Copilot ready. Fictional data.
const env = EnvironmentId.make("fixture");
const checkedAt = "2026-11-18T08:00:00.000Z";
const nowMs = Date.parse(checkedAt);

function provider(
  id: string,
  driver: string,
  name: string,
  slugs: ReadonlyArray<string>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...over,
  };
}

const off = { enabled: false, installed: false, status: "disabled" } as const;
const providers: ServerProvider[] = [
  provider("codex", "codex", "Codex", ["gpt-6.1-sol"]),
  provider("claudeAgent", "claudeAgent", "Claude", ["claude-opus-5-5"]),
  provider("acpRegistry_copilot", "acpRegistry", "GitHub Copilot", ["gpt-6.1-sol"], {
    iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
  }),
  provider("cursor", "cursor", "Cursor", [], {
    status: "error",
    auth: { status: "unauthenticated" },
  }),
  provider("muse", "muse", "Muse Code", [], off),
  provider("antigravity", "antigravity", "Antigravity", [], off),
];
const sourceName = (entry: ServerProvider) => entry.displayName ?? entry.instanceId;
const configuredAgents = new Set(["github-copilot-cli"]);

function Fixture() {
  const [order, setOrder] = useState<ReadonlyArray<ProviderInstanceId>>([
    ProviderInstanceId.make("codex"),
    ProviderInstanceId.make("claudeAgent"),
  ]);
  const review = [
    { model: "muse-wonder-full-1.0", name: "Muse Wonder Full 1.0" },
    { model: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  ];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <Card
        id="model-track-review"
        title="Review"
        hint="A different model family checks finished work"
      >
        <ol className="flex flex-col">
          {review.map((row, index) => (
            <li
              key={row.model}
              className="flex items-center gap-2 border-b border-border/70 px-3 py-2 last:border-b-0"
            >
              <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{row.name}</span>
                <ul className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <MissingTrackSource
                    environmentId={env}
                    providers={providers}
                    model={row.model}
                    nowMs={nowMs}
                    sourceName={sourceName}
                    configuredAgents={configuredAgents}
                  />
                </ul>
              </div>
            </li>
          ))}
        </ol>
      </Card>
      <SourcesCard
        environmentId={env}
        rows={listedSources({ providers, order, nowMs })}
        providers={providers}
        order={order}
        nowMs={nowMs}
        sourceName={sourceName}
        configuredAgents={configuredAgents}
        onSave={setOrder}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
