import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { MessagesSquareIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useLayoutEffect, useState } from "react";

import { useThreadShell } from "~/state/entities";
import { useViewerOverlayStore } from "~/viewerOverlayStore";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { Dialog, DialogOverlayPopup } from "./ui/dialog";

const ChatView = lazy(() => import("./ChatView"));

const isCoordinator = (threadRef: ScopedThreadRef) =>
  threadRef.threadId.startsWith("project-coordinator:");

export interface OverlayThreadOptions {
  /**
   * The thread already has a composer on screen behind the overlay (a panel,
   * the page, the coordinator), so this copy shows its transcript only: two
   * composers on one thread fight over its draft.
   */
  readonly transcriptOnly: boolean;
}

/** The thread a viewer came from, as the thread panel shows it. */
function OverlayThread({
  threadRef,
  transcriptOnly,
}: { threadRef: ScopedThreadRef } & OverlayThreadOptions) {
  return (
    <RenderErrorBoundary fallback={null} resetKeys={[threadRef.environmentId, threadRef.threadId]}>
      <Suspense fallback={null}>
        <div className="project-native-thread viewer-overlay-thread-chat">
          <ChatView
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            layoutMode="embedded"
            transcriptOnly={transcriptOnly}
            suspendShortcuts
            embeddedHeaderToolsTarget={null}
            reserveTitleBarControlInset={false}
          />
        </div>
      </Suspense>
    </RenderErrorBoundary>
  );
}

/** The source thread's view outside the overlay, if one is mounted. */
function threadOnScreen(threadRef: ScopedThreadRef): boolean {
  const id = `${threadRef.environmentId}:${threadRef.threadId}`;
  return [...document.querySelectorAll<HTMLElement>("[data-chat-thread]")].some(
    (element) => element.dataset.chatThread === id && !element.closest("[data-viewer-overlay]"),
  );
}

/**
 * Whether the source thread already has a composer behind the overlay, read
 * once as the overlay opens; null until then, so the thread never mounts
 * twice in passing.
 */
function useThreadBehind(threadRef: ScopedThreadRef | null): boolean | null {
  const [behind, setBehind] = useState<boolean | null>(null);
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  useLayoutEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    const ref = { environmentId, threadId };
    setBehind(isCoordinator(ref) || threadOnScreen(ref));
    return () => setBehind(null);
  }, [environmentId, threadId]);
  return threadRef ? behind : null;
}

function ThreadPane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly children: ReactNode;
}) {
  const shell = useThreadShell(props.threadRef);
  const title = isCoordinator(props.threadRef) ? "Coordinator" : shell?.title || "Thread";
  if (props.collapsed) {
    return (
      <aside
        className="viewer-overlay-thread-rail"
        aria-label="Thread"
        data-thread-collapsed="true"
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Show thread ${title}`}
          title={`Show ${title}`}
          onClick={() => props.onCollapsedChange(false)}
        >
          <PanelRightOpenIcon aria-hidden />
        </Button>
      </aside>
    );
  }
  return (
    <aside className="viewer-overlay-thread" aria-label="Thread">
      <header className="viewer-overlay-thread-head">
        <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Hide thread"
          title="Hide thread"
          onClick={() => props.onCollapsedChange(true)}
        >
          <PanelRightCloseIcon aria-hidden />
        </Button>
      </header>
      {props.children}
    </aside>
  );
}

/**
 * The app's one viewer overlay. Reports, artifacts, documents and files open
 * here, wherever they were clicked: a card over nearly the whole window, with
 * the viewer on the left and the thread it came from on the right, which can
 * be folded away. Escape, the backdrop and the viewer's close button close it.
 */
export function ViewerOverlayHost(props: {
  /** Renders a thread beside the viewer; without it the viewer takes the card. */
  readonly renderThread?: (threadRef: ScopedThreadRef, options: OverlayThreadOptions) => ReactNode;
}) {
  const active = useViewerOverlayStore((state) => state.active);
  const close = useViewerOverlayStore((state) => state.close);
  const setSlot = useViewerOverlayStore((state) => state.setSlot);
  const collapsed = useViewerOverlayStore((state) => state.threadCollapsed);
  const setCollapsed = useViewerOverlayStore((state) => state.setThreadCollapsed);
  const open = active !== null;
  const threadRef = active?.threadRef ?? null;
  const behind = useThreadBehind(threadRef);
  const renderThread =
    props.renderThread ??
    ((ref: ScopedThreadRef, options: OverlayThreadOptions) => (
      <OverlayThread threadRef={ref} {...options} />
    ));
  return (
    <Dialog
      open={open}
      modal={false}
      // Menus inside a viewer portal outside the card; a press there is not
      // a press outside it. The backdrop, Escape and the close button close.
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next && active) close(active.key);
      }}
    >
      <DialogOverlayPopup
        onBackdropClick={() => {
          if (active) close(active.key);
        }}
        aria-label={active?.title ?? "Viewer"}
        data-viewer-overlay="true"
      >
        <div ref={setSlot} className="viewer-overlay-content" data-viewer-overlay-content="true" />
        {threadRef && behind !== null ? (
          <ThreadPane threadRef={threadRef} collapsed={collapsed} onCollapsedChange={setCollapsed}>
            {renderThread(threadRef, { transcriptOnly: behind })}
          </ThreadPane>
        ) : null}
      </DialogOverlayPopup>
    </Dialog>
  );
}
