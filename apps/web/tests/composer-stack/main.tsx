// Headless fixture: the production notice stack, the account change notice and the
// composer drawers, laid out the way ChatComposer docks them above its input.
import { RunId, RuntimeRequestId } from "@specweave-studio/contracts";
import type { PendingBackgroundWorkPresentation } from "@specweave-studio/client-runtime/state/thread-execution";
import { AlarmClockIcon, ListOrderedIcon, ShieldIcon, WifiOffIcon } from "lucide-react";
import { createRoot } from "react-dom/client";
import { accountChangedBannerItem } from "../../src/components/chat/AccountChangedBanner";
import {
  BackgroundWorkIcon,
  BackgroundWorkLabel,
  BackgroundWorkStopButton,
} from "../../src/components/chat/BackgroundWorkStrip";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import {
  ComposerBannerStack,
  type ComposerBannerStackItem,
} from "../../src/components/chat/ComposerBannerStack";
import { ComposerPendingUserInputPanel } from "../../src/components/chat/ComposerPendingUserInputPanel";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { usageLimitRecoveryBannerItem } from "../../src/components/chat/UsageLimitRecoveryBanner";
import { Button } from "../../src/components/ui/button";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { PendingUserInput } from "../../src/session-logic";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const scenario = params.get("case") ?? "screenshot";

const runId = RunId.make("fixture-run");
const usageLimit = usageLimitRecoveryBannerItem({
  canCheck: true,
  runId,
  resetAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
  stoppedAt: new Date().toISOString(),
  snoozedUntil: null,
  recovery: null,
  fallback: { label: "Codex", model: "GPT-6.1 Sol", automatic: false, onContinue: async () => {} },
  onChange: async () => {},
});
const accountChanged = accountChangedBannerItem({
  runId,
  providerName: "Claude",
  autoContinuing: scenario !== "account-manual",
  onContinue: async () => {},
  onDismiss: () => {},
});
const watchPresentation: PendingBackgroundWorkPresentation = {
  title: "Watching pull request #662",
  items: [
    {
      taskId: "watch-662",
      kind: "monitor",
      label: "Watching pull request #662",
      named: true,
      childThreadId: undefined,
    },
  ],
  waiting: true,
  kind: "monitor",
  named: true,
  shortLabel: "Watching pull request #662",
  fullLabel: "Watching pull request #662",
  countSummary: null,
};
const watcher: ComposerBannerStackItem = {
  id: "background-work:t",
  variant: "default",
  priority: "activity",
  icon: <BackgroundWorkIcon kind="monitor" running />,
  title: <BackgroundWorkLabel presentation={watchPresentation} onOpenRelatedThread={() => {}} />,
  actions: <BackgroundWorkStopButton stopping={false} disabled={false} onStop={() => {}} />,
};
const machineError: ComposerBannerStackItem = {
  id: "environment-unavailable:m4",
  variant: "error",
  icon: <WifiOffIcon />,
  title: "MacBook M4MAX is unreachable",
  description: "Last connected 4 min ago. Connection refused",
  actionsLayout: "wrap-below",
  actions: (
    <Button size="xs" variant="ghost">
      Reconnect
    </Button>
  ),
};
const woke: ComposerBannerStackItem = {
  id: "thread-woke:t",
  variant: "info",
  icon: <AlarmClockIcon />,
  title: "Thread woke from snooze",
  description: "Send a message to continue",
  dismissLabel: "Dismiss Woke notification",
  onDismiss: () => {},
};

const question = {
  requestId: RuntimeRequestId.make("ask-user:fixture"),
  createdAt: "2026-10-24T03:35:00.000Z",
  responseCapability: "message",
  responseMode: "message",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "Merge",
      question: "PR #662 passed checks. Merge it into main now?",
      multiSelect: false,
      allowCustomAnswer: true,
      options: [
        { label: "Merge now", description: "Squash-merge #662 and close 1042.", recommended: true },
        { label: "Wait for review", description: "Keep watching until a human approves." },
      ],
    },
  ],
} as PendingUserInput;
const questionDrawer = (
  <ComposerBanner.Attachment>
    <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info" density="default">
      <ComposerPendingUserInputPanel
        pendingUserInputs={[question]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
        onReplyInChat={() => {}}
      />
    </ComposerBanner.Root>
  </ComposerBanner.Attachment>
);
// Stand-ins for the queue and the approval drawer, from the primitives ChatComposer uses.
const queue = (
  <ComposerBanner.Attachment>
    <ComposerBanner.Root density="comfortable">
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          <ListOrderedIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="font-medium">2 queued messages</span>
          <span className="text-muted-foreground">held until the thread continues</span>
        </ComposerBanner.Content>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  </ComposerBanner.Attachment>
);
const approval = (
  <ComposerBanner.Attachment>
    <ComposerBanner.Root variant="warning" density="spacious">
      <ComposerBanner.Row layout="approval">
        <ComposerBanner.Icon>
          <ShieldIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="font-medium">Run gh pr merge 662 --squash?</span>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button size="xs" variant="outline">
            Deny
          </Button>
          <Button size="xs">Allow</Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  </ComposerBanner.Attachment>
);

const items: ComposerBannerStackItem[] =
  scenario === "watcher"
    ? [watcher]
    : scenario === "account" || scenario === "account-manual"
      ? [watcher, machineError, accountChanged]
      : scenario === "many"
        ? [watcher, woke, machineError, usageLimit]
        : [watcher, usageLimit];

function Fixture() {
  return (
    <main className="flex min-h-screen flex-col justify-end bg-background px-3 pb-6 sm:px-5">
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <form
            className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
            data-chat-composer-form="true"
          >
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                <ComposerBannerStack
                  className="relative z-0"
                  items={items}
                  attachedAbove={scenario === "many" ? queue : undefined}
                />
                {scenario === "many" ? approval : null}
                {scenario === "question" ? questionDrawer : null}
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
            <ComposerSurface.Main>
              <div className="min-h-24 p-4 text-sm text-muted-foreground">
                Ask anything, @tag files/folders, $use skills, or / for commands
                <div className="mt-6 text-foreground/80">Claude Code, Opus 5.5</div>
              </div>
            </ComposerSurface.Main>
          </form>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
);
