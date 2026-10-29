/* Isolated activity and diff fixture: the production timeline and DiffPanel, synthetic data only. */
import { Activity, createRef, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { ProjectId, RunId, ThreadId } from "@specweave-studio/contracts";

import { TimelineDetailMenu } from "../../src/components/chat/TimelineDetailMenu";
import { ChatHeader } from "../../src/components/chat/ChatHeader";
import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import DiffPanel from "../../src/components/DiffPanel";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../../src/components/ui/toast";
import { useDiffPanelStore, type TurnDiffLinkOptions } from "../../src/diffPanelStore";
import { useTurnDiffSummaries } from "../../src/hooks/useTurnDiffSummaries";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../src/session-logic";
import { setTimelineDetail, useTimelineDetail } from "../../src/timelineDetail";
import {
  HOST,
  ids,
  providerStatuses,
  REPO,
  sources,
  subagentsLoaded,
  threadProjection,
  threads,
} from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
const detail = params.get("detail");
if (detail === "concise" || detail === "normal" || detail === "verbose") setTimelineDetail(detail);

// Recorders the verifier reads: copies, toasts, files the diff opened, Open diff calls.
const fixture = window.__fixture;
const push = (key: string, value: unknown) => (fixture[key] ??= []).push(value);
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => push("copies", text),
    write: async () => {
      throw new Error("Rich clipboard flavors are not recorded by the fixture.");
    },
  },
});
const addToast = toastManager.add.bind(toastManager);
toastManager.add = ((options: Parameters<typeof addToast>[0]) => {
  push("toasts", { title: options.title, description: options.description ?? null });
  return addToast(options);
}) as typeof toastManager.add;
const openFile = useRightPanelStore.getState().openFile;
useRightPanelStore.setState({
  openFile: (ref, path, line) => {
    push("fileOpens", { threadId: ref.threadId, path, line: line ?? null });
    openFile(ref, path, line);
  },
});
fixture.sources = sources;
fixture.ids = ids;
fixture.setDetail = (next: "concise" | "normal" | "verbose") => setTimelineDetail(next);

// Delaying a host frame must not leave measured web rows at old positions.
// This control exists only in the synthetic fixture and always restores native APIs.
const nativeFrame = window.requestAnimationFrame.bind(window);
const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
const heldFrames = new Map<number, FrameRequestCallback>();
let nextHeldFrame = -1;
fixture.nativeFrame = nativeFrame;
fixture.holdLayoutFrames = (hold: boolean) => {
  if (hold) {
    window.requestAnimationFrame = (callback) => {
      const id = nextHeldFrame--;
      heldFrames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (id < 0) heldFrames.delete(id);
      else nativeCancelFrame(id);
    };
  } else {
    window.requestAnimationFrame = nativeFrame;
    window.cancelAnimationFrame = nativeCancelFrame;
    for (const callback of heldFrames.values()) nativeFrame(callback);
    heldFrames.clear();
  }
};
window.addEventListener("error", (event) => push("errors", event.message));

fixture.probeLayout = async () => {
  const frame = () => new Promise<void>((resolve) => nativeFrame(() => resolve()));
  const wait = async (count = 3) => {
    for (let index = 0; index < count; index++) await frame();
  };
  const samples: Array<Record<string, unknown>> = [];
  const check = (label: string) => {
    const state = fixture.listState();
    samples.push({ label, ...state });
  };
  try {
    fixture.setPaneWidth("100%");
    fixture.setSteerText(
      "Long steer with multiple words to wrap after the pane changes width. ".repeat(4),
    );
    fixture.setAssistantText("The next response should stay below the steer bubble.");
    await wait(5);
    check("initial");
    fixture.holdLayoutFrames(true);
    fixture.setPaneWidth("390px");
    await wait(2);
    check("withheld-frame");
    fixture.holdLayoutFrames(false);
    await wait();
    for (let step = 0; step < 24; step++) {
      fixture.setPaneWidth(["100%", "390px", "900px", "600px"][step % 4]);
      fixture.setSteerText(
        "A screenshot-shaped steer changes wrapping without changing its identity. ".repeat(
          2 + (step % 5),
        ),
      );
      fixture.setAssistantText("Streaming analysis text. ".repeat(2 + (step % 7)));
      for (let paint = 0; paint < 3; paint++) {
        await frame();
        check(`resize-stream-${step}-${paint}`);
      }
    }
    for (const zoom of [0.8, 1.5, 1]) {
      document.querySelector<HTMLElement>("main")!.style.zoom = String(zoom);
      await wait(6);
      check(`css-zoom-${zoom}`);
    }
    for (let step = 0; step < 8; step++) {
      fixture.setHidden(true);
      await wait(2);
      fixture.setSteerText("Steer received while the conversation is hidden. ".repeat(5 + step));
      fixture.setAssistantText("Response received while hidden. ".repeat(4 + step));
      fixture.setPaneWidth(step % 2 ? "100%" : "390px");
      await wait();
      fixture.setHidden(false);
      await wait(4);
      check(`reveal-${step}`);
    }
    fixture.setPaneWidth("100%");
    fixture.setSteerText("A very long user steer with an expandable body. ".repeat(40));
    await wait(4);
    const disclosure = document.querySelector<HTMLButtonElement>(
      "[data-user-message-footer] button",
    );
    if (!disclosure) throw new Error("Expected the production user-message disclosure");
    disclosure.click();
    await wait(3);
    check("expanded-user-steer");
    disclosure.click();
    await wait(3);
    check("collapsed-user-steer");
    return {
      samples,
      failures: samples.filter((sample) => (sample.overlaps as unknown[]).length > 0),
      errors: fixture.errors ?? [],
    };
  } finally {
    fixture.holdLayoutFrames(false);
    document.querySelector<HTMLElement>("main")!.style.zoom = "1";
    fixture.setHidden(false);
  }
};

const listRef = createRef<LegendListRef | null>();
const noop = () => {};
const wide = () => window.innerWidth >= 1024;

function threadRefOf(threadId: ThreadId) {
  return scopeThreadRef(HOST, threadId);
}

function Fixture() {
  const [threadId, setThreadId] = useState<ThreadId>(
    (threads[params.get("thread") ?? ""]?.id ?? ids.activity) as ThreadId,
  );
  const [following, setFollowing] = useState(true);
  fixture.setFollowing = setFollowing;
  fixture.isFollowing = () => following;
  const [steerText, setSteerText] = useState<string | null>(null);
  const [assistantText, setAssistantText] = useState<string | null>(null);
  const [paneWidth, setPaneWidth] = useState<string>("100%");
  const [hidden, setHidden] = useState(false);
  fixture.setSteerText = setSteerText;
  fixture.setAssistantText = setAssistantText;
  fixture.setPaneWidth = setPaneWidth;
  fixture.setHidden = setHidden;
  fixture.listState = () => {
    const state = listRef.current?.getState();
    const viewport = listRef.current?.getScrollableNode() as HTMLElement | undefined;
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const rows = [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")]
      .map((e) => {
        const id = e.dataset.timelineRowId!;
        const index = state?.indexByKey(id);
        return {
          id,
          index,
          kind: e.dataset.timelineRowKind,
          ...rect(e),
          known: index === undefined ? null : state?.sizeAtIndex(index),
        };
      })
      .filter((r) => r.height > 0)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      rows,
      following,
      scrollTop: viewport?.scrollTop,
      scrollHeight: viewport?.scrollHeight,
      clientHeight: viewport?.clientHeight,
      overlaps: rows
        .slice(1)
        .flatMap((r, i) =>
          r.top < rows[i]!.bottom - 1
            ? [{ before: rows[i]!.id, after: r.id, amount: rows[i]!.bottom - r.top }]
            : [],
        ),
    };
  };
  const [diffOpen, setDiffOpen] = useState(false);
  const [isWide, setIsWide] = useState(wide);
  useEffect(() => {
    const onResize = () => setIsWide(wide());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const thread = threads[threadId]!;
  const threadRef = useMemo(() => threadRefOf(thread.id), [thread.id]);
  const threadKey = scopedThreadKey(threadRef);
  const timelineDetail = useTimelineDetail(threadKey);
  const entries = useMemo(
    () =>
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: thread.rows,
        optimisticMessages: [],
      }).map((entry) =>
        entry.kind === "message" && entry.message.id === "overlap-steer" && steerText !== null
          ? { ...entry, message: { ...entry.message, text: steerText } }
          : entry.kind === "message" &&
              entry.message.role === "assistant" &&
              entry.message.runId === thread.runs.at(-1)?.id &&
              assistantText !== null
            ? { ...entry, message: { ...entry.message, text: assistantText, streaming: true } }
            : entry,
      ),
    [thread, steerText, assistantText],
  );
  const projection = useMemo(() => threadProjection(thread), [thread]);
  const { turnDiffSummaries } = useTurnDiffSummaries(projection);
  const lastRun = thread.runs.at(-1) ?? null;
  const running = lastRun?.status === "running" ? lastRun : null;
  const subagentParent = useMemo(() => {
    if (thread.id !== ids.subagent) return null;
    const parent = threads[ids.activity]!;
    return {
      threadId: parent.id,
      subagents: subagentsLoaded ? parent.subagents : null,
      runs: parent.runs.map((run) => ({ id: run.id, status: run.status })),
    };
  }, [thread.id]);
  const loadedSubagentEditItems = useMemo(
    () =>
      new Map(
        thread.subagents.flatMap((subagent) => {
          const child = subagent.childThreadId ? threads[subagent.childThreadId] : undefined;
          if (!subagentsLoaded || !child) return [];
          const edits = child.rows
            .map((row) => row.item)
            .filter((item) => item.type === "file_change");
          return [[child.id, edits] as const];
        }),
      ),
    [thread],
  );
  const timelineRuns = useMemo(
    () =>
      thread.runs.map((run) => ({
        id: run.id,
        ordinal: run.ordinal,
        providerInstanceId: run.providerInstanceId,
        modelSelection: run.modelSelection,
        status: run.status,
      })),
    [thread],
  );

  // ChatView's routing: a link to another thread's turn opens that thread with the diff on it.
  const onOpenTurnDiff = useCallback(
    (runId: RunId, filePath?: string, options?: TurnDiffLinkOptions) => {
      push("diffOpens", {
        threadId: thread.id,
        runId,
        filePath: filePath ?? null,
        sourceThreadId: options?.sourceThreadId ?? null,
        attributedTo: options?.attributedTo ?? null,
      });
      const sourceThreadId = options?.sourceThreadId;
      if (sourceThreadId && sourceThreadId !== thread.id && threads[sourceThreadId]) {
        const sourceRef = threadRefOf(sourceThreadId);
        useDiffPanelStore.getState().selectTurn(sourceRef, runId, filePath, options);
        useDiffPanelStore.getState().markLinkedOpen(sourceRef);
        setThreadId(sourceThreadId);
        setDiffOpen(true);
        return;
      }
      useDiffPanelStore.getState().selectTurn(threadRef, runId, filePath, options ?? {});
      setDiffOpen(true);
    },
    [thread.id, threadRef],
  );
  const onOpenThread = useCallback((next: ThreadId) => {
    push("threadOpens", next);
    if (threads[next]) setThreadId(next);
  }, []);
  fixture.threadId = thread.id;
  fixture.diffOpen = diffOpen;
  fixture.closeDiff = () => setDiffOpen(false);

  const panel = diffOpen ? (
    <DiffPanel
      key={threadKey}
      mode={isWide ? "inline" : "sheet"}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      workspaceMutationId={null}
    />
  ) : null;

  return (
    <main
      style={{ width: paneWidth, maxWidth: "100%" }}
      className="flex h-screen min-w-0 bg-background text-foreground"
      data-detail={timelineDetail}
      data-thread={thread.id}
      data-following={following}
      onWheelCapture={(event) => {
        if (
          thread.id === "thread-overlap" &&
          event.deltaY < 0 &&
          !event.ctrlKey &&
          event.target instanceof Element &&
          event.target.closest(".messages-timeline-scroll")
        )
          setFollowing(false);
      }}
    >
      <section className="flex min-w-0 flex-1 flex-col">
        {/* The browser build's thread header, as ChatView lays it out, around the real ChatHeader. */}
        <header
          data-chat-header
          className="relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-background pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)"
        >
          {thread.id === "thread-concise-coordinator" ? (
            <>
              <h2 className="min-w-0 flex-1 truncate text-sm">Project coordinator</h2>
              <TimelineDetailMenu
                appearance="project"
                threadKey={threadKey}
                project={{ environmentId: HOST, projectId: "fixture-project" as ProjectId }}
              />
            </>
          ) : (
            <ChatHeader
              activeThreadEnvironmentId={HOST}
              activeThreadId={thread.id}
              activeThreadTitle={thread.title}
              isServerThread
              activeProject={null}
              rightPanelOpen={diffOpen}
              onNewThreadInProject={noop}
            />
          )}
        </header>
        <div className="relative min-h-0 flex-1">
          <Activity mode={hidden ? "hidden" : "visible"}>
            <MessagesTimeline
              key={threadKey}
              isWorking={running !== null}
              activeTurnInProgress={running !== null}
              liveFollowEnabled={thread.id === "thread-overlap" ? following : false}
              activeTurnStartedAt={running?.startedAt ?? null}
              runlessWorkActive={false}
              listRef={listRef}
              timelineEntries={entries}
              latestRun={
                lastRun
                  ? {
                      runId: lastRun.id,
                      status: lastRun.status,
                      startedAt: lastRun.startedAt,
                      completedAt: lastRun.completedAt,
                    }
                  : null
              }
              runningRunId={running?.id ?? null}
              turnDiffSummaries={turnDiffSummaries}
              providerStatuses={providerStatuses}
              runs={timelineRuns}
              routeThreadKey={threadKey}
              onOpenTurnDiff={onOpenTurnDiff}
              subagentParent={subagentParent}
              loadedSubagentEditItems={loadedSubagentEditItems}
              onOpenThread={onOpenThread}
              onForkFromRun={async () => {}}
              onRollbackCheckpoint={noop}
              supportsConversationRollback={false}
              onRevertToTurnCount={noop}
              isRevertingCheckpoint={false}
              onImageExpand={noop}
              activeThreadEnvironmentId={HOST}
              markdownCwd={thread.worktreePath}
              resolvedTheme={theme}
              timestampFormat="24-hour"
              workspaceRoot={REPO}
              anchorMessageId={null}
              onAnchorReady={noop}
              onAnchorSizeChanged={noop}
              contentInsetEndAdjustment={0}
              onIsAtEndChange={noop}
              onManualNavigation={() => setFollowing(false)}
            />
          </Activity>
        </div>
        {thread.id === "thread-overlap" ? (
          <textarea
            aria-label="Fixture composer"
            className="m-2 min-h-16 border p-2"
            placeholder="Verify input remains usable"
          />
        ) : null}
      </section>
      {panel && isWide ? (
        <aside className="flex h-full shrink-0" data-diff-panel>
          {panel}
        </aside>
      ) : null}
      {panel && !isWide ? (
        // Narrow windows show the diff as a sheet over the thread, as the right panel does.
        <div className="fixed inset-0 z-40 flex flex-col bg-background" data-diff-panel>
          <div className="flex h-9 shrink-0 items-center justify-end border-b border-border px-2">
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
              onClick={() => setDiffOpen(false)}
            >
              Close diff
            </button>
          </div>
          <div className="min-h-0 flex-1">{panel}</div>
        </div>
      ) : null}
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

// Timeline rows, toasts and DiffPanel read the router, so the fixture runs inside a one-route router.
const router = createRouter({
  routeTree: createRootRoute({ component: App }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
