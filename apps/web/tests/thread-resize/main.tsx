/* Isolated thread-view fixture: the production timeline with a long finished thread, no host. */
import { createRef, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, MessageId, RunId } from "@specweave-studio/contracts";

import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import { resolveTimelineIsAtEnd } from "../../src/components/chat/MessagesTimeline.logic";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import type { TimelineEntry } from "../../src/session-logic";
import "./fixture.css";

const startedAt = Date.now() - 2 * 60 * 60_000;
const at = (minute: number) => new Date(startedAt + minute * 60_000).toISOString();

const SENTENCE =
  "The reader is somewhere in the middle of a long thread, and widening or narrowing the window reflows every paragraph above and below them.";

function message(id: string, role: "user" | "assistant", minute: number, text: string) {
  const runId = role === "assistant" ? RunId.make(`run-${minute}`) : null;
  return {
    id,
    kind: "message",
    createdAt: at(minute),
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId,
      createdAt: at(minute),
      updatedAt: at(minute),
      streaming: false,
    },
  } satisfies TimelineEntry;
}

const entries: TimelineEntry[] = [];
for (let turn = 0; turn < 40; turn += 1) {
  entries.push(message(`ask-${turn}`, "user", turn * 2, `Question ${turn}: what changed here?`));
  const paragraphs = Array.from(
    { length: 2 + (turn % 4) },
    (_, index) => `Answer ${turn} paragraph ${index + 1}. ${SENTENCE.repeat(1 + (index % 3))}`,
  );
  entries.push(message(`answer-${turn}`, "assistant", turn * 2 + 1, paragraphs.join("\n\n")));
}

const params = new URLSearchParams(location.search);
const listRef = createRef<LegendListRef | null>();
const noop = () => {};
const CANCEL_SENTINEL = Object.freeze({}) as never;

declare global {
  interface Window {
    __follow?: { liveFollowEnabled: boolean; atEndReports: boolean[] };
  }
}

/** The follow state ChatView keeps: only the reader's upward input pauses it, reaching the end resumes it. */
function useFollowLikeChatView() {
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const followRef = useRef(true);
  const record = useRef({ liveFollowEnabled: true, atEndReports: [] as boolean[] });
  window.__follow = record.current;
  const setFollow = useCallback((next: boolean) => {
    followRef.current = next;
    record.current.liveFollowEnabled = next;
    setLiveFollowEnabled(next);
  }, []);
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean, reachedByScrolling: boolean) => {
      record.current.atEndReports.push(isAtEnd);
      if (!isAtEnd && followRef.current) return;
      // As ChatView: a clamp to the end is not the reader arriving there.
      // `?gate=0` drops the check to show the snap it prevents.
      if (isAtEnd && !reachedByScrolling && params.get("gate") !== "0") return;
      if (isAtEnd !== followRef.current) setFollow(isAtEnd);
    },
    [setFollow],
  );
  useEffect(() => {
    let node: HTMLElement | null = null;
    const onWheel = (event: WheelEvent) => {
      // As ChatView: moving on toward the end while clamped there resumes.
      if (event.deltaY > 0 && !followRef.current) {
        const state = listRef.current?.getState();
        if (state && resolveTimelineIsAtEnd(state)) {
          setFollow(true);
          void listRef.current?.scrollToEnd({ animated: false });
        }
        return;
      }
      if (event.deltaY >= 0 || !followRef.current) return;
      setFollow(false);
      // As ChatView: a new imperative scroll to an item not in the data cancels
      // queued scrolls and the list's kept "opened at the end" target.
      void listRef.current?.scrollToItem({ item: CANCEL_SENTINEL, animated: false });
    };
    const frame = requestAnimationFrame(function attach() {
      node = listRef.current?.getScrollableNode() ?? null;
      if (!node) return void requestAnimationFrame(attach);
      node.addEventListener("wheel", onWheel, { passive: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      node?.removeEventListener("wheel", onWheel);
    };
  }, [setFollow]);
  return { liveFollowEnabled, onIsAtEndChange, onManualNavigation: () => setFollow(false) };
}

function Fixture() {
  const follow = useFollowLikeChatView();
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={entries}
          latestRun={null}
          runningRunId={null}
          turnDiffSummaries={[]}
          providerStatuses={[]}
          runs={[]}
          routeThreadKey="fixture-host:resize-thread"
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
          resolvedTheme="light"
          timestampFormat="24-hour"
          workspaceRoot="/scratch/atlas"
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={follow.liveFollowEnabled}
          onIsAtEndChange={follow.onIsAtEndChange}
          onManualNavigation={follow.onManualNavigation}
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
