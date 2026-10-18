/* Isolated chat fixture: the production thread header line and timeline with synthetic rows, no host. */
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@specweave-studio/contracts";

import { ChatHeader } from "../../src/components/chat/ChatHeader";
import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import { ThreadMetaRow } from "../../src/components/chat/ThreadMetaRow";
import { ThreadPlanCard } from "../../src/components/chat/ThreadPlanCard";
import { ThreadHeaderLine, ThreadProgressDock } from "../../src/components/chat/ThreadProgressDock";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import type { TimelineEntry } from "../../src/session-logic";
import type { ThreadPlanView } from "../../src/studio/threadPlanProgress";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const run = RunId.make("run-1");
const startedAt = Date.now() - 40_000;
const at = (second: number) => new Date(startedAt + second * 1000).toISOString();

function request(id: string, time: string, text: string, createdBy?: "agent"): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: time,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: run,
      createdAt: time,
      updatedAt: time,
      streaming: false,
      ...(createdBy ? { createdBy } : {}),
    },
  };
}

function reply(id: string, time: string, text: string): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: time,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      runId: run,
      createdAt: time,
      updatedAt: time,
      streaming: false,
    },
  };
}

// The view from the report: a scratch chat another agent asked to reply "ok".
const entries: TimelineEntry[] = [
  request("ask", at(0), "Reply with exactly the word: ok", "agent"),
  reply("answer", at(4), "ok"),
  request("follow-up", at(20), "Thanks. Now list the files in this folder."),
  reply("answer-2", at(26), "The folder is empty apart from `.specweave/`."),
];

// A worker thread with no increment and no todo list yet.
const noPlan: ThreadPlanView = {
  source: "none",
  steps: [],
  completed: 0,
  total: 0,
  current: null,
  next: null,
  increment: null,
} as unknown as ThreadPlanView;

// ?plan=todo: a thread working through the agent's todo list.
const step = (key: string, text: string, state: "done" | "current" | "open") => ({
  key,
  id: null,
  text,
  state,
  note: null,
});
const todoPlan = {
  source: "todo",
  steps: [
    step("1", "Read the chat view", "done"),
    step("2", "Fold the header into one line", "current"),
    step("3", "Take screenshots", "open"),
  ],
  completed: 1,
  total: 3,
  current: "Fold the header into one line",
  next: "Take screenshots",
  increment: null,
} as unknown as ThreadPlanView;
const plan = params.get("plan") === "todo" ? todoPlan : noPlan;

const environmentId = EnvironmentId.make("MacBook M4MAX");
const listRef = createRef<LegendListRef | null>();
const noop = () => {};

function Fixture() {
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <header
        data-chat-header
        className="relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-background pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)"
      >
        <ChatHeader
          activeThreadEnvironmentId={environmentId}
          activeThreadId={ThreadId.make("fixture-thread")}
          activeThreadTitle="Scratch Grok check"
          isServerThread
          activeProject={null}
          rightPanelOpen={false}
          onNewThreadInProject={noop}
        />
      </header>
      {/* ChatView overlays this dock on the timeline and reserves its height; here it sits above it. */}
      <ThreadProgressDock>
        <ThreadHeaderLine>
          <ThreadMetaRow
            origin={null}
            folder={{
              label: "2026-10-16-reply-with-exactly",
              path: "/Users/dev/.specwithcode/chats/2026-10-16-reply-with-exactly",
            }}
            run={{ startedAt: at(0), completedAt: at(4) }}
            pullRequests={[]}
            onOpenPullRequest={noop}
          />
          <ThreadPlanCard plan={plan} onOpenPath={null} onLinkIncrement={noop} />
        </ThreadHeaderLine>
      </ThreadProgressDock>
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={entries}
          latestRun={{ runId: run, status: "completed", startedAt: at(0), completedAt: at(26) }}
          runningRunId={null}
          turnDiffSummaries={[]}
          providerStatuses={[]}
          runs={[]}
          routeThreadKey="fixture-host:fixture-thread"
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
          resolvedTheme={params.get("theme") === "dark" ? "dark" : "light"}
          timestampFormat="24-hour"
          workspaceRoot="/Users/dev/.specwithcode/chats/2026-10-16-reply-with-exactly"
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={false}
          onIsAtEndChange={noop}
          onManualNavigation={noop}
        />
      </div>
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
