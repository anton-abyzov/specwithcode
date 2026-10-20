/* Isolated fixture: the production timeline's live rows in each state, no host. */
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  MessageId,
  RunId,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";

import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import type { TimelineEntry } from "../../src/session-logic";
import "./fixture.css";

// ?state=running | thinking | quiet | offline | settled ; ?theme=dark
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "running";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const run = RunId.make("run-live");
const now = Date.now();
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const turnStart = ago(13 * 60 - 10);

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

function note(id: string, time: string, text: string): TimelineEntry {
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

function command(
  id: string,
  time: string,
  input: string,
  status: "completed" | "inProgress" = "completed",
): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time,
    entry: {
      id,
      createdAt: time,
      runId: run,
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      command: input,
      detail: status === "completed" ? "ok" : "",
      toolLifecycleStatus: status,
    },
  };
}

function read(id: string, time: string, path: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time,
    entry: {
      id,
      createdAt: time,
      runId: run,
      label: "Read file",
      tone: "tool",
      itemType: "dynamic_tool",
      toolTitle: "Read",
      detail: path,
      toolLifecycleStatus: "completed",
    },
  };
}

const settled = state === "settled";
const tail: TimelineEntry[] = [
  read("read-1", ago(120), "/scratch/atlas/src/app/submit/[id]/layout.tsx"),
  command("cmd-ls", ago(110), "ls ~/Projects/atlas/src/app"),
  command("cmd-grep", ago(100), "grep -rn canonical src/app | head"),
  command("cmd-check", ago(90), "cd /tmp/vs-canon && bash check.sh"),
  ...(state === "running" || state === "offline"
    ? [
        command(
          "cmd-loop",
          ago(42),
          'for i in 1 2 3 4 5; do curl -s "https://example.com/api/v1/submissions?limit=3"; done',
          "inProgress",
        ),
      ]
    : []),
];
const entries: TimelineEntry[] = [
  user("ask", turnStart, "Fix the canonical URLs and deploy it."),
  note("note-1", ago(130), "The pre-deploy baseline fails as expected. Fixing the lookup."),
  ...tail,
  ...(settled ? [note("answer", ago(30), "Canonical tags are fixed and verified live.")] : []),
];

// The newest persisted change among the run's items: the real liveness signal.
const lastEventAgo = state === "quiet" ? 3 * 60 + 5 : state === "thinking" ? 6 : 4;
const recoveryItems = [
  { runId: run, type: "assistant_message", status: "completed", updatedAt: ago(lastEventAgo) },
].map((item) => ({
  ...item,
  updatedAt: DateTime.makeUnsafe(item.updatedAt),
})) as unknown as OrchestrationV2TurnItem[];

const listRef = createRef<LegendListRef | null>();
const noop = () => {};

function Fixture() {
  return (
    <main
      className="flex h-screen flex-col bg-background text-foreground"
      data-fixture-state={state}
    >
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          isWorking={!settled}
          activeTurnInProgress={!settled}
          activeTurnStartedAt={settled ? null : turnStart}
          activeHost={{ label: "MacBook M4MAX", connected: state !== "offline" }}
          listRef={listRef}
          timelineEntries={entries}
          latestRun={{
            runId: run,
            status: settled ? "completed" : "running",
            startedAt: turnStart,
            completedAt: settled ? ago(30) : null,
          }}
          runningRunId={settled ? null : run}
          recoveryItems={recoveryItems}
          turnDiffSummaries={[]}
          providerStatuses={[]}
          runs={[]}
          routeThreadKey={`fixture-host:fixture-${state}`}
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

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <Fixture />
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
