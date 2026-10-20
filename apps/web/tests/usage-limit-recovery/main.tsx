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
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import {
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
          fallbackChoices: [
            {
              label: "Codex",
              model: "GPT-6.1 Sol",
              onContinue: async () => {
                document.body.dataset.choice = "Codex · GPT-6.1 Sol";
              },
            },
            { label: "Copilot", model: "Claude Opus 5.5", unavailable: "full until 11:19 PM" },
          ],
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
