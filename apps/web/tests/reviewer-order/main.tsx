// Headless fixture: the production AdversarialReviewSettings and the shared
// fallback order list over synthetic providers that mirror the M4 (Codex at
// its weekly limit, two Copilot accounts, Devin of unknown billing, Muse, Claude).
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeFallbackOrder } from "@specweave-studio/shared/providerFallback";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { AdversarialReviewSettings } from "~/components/settings/AdversarialReviewSettings";
import { FallbackOrderList } from "~/components/settings/FallbackOrderList";
import { SettingsRow } from "./stubs/settingsLayout";
import { fixtureStore } from "./stubs/store";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const now = Date.now();
const reset = new Date(now + 2 * 86_400_000).toISOString();

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

const providers = [
  provider("claudeAgent", "claudeAgent", "Claude", 41, [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-fable-5-1", "Claude Fable 5.1"],
  ]),
  provider("codex", "codex", "Codex", 100, [
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
  ]),
  provider("acpRegistry_copilot_enterprise", "acpRegistry", "Copilot Enterprise (abycrash)", null, [
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["claude-opus-5.5", "Claude Opus 5.5"],
  ]),
  provider(
    "acpRegistry_copilot",
    "acpRegistry",
    "Copilot personal (anton-abyzov)",
    null,
    [
      ["gpt-6.1-sol", "GPT-6.1 Sol"],
      ["claude-opus-5.5", "Claude Opus 5.5"],
    ],
    { auth: { status: "unauthenticated" } },
  ),
  provider("acpRegistry_devin", "acpRegistry", "Devin", null, [["gpt-6.1-sol", "GPT-6.1 Sol"]], {
    iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg",
  }),
  provider("muse", "muse", "Muse Code", 12, [["muse-wonder-1.0", "Muse Wonder 1.0"]]),
];
fixtureStore.providers = providers;
fixtureStore.scope = params.get("scope") === "project" ? "project" : "app";

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const custom = params.get("state") === "custom";
fixtureStore.set({
  ...DEFAULT_SERVER_SETTINGS,
  adversarialReview: {
    autoOnFeatureComplete: custom,
    tier: "regular",
    reviewers: custom
      ? [
          sel("muse", "muse-wonder-1.0"),
          sel("codex", "gpt-6.1-sol"),
          sel("claudeAgent", "claude-opus-5-5"),
        ]
      : [],
  },
});

function FallbackOrderFixture() {
  const [order, setOrder] = useState<ReadonlyArray<ModelSelection>>([
    sel("codex", "gpt-6.1-sol"),
    sel("acpRegistry_copilot_enterprise", "claude-opus-5.5"),
    sel("muse", "muse-wonder-1.0"),
  ]);
  const statuses = new Map(
    describeFallbackOrder({
      providers,
      currentInstanceId: "__fallback-order__" as ModelSelection["instanceId"],
      rule: {
        providerLimitFallbackModels: [...order],
        providerLimitFallbackModelSelection: null,
        providerLimitExcludedModels: [],
      },
      nowMs: now,
    }).map((entry) => [
      `${entry.selection.instanceId}:${entry.selection.model}`,
      { status: entry.unavailable ?? ("ready" as const), resetAt: entry.resetAt },
    ]),
  );
  return (
    <SettingsRow
      id="provider-limit-fallback"
      title="Fallback order"
      description="The models a limited thread continues on, best first."
    >
      <FallbackOrderList
        order={order}
        providers={providers}
        onChange={setOrder}
        statuses={statuses as never}
      />
    </SettingsRow>
  );
}

function Fixture() {
  return (
    <main className="mx-auto max-w-3xl bg-background py-4 text-foreground sm:px-4">
      <h2 className="px-3 pb-1 text-sm font-semibold sm:px-4">
        Adversarial review{fixtureStore.scope === "project" ? " · project" : ""}
      </h2>
      <div className="rounded-2xl border border-border/70 bg-card">
        <AdversarialReviewSettings />
      </div>
      {params.get("fallback") === "1" ? (
        <>
          <h2 className="px-3 pt-6 pb-1 text-sm font-semibold sm:px-4">When a model runs out</h2>
          <div className="rounded-2xl border border-border/70 bg-card">
            <FallbackOrderFixture />
          </div>
        </>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
