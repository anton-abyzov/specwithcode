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
} from "@specweave-studio/contracts";

import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { __setClientSettingsForTests } from "../../src/hooks/useSettings";
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

const fromAgent = { createdBy: "agent", creationSource: "provider" };
const entries: TimelineEntry[] = [
  message("ask", 0, "user", "Verify the qualification flow and report back."),
  message("enospc", 4, "user", ENOSPC_REPORT, fromAgent),
  message("reply-1", 5, "assistant", "One screenshot failed on a full disk; the rest passed."),
  message("handover", 12, "user", HANDOVER_REPORT, fromAgent),
  message("reply-2", 13, "assistant", "Waiting on the cache origin owner before the handover."),
  message("merge", 18, "user", MERGE_RECEIPT, fromAgent),
  message("reply-3", 19, "assistant", "Both pull requests are merged; nothing is deployed."),
  message("done", 20, "user", "complete the job!"),
];
Object.assign(window, {
  agentMessageTexts: { enospc: ENOSPC_REPORT, handover: HANDOVER_REPORT, merge: MERGE_RECEIPT },
});

const listRef = createRef<LegendListRef | null>();
const noop = () => {};

function App() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
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
