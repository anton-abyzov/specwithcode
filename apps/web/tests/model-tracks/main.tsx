// Headless fixture: the production ModelTracksSettings over synthetic
// providers shaped like a real machine (Claude Code with room, Codex at its
// limit, Copilot Enterprise, a signed-out Cursor, Muse Code, a free ChatGPT
// plan and a Claude API key that is never picked on its own).
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
  provider("claudeAgent", "claudeAgent", "Claude Code", 13, [opus, fable]),
  provider("codex", "codex", "Codex", 100, [sol, astra]),
  provider("codex-free", "codex", "Codex (ChatGPT Free)", 4, [luna], {
    auth: { status: "authenticated", label: "ChatGPT Free Subscription" },
  }),
  provider("cursor", "cursor", "Cursor", null, [fable], { auth: { status: "unauthenticated" } }),
  provider("muse", "muse", "Muse Code", 5, [["muse-wonder-1.0", "Muse Wonder 1.0"]]),
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
