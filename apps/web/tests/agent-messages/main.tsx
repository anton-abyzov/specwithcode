/* Isolated thread page: the production timeline with messages other agents sent, no host. */
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { __setClientSettingsForTests } from "../../src/hooks/useSettings";
import { SelectedThreadShell } from "../../src/state/selectedThreadShell";
import { ProjectMessageRoutingContext } from "../../src/studio/projectMessageRouting";
import type { TimelineEntry } from "../../src/session-logic";
import { ENOSPC_REPORT, HANDOVER_REPORT, MERGE_RECEIPT } from "./payloads";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const detail = params.get("detail");
// The thread's level, as the person last chose it; the setting itself is the real one.
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  timelineDetail: detail === "concise" || detail === "verbose" ? detail : "normal",
});

const startedAt = Date.now() - 30 * 60_000;
const at = (minute: number) => new Date(startedAt + minute * 60_000).toISOString();

function message(
  id: string,
  minute: number,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at(minute),
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: role === "assistant" ? RunId.make(`run-${id}`) : null,
      createdAt: at(minute),
      updatedAt: at(minute),
      streaming: false,
      ...extra,
    },
  } as TimelineEntry;
}

// One message from another thread, one from the project's coordinator, one from an
// agent with no thread, so each kind of relayed note shows.
const fromThread = { createdBy: "agent", creationSource: "mcp", senderThreadId: "worker" };
const fromCoordinator = {
  createdBy: "agent",
  creationSource: "mcp",
  senderThreadId: "coordinator",
};
const fromAgent = { createdBy: "agent", creationSource: "provider" };
const REMINDER =
  'Reminder: "Update failures and speed metrics" owns 1.0.89. It will cut it once #778 (the pre-restart re-read fix) merges. Please don\'t dispatch a Mac release yourself.';
const entries: TimelineEntry[] = [
  message("ask", 0, "user", "Verify the qualification flow and report back."),
  message("enospc", 4, "user", ENOSPC_REPORT, fromThread),
  message("reply-1", 5, "assistant", "One screenshot failed on a full disk; the rest passed."),
  message("handover", 12, "user", HANDOVER_REPORT, fromCoordinator),
  message("reply-2", 13, "assistant", "Waiting on the cache origin owner before the handover."),
  message("merge", 18, "user", MERGE_RECEIPT, fromAgent),
  message("reply-3", 19, "assistant", "Both pull requests are merged; nothing is deployed."),
  message("done", 20, "user", "complete the job!"),
  message("reminder", 22, "user", REMINDER, fromCoordinator),
  message("reply-4", 23, "assistant", "Understood. I will leave the Mac release to that thread."),
];
// `?new` reads the thread as last visited before the coordinator's reminder, so the
// "New" divider sits above it.
const thread = {
  environmentId: EnvironmentId.make("fixture-host"),
  id: ThreadId.make("fixture-thread"),
  title: "Qualification flow",
  deletedAt: null,
  lastVisitedAt: params.has("new") ? at(21) : at(30),
} as unknown as EnvironmentThreadShell;
const routing = {
  coordinatorThreadId: ThreadId.make("coordinator"),
  send: async () => {},
  openCoordinator: () => {},
  openThread: () => false,
};
Object.assign(window, {
  agentMessageTexts: { enospc: ENOSPC_REPORT, handover: HANDOVER_REPORT, merge: MERGE_RECEIPT },
});

const listRef = createRef<LegendListRef | null>();
const noop = () => {};

function App() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <SelectedThreadShell value={thread}>
          <ProjectMessageRoutingContext value={routing}>
            <main
              className="flex h-screen flex-col bg-background text-foreground"
              data-detail={detail ?? "normal"}
            >
              <div className="relative min-h-0 flex-1">
                <MessagesTimeline
                  isWorking={false}
                  activeTurnInProgress={false}
                  listRef={listRef}
                  timelineEntries={entries}
                  latestRun={null}
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
                  resolvedTheme={dark ? "dark" : "light"}
                  timestampFormat="24-hour"
                  workspaceRoot="/Users/fixture/Projects/atlas"
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
          </ProjectMessageRoutingContext>
        </SelectedThreadShell>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

// Timeline rows read the router, so the fixture runs inside a one-route router.
const router = createRouter({
  routeTree: createRootRoute({ component: App }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
