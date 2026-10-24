import { useState } from "react";
import { UsageWarningLabel } from "../../src/components/chat/UsageWarningLabel";
import { createRoot } from "react-dom/client";
import {
  CommandId,
  ProviderInstanceId,
  RunId,
  type ModelSelection,
  type OrchestrationV2LimitRecovery,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeFallbackOrder } from "@specweave-studio/shared/providerFallback";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import {
  canSelectManualFallback,
  fallbackUnavailableReason,
  limitFallbackPairingBannerItem,
  usageLimitRecoveryBannerItem,
} from "../../src/components/chat/UsageLimitRecoveryBanner";
import { FallbackOrderList } from "../../src/components/settings/FallbackOrderList";
import "./fixture.css";

// The production recovery card in the composer's own column, as a thread stopped by a
// weekly limit shows it: fallback, armed auto-resume, Check now, Snooze and a status line.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const runId = RunId.make("fixture-run");
const resetAt = new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString();
const recovery: OrchestrationV2LimitRecovery = {
  runId,
  resetAt,
  autoResume: true,
  requestId: CommandId.make("fixture-choice"),
  ...(params.get("status") === "none"
    ? {}
    : {
        availability: {
          checkedAt: new Date().toISOString(),
          retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          threadUpdatedAt: new Date().toISOString(),
          status: "changed" as const,
          affinity: {
            instanceId: ProviderInstanceId.make("codex"),
            continuationKey: "fixture",
            quotaPoolId: "fixture",
          },
        },
      }),
};
const at = new Date().toISOString();
const creditProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: "codex" as ServerProvider["driver"],
  enabled: true,
  installed: true,
  status: "warning",
  auth: { status: "authenticated", type: "chatgpt" },
  checkedAt: at,
  models: [{ slug: "gpt-6.1-sol", name: "Sol", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
  usageLimits: {
    checkedAt: at,
    windows: [],
    nativeAllowanceObservedAt: at,
    quotaPoolObservedAt: at,
    nativeRouteObservedAt: at,
    nativeRouteVerified: true,
    quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
    ordinaryUsageAllowed: false,
    spendControlReached: false,
    rateLimitReachedType: "rate_limit_reached",
    credits: { hasCredits: true, unlimited: false, balance: "39034.0733405" },
  },
};
const orderProvider = (id: string, name: string, models: ReadonlyArray<[string, string]>) =>
  ({
    ...creditProvider,
    instanceId: ProviderInstanceId.make(id),
    displayName: name,
    models: models.map(([slug, label]) => ({
      slug,
      name: label,
      isCustom: false,
      capabilities: null,
    })),
  }) as ServerProvider;
const orderProviders = [
  orderProvider("codex", "Codex", [
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ]),
  orderProvider("claudeAgent", "Claude", [["claude-opus-5-5", "Claude Opus 5.5"]]),
];
const fallbackOrder: ReadonlyArray<ModelSelection> = [
  { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
] as ReadonlyArray<ModelSelection>;
const manualChoiceProviders: ReadonlyArray<ServerProvider> = [
  {
    ...orderProviders[0]!,
    status: "ready",
    usageLimits: undefined,
  },
  {
    ...orderProviders[1]!,
    displayName: "Claude Code",
    driver: "claudeAgent" as ServerProvider["driver"],
  },
  {
    ...orderProvider("claude-api", "Claude API", [["claude-opus-5-5", "Claude Opus 5.5"]]),
    driver: "claudeAgent" as ServerProvider["driver"],
    status: "ready",
    auth: { status: "authenticated", type: "apiKey" },
    usageLimits: undefined,
  },
  {
    ...orderProvider("claude-warning", "Claude Code (warning)", [
      ["claude-opus-5-5", "Claude Opus 5.5"],
    ]),
    driver: "claudeAgent" as ServerProvider["driver"],
    usageLimits: {
      checkedAt: at,
      windows: [{ id: "weekly", label: "Weekly", usedPercent: 100, resetsAt: resetAt }],
    },
  },
];
const manualChoices = describeFallbackOrder({
  providers: manualChoiceProviders,
  currentInstanceId: ProviderInstanceId.make("stopped-provider"),
  rule: {
    providerLimitFallbackModelSelection: null,
    providerLimitFallbackModels: [
      { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
      { instanceId: ProviderInstanceId.make("claude-api"), model: "claude-opus-5-5" },
      { instanceId: ProviderInstanceId.make("claude-warning"), model: "claude-opus-5-5" },
      { instanceId: ProviderInstanceId.make("missing-provider"), model: "default" },
    ],
  },
  limitedInstanceIds: new Set(["claudeAgent"]),
  nowMs: Date.now(),
});
function Fixture() {
  const [choice, setChoice] = useState<OrchestrationV2LimitRecovery | null>(
    params.has("unarmed") ? null : recovery,
  );
  const item = usageLimitRecoveryBannerItem({
    ...(params.has("credits")
      ? {
          credits: {
            provider: creditProvider,
            context: {
              environmentId: "test",
              projectId: "test",
              threadId: "test",
              draftId: null,
              runtimeMode: "approval-required",
              selection: { instanceId: creditProvider.instanceId, model: "gpt-6.1-sol" },
              allowed: true,
            },
            onContinue: async () => {
              document.body.dataset.creditContinued = "true";
            },
          },
        }
      : {}),
    canCheck: !params.has("claude"),
    runId,
    resetAt,
    stoppedAt: new Date().toISOString(),
    snoozedUntil: null,
    recovery: choice,
    fallback: {
      label: params.has("claude") ? "Codex" : "Claude",
      model: params.has("claude") ? "GPT-6 Astra" : "Claude Opus 5.5",
      automatic: false,
      onContinue: async () => {
        document.body.dataset.handoff = "true";
      },
    },
    ...(params.has("choices")
      ? {
          fallbackChoices: manualChoices.map((entry) => {
            const label = entry.provider?.displayName ?? "Missing provider";
            const model =
              entry.provider?.models.find((model) => model.slug === entry.selection.model)?.name ??
              entry.selection.model;
            const choosable = canSelectManualFallback(entry);
            const unavailable = fallbackUnavailableReason(
              entry.unavailable,
              entry.resetAt,
              choosable,
            );
            return {
              label,
              model,
              ...(unavailable ? { unavailable } : {}),
              ...(choosable
                ? {
                    onContinue: async () => {
                      document.body.dataset.choice = `${label} · ${model}`;
                    },
                  }
                : {}),
            };
          }),
        }
      : {}),
    onChange: async (change) => {
      document.body.dataset.recoveryChange = JSON.stringify(change);
      setChoice((previous) => ({ ...recovery, ...previous, ...change }));
    },
  });

  const [order, setOrder] = useState<ReadonlyArray<ModelSelection>>(fallbackOrder);
  const pairing = params.get("pairing");
  const pairingItem =
    pairing === null
      ? null
      : limitFallbackPairingBannerItem({
          id: "pairing",
          current: "Codex · GPT-6 Astra",
          original: "Claude · Claude Opus 5.5",
          resetAt: pairing === "room" ? null : Date.parse(resetAt),
          hasRoom: pairing === "room",
          onBack: () => {
            document.body.dataset.back = "true";
          },
          onDismiss: () => {},
        });
  if (params.has("order"))
    return (
      <main
        className="mx-auto max-w-xl bg-background p-4"
        data-order={order.map((e) => e.model).join(",")}
      >
        <FallbackOrderList order={order} providers={orderProviders} onChange={setOrder} />
      </main>
    );
  return (
    <main className="flex min-h-screen flex-col justify-end bg-background px-3 pb-6 sm:px-5">
      {params.has("resolved") ? (
        <div data-resolved-warning="true" className="mb-4">
          <UsageWarningLabel resolved resetTime="Oct 20, 9:25 AM" />
        </div>
      ) : null}
      <ComposerSurface.Shell>
        <form
          className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
          data-chat-composer-form="true"
        >
          <ComposerBanner.Dock>
            <ComposerBanner.Column>
              <ComposerBannerStack
                className="relative z-0"
                items={params.has("resolved") ? [] : pairingItem ? [pairingItem] : [item]}
              />
            </ComposerBanner.Column>
          </ComposerBanner.Dock>
          <ComposerSurface.Host>
            <div className="min-h-24 p-4 text-sm text-muted-foreground">Ask anything</div>
          </ComposerSurface.Host>
        </form>
      </ComposerSurface.Shell>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
