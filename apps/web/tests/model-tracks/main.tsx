// Headless fixture: the production ModelTracksSettings over synthetic
// providers shaped like a real machine (Claude Code with room, Codex at its
// limit, Copilot Enterprise, a signed-out Cursor, Muse Code with Wonder and
// Wonder Full, a free ChatGPT plan and a Claude API key that is never picked
// on its own). Every model but Copilot's offers effort levels.
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { ModelTracksSettings } from "~/components/settings/ModelTracksSettings";
import { fixtureStore } from "../reviewer-order/stubs/store";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const now = Date.now();
const reset = new Date(now + 3 * 3_600_000).toISOString();

const LEVEL_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
function effortLevels(slug: string) {
  const [id, levels] = slug.startsWith("muse-")
    ? ["reasoningEffort", ["minimal", "low", "medium", "high", "xhigh", "max"]]
    : slug.startsWith("gpt-")
      ? ["reasoningEffort", ["low", "medium", "high", "xhigh", "max"]]
      : ["effort", ["low", "medium", "high", "xhigh", "max"]];
  return {
    optionDescriptors: [
      {
        id,
        label: "Reasoning",
        type: "select" as const,
        options: levels.map((level) => ({
          id: level,
          label: LEVEL_LABELS[level] ?? level,
          ...(level === "high" ? { isDefault: true } : {}),
        })),
      },
    ],
  };
}

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
    ...(/copilot/i.test(id)
      ? { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" }
      : {}),
    version: null,
    // Each harness offers its own effort levels; GitHub Copilot here offers none.
    models: models.map(([slug, label]) => ({
      slug,
      name: label,
      isCustom: false,
      capabilities: /copilot/i.test(id) ? null : effortLevels(slug),
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
                id: "seven_day",
                kind: "weekly" as const,
                label: "Weekly",
                usedPercent: used,
                resetsAt: reset,
              },
            ],
          },
        }),
    ...over,
  };
}

const opus = ["claude-opus-5-5", "Claude Opus 5.5"] as const;
const fable = ["claude-fable-5-2", "Claude Fable 5.2"] as const;
const sonnet = ["claude-sonnet-5-5", "Claude Sonnet 5.5"] as const;
const sol = ["gpt-6.1-sol", "GPT-6.1 Sol"] as const;
const astra = ["gpt-6-astra", "GPT-6 Astra"] as const;
const luna = ["gpt-6-luna", "GPT-6 Luna"] as const;

fixtureStore.providers = [
  provider("acpRegistry_copilot", "acpRegistry", "GitHub Copilot Enterprise", null, [
    ["claude-opus-5.5", "Claude Opus 5.5"],
    sol,
    astra,
    luna,
  ]),
  provider("claude-api", "claudeAgent", "Claude API key", null, [opus], {
    auth: { status: "authenticated", type: "apiKey" },
  }),
  provider("claudeAgent", "claudeAgent", "Claude Code", 13, [opus, sonnet, fable]),
  provider("codex", "codex", "Codex", 100, [sol, astra]),
  provider("codex-free", "codex", "Codex (ChatGPT Free)", 4, [luna], {
    auth: { status: "authenticated", label: "ChatGPT Free Subscription" },
  }),
  provider("cursor", "cursor", "Cursor", null, [fable], { auth: { status: "unauthenticated" } }),
  provider("muse", "muse", "Muse Code", 5, [
    ["muse-wonder-1.0", "Muse Wonder 1.0"],
    ["muse-wonder-full-1.0", "Muse Wonder Full 1.0"],
  ]),
];

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const custom = params.get("state") === "custom";
fixtureStore.set({
  ...DEFAULT_SERVER_SETTINGS,
  ...(custom
    ? {
        modelLanes: {
          routine: [sel("codex", "gpt-6.1-sol"), sel("claudeAgent", "claude-opus-5-5")],
          complex: [],
        },
        defaultModelProviders: [ProviderInstanceId.make("acpRegistry_copilot")],
        adversarialReview: {
          ...DEFAULT_SERVER_SETTINGS.adversarialReview,
          reviewers: [sel("codex", "gpt-6.1-sol"), sel("codex", "gpt-6-astra")],
        },
      }
    : {}),
});
// The verifier reads what a move saved.
Object.assign(window, { fixtureSettings: () => fixtureStore.get() });

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl p-4">
    <ModelTracksSettings />
  </main>,
);
