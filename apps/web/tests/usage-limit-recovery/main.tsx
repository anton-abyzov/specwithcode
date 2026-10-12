import { createRoot } from "react-dom/client";
import {
  CommandId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2LimitRecovery,
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
const item = usageLimitRecoveryBannerItem({
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
      <ComposerSurface.Shell>
        <form
          className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
          data-chat-composer-form="true"
        >
          <ComposerBanner.Dock>
            <ComposerBanner.Column>
              <ComposerBannerStack className="relative z-0" items={[item]} />
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
