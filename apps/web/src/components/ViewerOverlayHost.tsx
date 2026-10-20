import type { ScopedThreadRef } from "@specweave-studio/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  XIcon,
} from "lucide-react";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import {
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useProject, useThreadShell } from "../state/entities";
import {
  InViewerOverlay,
  threadOwnerKey,
  type ViewerCrumb,
  type ViewerLinkTarget,
  type ViewerOverlayEntry,
  useViewerOverlayStore,
} from "~/viewerOverlayStore";
import { useLocation } from "@tanstack/react-router";

import { ArtifactViewer, ThreadArtifactStrip, useThreadViewables } from "./chat/ThreadArtifacts";
import { ViewerLinkedPane, viewerLinkHeader } from "./chat/ViewerLinkedPane";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Dialog, DialogOverlayPopup } from "./ui/dialog";

const ChatView = lazy(() => import("./ChatView"));

const isCoordinator = (threadRef: ScopedThreadRef) =>
  threadRef.threadId.startsWith("project-coordinator:");

export interface OverlayThreadOptions {
  /**
   * The thread's page owns its composer (the coordinator's), so this copy
   * shows the transcript and the page's composer moves in below it.
   */
  readonly transcriptOnly: boolean;
}

/**
 * The thread a viewer came from, live: its transcript, approvals, questions
 * and composer, so it can be steered while the viewer stays open.
 */
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

/** The same ref object while the thread is the same, so hooks keyed on it hold still. */
function useStableThreadRef(threadRef: ScopedThreadRef | null): ScopedThreadRef | null {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  return useMemo(
    () =>
      environmentId !== undefined && threadId !== undefined ? { environmentId, threadId } : null,
    [environmentId, threadId],
  );
}

/** Where the thread's files are: its worktree, else its project's folder. */
function useThreadCwd(threadRef: ScopedThreadRef | null): string | undefined {
  const shell = useThreadShell(threadRef);
  const projectRef = useMemo(
    () => (shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null),
    [shell],
  );
  const project = useProject(projectRef);
  return shell?.worktreePath ?? project?.workspaceRoot ?? undefined;
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
  // A composer or combobox showing suggestions dismisses them first.
  if (target.getAttribute("aria-activedescendant")) return true;
  return target.getAttribute("aria-expanded") === "true";
}

/**
 * Escape steps back from a link target to the viewer, else closes the
 * overlay, wherever focus is inside it, the thread beside
 * the viewer and code blocks included, which would otherwise keep the key.
 * It listens in the capture phase so nothing inside can swallow it first.
 */
function useEscapeCloses(active: ViewerOverlayEntry | null, close: (key: string) => void) {
  const key = active?.key ?? null;
  useEffect(() => {
    if (key === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      // A modified Escape is a shortcut, such as stopping the thread.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
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
      // A link target steps back to the viewer first, as Back does.
      const store = useViewerOverlayStore.getState();
      if (store.linked !== null) store.closeLinked();
      else close(key);
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
  /** A link target in the viewer's place: the header names it and Back returns to the viewer. */
  readonly linked: ViewerLinkTarget | null;
  readonly onCloseLinked: () => void;
  readonly showThreadToggle: boolean;
  readonly threadCollapsed: boolean;
  readonly onThreadCollapsedChange: (collapsed: boolean) => void;
  readonly setActionsSlot: (element: HTMLElement | null) => void;
  readonly setLinkedActionsSlot: (element: HTMLElement | null) => void;
  readonly onClose: () => void;
}) {
  const { linked } = props;
  const linkedHeader = linked ? viewerLinkHeader(linked) : null;
  const entry: ViewerOverlayEntry = linkedHeader
    ? {
        ...props.entry,
        ...linkedHeader,
        trail: [...props.entry.trail, { kind: props.entry.kind, title: props.entry.title }],
        onBack: props.onCloseLinked,
      }
    : props.entry;
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
      {/* The viewer's actions stay mounted while a link target is in front, out of sight. */}
      <div ref={props.setActionsSlot} className="viewer-overlay-actions" hidden={linked !== null} />
      {linked ? (
        <div
          ref={props.setLinkedActionsSlot}
          className="viewer-overlay-actions"
          data-viewer-linked-actions="true"
        />
      ) : null}
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
 * A link inside the overlay that goes to another page (a thread, a project,
 * the pull requests list) changes the route behind it. The overlay steps
 * aside then, so the page the reader asked for is the one in front.
 */
export function ViewerOverlayRouteGuard() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const { active, close } = useViewerOverlayStore.getState();
    if (active) close(active.key);
  }, [pathname]);
  return null;
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
  const setThreadComposerSlot = useViewerOverlayStore((state) => state.setThreadComposerSlot);
  const linked = useViewerOverlayStore((state) => state.linked);
  const closeLinked = useViewerOverlayStore((state) => state.closeLinked);
  const [linkedActions, setLinkedActions] = useState<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const open = active !== null;
  const threadRef = useStableThreadRef(active?.threadRef ?? null);
  // The coordinator's composer is its page's: the page lends it to the overlay.
  const pageOwnsComposer = useViewerOverlayStore(
    (state) => threadRef !== null && state.composerOwners.includes(threadOwnerKey(threadRef)),
  );
  const coordinator = threadRef !== null && (isCoordinator(threadRef) || pageOwnsComposer);
  const cwd = useThreadCwd(threadRef);
  const artifacts = useThreadViewables(threadRef, cwd);
  // An artifact picked from the strip; it takes the viewer until closed or replaced.
  const [picked, setPicked] = useState<string | null>(null);
  const pickedIndex = picked === null ? -1 : artifacts.findIndex((entry) => entry.key === picked);
  const currentKey =
    pickedIndex >= 0
      ? picked
      : (artifacts.find((entry) => entry.name === active?.title)?.key ?? null);
  useEscapeCloses(active, close);
  const renderThread =
    props.renderThread ??
    ((ref: ScopedThreadRef, options: OverlayThreadOptions) => (
      <OverlayThread threadRef={ref} {...options} />
    ));
  const hasThread = threadRef !== null;
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
            linked={linked}
            onCloseLinked={closeLinked}
            showThreadToggle={hasThread}
            threadCollapsed={collapsed}
            onThreadCollapsedChange={setCollapsed}
            setActionsSlot={setActionsSlot}
            setLinkedActionsSlot={setLinkedActions}
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
            // Kept mounted under a link target, so Back returns to the same place.
            hidden={linked !== null}
          />
          {linked ? <ViewerLinkedPane target={linked} actionsSlot={linkedActions} /> : null}
          {hasThread && !collapsed ? (
            <aside className="viewer-overlay-thread" aria-label="Thread">
              <InViewerOverlay value>
                <ThreadArtifactStrip
                  threadRef={threadRef}
                  artifacts={artifacts}
                  currentKey={currentKey}
                  onOpen={(key) => {
                    // The picked artifact replaces whatever a link opened in front.
                    useViewerOverlayStore.setState({ linked: null, linkedFrom: null });
                    setPicked(key);
                  }}
                />
                <div className="viewer-overlay-thread-main">
                  {renderThread(threadRef, { transcriptOnly: coordinator })}
                </div>
                {coordinator ? (
                  <div
                    ref={setThreadComposerSlot}
                    className="viewer-overlay-thread-composer"
                    data-viewer-thread-composer="true"
                  />
                ) : null}
              </InViewerOverlay>
            </aside>
          ) : null}
        </div>
        {threadRef && pickedIndex >= 0 ? (
          <ArtifactViewer
            threadRef={threadRef}
            cwd={cwd}
            artifacts={artifacts}
            index={pickedIndex}
            onIndex={(next) => setPicked(artifacts[next]?.key ?? null)}
            onClose={() => setPicked(null)}
          />
        ) : null}
      </DialogOverlayPopup>
    </Dialog>
  );
}
