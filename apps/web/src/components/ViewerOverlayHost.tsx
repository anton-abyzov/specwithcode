import type { ScopedThreadRef } from "@specweave-studio/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  XIcon,
} from "lucide-react";
import {
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useThreadShell } from "../state/entities";
import {
  type ViewerCrumb,
  type ViewerOverlayEntry,
  useViewerOverlayStore,
} from "~/viewerOverlayStore";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
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

/**
 * Something inside the overlay that answers Escape itself first: an open
 * menu, a find field, a combobox showing its list, another dialog.
 */
const OWNS_ESCAPE =
  '[role="menu"], [role="listbox"], [role="dialog"]:not([data-viewer-overlay]), [role="alertdialog"], [data-viewer-escape="own"]';

function escapeIsTaken(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(OWNS_ESCAPE)) return true;
  return target.getAttribute("aria-expanded") === "true";
}

/**
 * Escape closes the overlay wherever focus is inside it, the thread beside
 * the viewer and code blocks included, which would otherwise keep the key.
 * It listens in the capture phase so nothing inside can swallow it first.
 */
function useEscapeCloses(active: ViewerOverlayEntry | null, close: (key: string) => void) {
  const key = active?.key ?? null;
  useEffect(() => {
    if (key === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      const target = event.target;
      const overlay = document.querySelector("[data-viewer-overlay]");
      // Focus elsewhere (the page behind, a menu portaled out) keeps the key,
      // unless it is the page's body: then the overlay is what is in front.
      if (
        target instanceof Element &&
        target !== document.body &&
        !(overlay?.contains(target) ?? false)
      ) {
        return;
      }
      if (escapeIsTaken(target)) return;
      event.preventDefault();
      event.stopPropagation();
      close(key);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close, key]);
}

/** A level's label: its kind when its name only repeats where it came from. */
function crumbLabel(crumb: ViewerCrumb, source: string | null): string {
  return crumb.title === source ? crumb.kind : crumb.title;
}

/**
 * The overlay's one header: Back when the viewer has a level to return to,
 * where you are (thread › … › what is open), the viewer's own actions, the
 * thread toggle and the one Close.
 */
function OverlayHeader(props: {
  readonly entry: ViewerOverlayEntry;
  readonly showThreadToggle: boolean;
  readonly threadCollapsed: boolean;
  readonly onThreadCollapsedChange: (collapsed: boolean) => void;
  readonly setActionsSlot: (element: HTMLElement | null) => void;
  readonly onClose: () => void;
}) {
  const { entry } = props;
  const shell = useThreadShell(entry.threadRef);
  const source = entry.threadRef
    ? isCoordinator(entry.threadRef)
      ? "Coordinator"
      : shell?.title || "Thread"
    : entry.origin;
  const current = entry.title === source ? null : entry.title;
  return (
    <header className="viewer-overlay-head" data-viewer-overlay-head="true">
      {entry.onBack ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={entry.onBack}
          aria-label={`Back to ${entry.trail.at(-1) ? crumbLabel(entry.trail.at(-1)!, source) : "previous"}`}
        >
          <ArrowLeftIcon aria-hidden />
          Back
        </Button>
      ) : null}
      <nav aria-label="Breadcrumb" className="viewer-overlay-crumbs">
        <ol>
          {source ? (
            <li className="viewer-overlay-crumb" data-crumb="source">
              <span className="truncate">{source}</span>
            </li>
          ) : null}
          {entry.trail.map((crumb, index) => (
            <Fragment key={`${index}:${crumb.kind}:${crumb.title}`}>
              <li className="viewer-overlay-crumb" data-crumb="trail">
                <ChevronRightIcon aria-hidden className="viewer-overlay-crumb-sep" />
                <span className="truncate">{crumbLabel(crumb, source)}</span>
              </li>
            </Fragment>
          ))}
          <li className="viewer-overlay-crumb" data-crumb="current" aria-current="page">
            {source || entry.trail.length > 0 ? (
              <ChevronRightIcon aria-hidden className="viewer-overlay-crumb-sep" />
            ) : null}
            {entry.badge ? (
              <span className="report-reader-badge" aria-hidden>
                {entry.badge}
              </span>
            ) : null}
            <span className={current ? "viewer-overlay-kind" : "viewer-overlay-current"}>
              {entry.kind}
            </span>
            {current ? (
              <h2 className="viewer-overlay-current truncate">{current}</h2>
            ) : (
              <h2 className="sr-only">{entry.title}</h2>
            )}
          </li>
        </ol>
      </nav>
      {entry.detail ? <span className="viewer-overlay-detail">{entry.detail}</span> : null}
      <div ref={props.setActionsSlot} className="viewer-overlay-actions" />
      {props.showThreadToggle ? (
        <span className="viewer-overlay-thread-toggle">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={props.threadCollapsed ? "Show thread" : "Hide thread"}
                  aria-pressed={!props.threadCollapsed}
                  onClick={() => props.onThreadCollapsedChange(!props.threadCollapsed)}
                />
              }
            >
              {props.threadCollapsed ? (
                <PanelRightOpenIcon aria-hidden />
              ) : (
                <PanelRightCloseIcon aria-hidden />
              )}
            </TooltipTrigger>
            <TooltipPopup>{props.threadCollapsed ? "Show thread" : "Hide thread"}</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
      <span className="viewer-overlay-head-rule" aria-hidden />
      <span className="viewer-overlay-close">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Close"
                onClick={props.onClose}
                data-viewer-close="true"
              />
            }
          >
            <XIcon aria-hidden />
            <kbd className="viewer-overlay-esc" aria-hidden>
              Esc
            </kbd>
          </TooltipTrigger>
          <TooltipPopup>Close (Esc)</TooltipPopup>
        </Tooltip>
      </span>
    </header>
  );
}

/**
 * The app's one viewer overlay. Reports, artifacts, documents and files open
 * here, wherever they were clicked: a card over nearly the whole window with
 * one header that says where you are, the viewer on the left and the thread
 * it came from on the right, which can be folded away. Escape (wherever focus
 * is inside), the Close button and the backdrop close it.
 */
export function ViewerOverlayHost(props: {
  /** Renders a thread beside the viewer; without it the viewer takes the card. */
  readonly renderThread?: (threadRef: ScopedThreadRef, options: OverlayThreadOptions) => ReactNode;
}) {
  const active = useViewerOverlayStore((state) => state.active);
  const close = useViewerOverlayStore((state) => state.close);
  const setSlot = useViewerOverlayStore((state) => state.setSlot);
  const setActionsSlot = useViewerOverlayStore((state) => state.setActionsSlot);
  const collapsed = useViewerOverlayStore((state) => state.threadCollapsed);
  const setCollapsed = useViewerOverlayStore((state) => state.setThreadCollapsed);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const open = active !== null;
  const threadRef = active?.threadRef ?? null;
  const behind = useThreadBehind(threadRef);
  useEscapeCloses(active, close);
  const renderThread =
    props.renderThread ??
    ((ref: ScopedThreadRef, options: OverlayThreadOptions) => (
      <OverlayThread threadRef={ref} {...options} />
    ));
  const hasThread = threadRef !== null && behind !== null;
  return (
    <Dialog
      open={open}
      modal={false}
      // Menus inside a viewer portal outside the card; a press there is not
      // a press outside it. The backdrop, Escape and Close close it.
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
        // Focus starts on the page, not on its first button, so nothing in the
        // header looks pressed and the arrow keys scroll what is open.
        initialFocus={contentRef}
      >
        {active ? (
          <OverlayHeader
            entry={active}
            showThreadToggle={hasThread}
            threadCollapsed={collapsed}
            onThreadCollapsedChange={setCollapsed}
            setActionsSlot={setActionsSlot}
            onClose={() => close(active.key)}
          />
        ) : null}
        <div className="viewer-overlay-body">
          <div
            ref={(element) => {
              contentRef.current = element;
              setSlot(element);
            }}
            tabIndex={-1}
            className="viewer-overlay-content"
            data-viewer-overlay-content="true"
          />
          {hasThread && !collapsed ? (
            <aside className="viewer-overlay-thread" aria-label="Thread">
              {renderThread(threadRef, { transcriptOnly: behind })}
            </aside>
          ) : null}
        </div>
      </DialogOverlayPopup>
    </Dialog>
  );
}
