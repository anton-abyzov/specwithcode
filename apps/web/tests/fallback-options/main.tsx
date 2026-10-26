// Headless fixture: the production FallbackOptionsPanel over synthetic providers
// that mirror the M4 (a Claude plan with twelve models, Codex, Grok, two Copilot instances,
// Gemini on Vertex).
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  describeFallbackOptions,
  toggleExcludedModel,
} from "@specweave-studio/shared/fallbackOptions";
import type { ExcludedFallbackModel } from "@specweave-studio/shared/providerFallback";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { FallbackOptionsPanel } from "~/components/settings/FallbackOptionsPanel";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const now = Date.parse("2026-10-24T16:00:00.000Z");
const reset = "2026-10-24T18:30:00.000Z";

function provider(
  id: string,
  driver: string,
  name: string,
  used: number | null,
  models: ReadonlyArray<readonly [string, string]>,
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
    checkedAt: new Date(now).toISOString(),
    ...(driver === "acpRegistry" && /^copilot/.test(id)
      ? { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" }
      : {}),
    version: null,
    models: models.map(([slug, label]) => ({
      slug,
      name: label,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: new Date(now).toISOString(),
            windows: [
              {
                id: "five_hour",
                kind: "session" as const,
                label: "Session",
                usedPercent: used,
                resetsAt: reset,
              },
            ],
          },
        }),
    ...over,
  };
}

const providers = [
  provider("claudeAgent", "claudeAgent", "Claude", 49, [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-fable-5-1", "Claude Fable 5.1"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude-fable-5", "Claude Fable 5"],
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-opus-4-7", "Claude Opus 4.7"],
    ["claude-opus-4-6", "Claude Opus 4.6"],
    ["claude-opus-4-5", "Claude Opus 4.5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ]),
  provider("copilot-0889", "acpRegistry", "GitHub Copilot", null, [], {
    models: [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5", isCustom: true, capabilities: null },
    ],
  }),
  provider(
    "acpRegistry_copilot",
    "acpRegistry",
    "Copilot managed",
    null,
    [["claude-opus-5.5", "Claude Opus 5.5"]],
    {
      auth: { status: "unauthenticated" },
    },
  ),
  provider("codex", "codex", "Codex", 42, [
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ]),
  provider(
    "acpRegistry_gemini",
    "acpRegistry",
    "Gemini CLI (Vertex AI)",
    8,
    [["gemini-4-argon", "Gemini Argon 4"]],
    {
      auth: { status: "authenticated", type: "vertex" },
    },
  ),
  provider("grok", "grok", "Grok", 6, [["grok-4.7", "Grok 4.7"]]),
];

function Fixture() {
  const [excluded, setExcluded] = useState<ReadonlyArray<ExcludedFallbackModel>>(
    params.get("state") === "edited"
      ? [{ model: "grok-4.7" }, { model: "gpt-6-luna" }, { model: "claude-opus-4-5" }]
      : [],
  );
  const groups = describeFallbackOptions({
    providers,
    rule: {
      providerLimitFallbackModelSelection: null,
      providerLimitFallbackModels: [
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      ],
      providerLimitExcludedModels: excluded,
    },
    nowMs: now,
    belowPercent: 95,
  });
  return (
    <main className="mx-auto max-w-3xl bg-background p-4 text-foreground">
      <h3 className="mb-1 text-sm font-medium">Where a limited thread can continue</h3>
      <p data-testid="excluded-count" className="mb-3 text-xs text-muted-foreground">
        {excluded.length === 0 ? "Nothing excluded" : `${excluded.length} excluded`}
      </p>
      <FallbackOptionsPanel
        groups={groups}
        onToggleExcluded={(model, instanceId) =>
          setExcluded(toggleExcludedModel(excluded, model, instanceId))
        }
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
