import { UsageWarningLabel } from "../../src/components/chat/UsageWarningLabel";
import { createRoot } from "react-dom/client";
import {
  CommandId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2LimitRecovery,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { usageLimitRecoveryBannerItem } from "../../src/components/chat/UsageLimitRecoveryBanner";
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
  canCheck: true,
  runId,
  resetAt,
  stoppedAt: new Date().toISOString(),
  snoozedUntil: null,
  recovery,
  fallback: {
    label: "Claude",
    model: "claude-opus",
    automatic: false,
    onContinue: async () => {},
  },
  onChange: async () => {},
});

function Fixture() {
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
              <ComposerBannerStack className="relative z-0" items={params.has("resolved") ? [] : [item]} />
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
