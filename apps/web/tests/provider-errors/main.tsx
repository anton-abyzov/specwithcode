/* Real banner and timeline, synthetic projection and callbacks. No host or provider. */
import { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  MessageId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { threadErrorIsLive } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { ThreadErrorBanner } from "../../src/components/chat/ThreadErrorBanner";
import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import type { ContextLimitRecoveryActions } from "../../src/components/chat/ContextLimitRecovery";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { providerErrorPresentation, type TimelineEntry } from "../../src/session-logic";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
const caseName = params.get("case") ?? "gemini";
const compactMode = params.get("compact") ?? "supported";
const now = Date.now();
const history = caseName === "history";
const recovered = caseName === "recovered";
const running = caseName === "running";
const occurredAt = new Date(now - (history ? 2 * 60 * 60_000 : 10_000)).toISOString();
const startedAt = new Date(Date.parse(occurredAt) - 15_000).toISOString();
const at = DateTime.makeUnsafe(occurredAt);
const runId = RunId.make("fixture-provider-error-run");
const threadId = ThreadId.make("fixture-provider-error-thread");
const environmentId = EnvironmentId.make("fixture-provider-error-host");

const geminiMessage = JSON.stringify({
  error: {
    message: JSON.stringify(
      {
        error: {
          code: 400,
          message: "The input token count exceeds the maximum number of tokens allowed 1048576.",
          status: "INVALID_ARGUMENT",
        },
      },
      null,
      2,
    ),
    code: 400,
    status: "Bad Request",
  },
});

const failure: OrchestrationV2ProviderFailure = {
  class: caseName === "quota" ? "usage_limit" : "provider_error",
  message:
    caseName === "plain"
      ? "The provider could not connect. Try again."
      : caseName === "quota"
        ? "Your usage limit was reached. Try again after 2026-10-23T14:00:00.000Z."
        : caseName === "nested"
          ? JSON.stringify(JSON.stringify(geminiMessage))
          : geminiMessage,
  code: caseName === "quota" ? "quota_exhausted" : "400",
  retryable: false,
  ...(caseName === "quota" ? { resetAt: "2026-10-23T14:00:00.000Z" } : {}),
};

const item: Extract<OrchestrationV2TurnItem, { type: "error" }> = {
  id: TurnItemId.make("fixture-provider-error-item"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: ProviderThreadId.make("fixture-native-thread"),
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: recovered ? "completed" : running ? "running" : "failed",
  title: caseName === "quota" ? "Usage limit reached" : "Provider error",
  startedAt: DateTime.makeUnsafe(startedAt),
  completedAt: running ? null : at,
  updatedAt: at,
  type: "error",
  failure,
  ...(recovered || running
    ? { retry: { attempt: 2, maxAttempts: 10, retryDelayMs: running ? 1_000 : null } }
    : {}),
};

const presentation = providerErrorPresentation(item);
const entries: TimelineEntry[] = [
  {
    id: "fixture-request",
    kind: "message",
    createdAt: startedAt,
    message: {
      id: MessageId.make("fixture-request"),
      role: "user",
      text: "Continue the implementation and verify the result.",
      runId,
      createdAt: startedAt,
      updatedAt: startedAt,
      streaming: false,
    },
  },
  {
    id: item.id,
    kind: "work",
    createdAt: occurredAt,
    entry: {
      id: item.id,
      createdAt: occurredAt,
      runId,
      label: presentation.label,
      detail: presentation.detail,
      tone: "info",
      itemType: "error",
      toolLifecycleStatus: recovered ? "completed" : running ? "inProgress" : "failed",
      structuredPayload: item,
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      },
    },
  },
];

const listRef = createRef<LegendListRef | null>();
const noop = () => {};

function Fixture() {
  const [compactCount, setCompactCount] = useState(0);
  const [newThreadCount, setNewThreadCount] = useState(0);
  const [dismissCount, setDismissCount] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const recovery: ContextLimitRecoveryActions = {
    failureItemId: params.get("owner") === "other" ? "another-root-error" : item.id,
    onNewThread: () => setNewThreadCount((count) => count + 1),
    ...(compactMode !== "unsupported"
      ? {
          onCompactContext: () => setCompactCount((count) => count + 1),
          compactDisabledReason:
            compactMode === "disabled" ? "Compacting is unavailable right now" : null,
        }
      : {}),
  };
  const liveFailure =
    !dismissed &&
    item.status === "failed" &&
    threadErrorIsLive({ errorAt: occurredAt, settled: false, nowMs: now });

  return (
    <main
      className="fixture-shell bg-background text-foreground"
      data-fixture-ready="true"
      data-case={caseName}
      data-compact={compactMode}
    >
      <header className="fixture-header">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          SpecWithCode · isolated UI fixture
        </p>
        <h1 className="mt-2 text-xl font-semibold">Provider error recovery</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {history
            ? "Earlier failures stay in the work log."
            : recovered
              ? "A recovered retry stays in the work log."
              : running
                ? "An automatic retry keeps its progress."
                : "The provider response appears in the banner and the work log."}
        </p>
      </header>
      <section className="fixture-banner" aria-label="Thread error banner">
        <ThreadErrorBanner
          error={liveFailure ? failure.message : null}
          errorClass={params.get("unclassified") === "true" ? null : failure.class}
          contextLimitRecovery={recovery}
          onDismiss={() => {
            setDismissed(true);
            setDismissCount((count) => count + 1);
          }}
        />
      </section>
      <section className="fixture-timeline" aria-label="Production messages timeline">
        <MessagesTimeline
          isWorking={false}
          activeTurnInProgress={false}
          listRef={listRef}
          timelineEntries={entries}
          latestRun={{
            runId,
            status: recovered ? "completed" : running ? "running" : "failed",
            startedAt,
            completedAt: running ? null : occurredAt,
          }}
          turnDiffSummaries={[]}
          providerStatuses={[]}
          runs={[]}
          routeThreadKey="fixture-provider-error-host:fixture-provider-error-thread"
          contextLimitRecovery={recovery}
          onOpenTurnDiff={noop}
          onOpenThread={noop}
          onForkFromRun={async () => {}}
          onRollbackCheckpoint={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={undefined}
          resolvedTheme={theme}
          timestampFormat="24-hour"
          workspaceRoot="/scratch/provider-errors"
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={false}
          onIsAtEndChange={noop}
          onManualNavigation={noop}
        />
      </section>
      <footer className="fixture-counters border-t border-border text-muted-foreground">
        <span>
          Compact: <output data-testid="compact-count">{compactCount}</output>
        </span>
        <span>
          New thread: <output data-testid="new-thread-count">{newThreadCount}</output>
        </span>
        <span>
          Dismiss: <output data-testid="dismiss-count">{dismissCount}</output>
        </span>
      </footer>
    </main>
  );
}

function App() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <Fixture />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: App }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
