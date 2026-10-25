/* Isolated activity and diff fixture: the production timeline and DiffPanel, synthetic data only. */
import { createRef, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { RunId, ThreadId } from "@specweave-studio/contracts";

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
      }),
    [thread],
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
      className="flex h-screen min-w-0 bg-background text-foreground"
      data-detail={timelineDetail}
      data-thread={thread.id}
    >
      <section className="flex min-w-0 flex-1 flex-col">
        {/* The browser build's thread header, as ChatView lays it out, around the real ChatHeader. */}
        <header
          data-chat-header
          className="relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-background pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)"
        >
          <ChatHeader
            activeThreadEnvironmentId={HOST}
            activeThreadId={thread.id}
            activeThreadTitle={thread.title}
            isServerThread
            activeProject={null}
            rightPanelOpen={diffOpen}
            onNewThreadInProject={noop}
          />
        </header>
        <div className="relative min-h-0 flex-1">
          <MessagesTimeline
            key={threadKey}
            isWorking={running !== null}
            activeTurnInProgress={running !== null}
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
            liveFollowEnabled={false}
            onIsAtEndChange={noop}
            onManualNavigation={noop}
          />
        </div>
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
