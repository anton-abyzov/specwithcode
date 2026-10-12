/* Isolated thread-view fixture: the production timeline with synthetic entries, no host. */
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
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { useClientSettings } from "../../src/hooks/useSettings";
import type { TimelineEntry } from "../../src/session-logic";
import { useTimelineDetailShortcut } from "../../src/timelineDetail";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const finishedRun = RunId.make("run-finished");
const liveRun = RunId.make("run-live");
// Times are relative to page load so the live turn reads "Working for 1m", not hours.
const startedAt = Date.now() - 3 * 60_000;
const at = (minute: number, second: number) =>
  new Date(startedAt + (minute * 60 + second) * 1000).toISOString();

function user(id: string, time: string, text: string): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: time,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: time,
      updatedAt: time,
      streaming: false,
    },
  };
}

function reply(id: string, runId: RunId, time: string, text: string): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: time,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      runId,
      createdAt: time,
      updatedAt: time,
      streaming: false,
    },
  };
}

function command(
  id: string,
  runId: RunId,
  time: string,
  input: string,
  output: string,
  status: "completed" | "inProgress" = "completed",
): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time,
    entry: {
      id,
      createdAt: time,
      runId,
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      command: input,
      detail: output,
      toolLifecycleStatus: status,
    },
  };
}

function thought(id: string, runId: RunId, time: string, text: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time,
    entry: {
      id,
      createdAt: time,
      runId,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      detail: text,
      toolLifecycleStatus: "completed",
    },
  };
}

function edit(id: string, runId: RunId, time: string, file: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time,
    entry: {
      id,
      createdAt: time,
      runId,
      label: "Edited file",
      tone: "tool",
      itemType: "file_change",
      changedFiles: [file],
      toolLifecycleStatus: "completed",
    },
  };
}

const entries: TimelineEntry[] = [
  user("ask-fix", at(0, 0), "The parser tests fail on main. Find out why and fix it."),
  reply("note-look", finishedRun, at(0, 4), "Running the parser tests to see the failure."),
  command(
    "cmd-test",
    finishedRun,
    at(0, 9),
    "pnpm test parser",
    "FAIL parser.test.ts > reads quoted keys\nExpected 'a b', received 'a'",
  ),
  thought(
    "thought-cause",
    finishedRun,
    at(0, 15),
    "The tokenizer stops at the first space even inside quotes.",
  ),
  reply("note-fix", finishedRun, at(0, 21), "The tokenizer splits quoted keys. Fixing it."),
  edit("edit-parser", finishedRun, at(0, 30), "src/parser.ts"),
  command("cmd-retest", finishedRun, at(0, 41), "pnpm test parser", "42 passed"),
  reply(
    "answer-fix",
    finishedRun,
    at(0, 48),
    "Fixed: quoted keys keep their spaces now, and all 42 parser tests pass.",
  ),
  user("ask-changelog", at(2, 0), "Add a changelog entry for it."),
  reply("note-read", liveRun, at(2, 3), "Reading the changelog first."),
  command(
    "cmd-cat",
    liveRun,
    at(2, 6),
    "sed -n 1,40p CHANGELOG.md",
    "## Unreleased\n- Nothing yet",
  ),
  thought("thought-where", liveRun, at(2, 9), "The entry belongs under Unreleased."),
  reply("note-write", liveRun, at(2, 12), "Adding the entry under Unreleased now."),
  command("cmd-fmt", liveRun, at(2, 15), "pnpm fmt CHANGELOG.md", "", "inProgress"),
];

const listRef = createRef<LegendListRef | null>();
const noop = () => {};

function Fixture() {
  useTimelineDetailShortcut();
  const detail = useClientSettings((settings) => settings.timelineDetail);
  return (
    <main className="flex h-screen flex-col bg-background text-foreground" data-detail={detail}>
      {/* The browser build's thread header, as ChatView lays it out, around the real ChatHeader. */}
      <header
        data-chat-header
        className="relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-background pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)"
      >
        <ChatHeader
          activeThreadEnvironmentId={EnvironmentId.make("fixture-host")}
          activeThreadId={ThreadId.make("fixture-thread")}
          activeThreadTitle="Fix the parser tests"
          isServerThread
          activeProject={null}
          rightPanelOpen={false}
          onNewThreadInProject={noop}
        />
      </header>
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          isWorking
          activeTurnInProgress
          activeTurnStartedAt={at(2, 0)}
          listRef={listRef}
          timelineEntries={entries}
          latestRun={{ runId: liveRun, status: "running", startedAt: at(2, 0), completedAt: null }}
          runningRunId={liveRun}
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
          activeThreadEnvironmentId={EnvironmentId.make("fixture-host")}
          markdownCwd={undefined}
          resolvedTheme={params.get("theme") === "dark" ? "dark" : "light"}
          timestampFormat="24-hour"
          workspaceRoot="/scratch/atlas"
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

// Timeline rows and toasts read the router, so the fixture runs inside a one-route router.
const router = createRouter({
  routeTree: createRootRoute({ component: App }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
