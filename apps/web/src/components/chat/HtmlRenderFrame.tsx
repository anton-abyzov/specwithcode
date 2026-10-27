import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@specweave-studio/shared/htmlRender";
import { ArrowUpRightIcon, FileTextIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useViewerOverlay, useViewerOverlayStore } from "~/viewerOverlayStore";

import { HtmlRenderDocument, type HtmlRenderFileTarget } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";

// A frame may load its URL a little after mounting.
const MIN_URL_LIFE_MS = 5 * 60_000;

/**
 * The page's asset URL. A cached URL with life left is reused, so the
 * browser's cache serves the page again; one near expiry is minted afresh,
 * since a frame cannot report a failed load. The page keeps its first URL for
 * its lifetime.
 */
function useHtmlRenderSrc(environmentId: EnvironmentId, attachmentId: string, title: string) {
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetUrl = useAssetUrlState(src === null ? environmentId : null, resource);
  const cachedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  const cachedExpiresAt = assetUrl._tag === "Success" ? assetUrl.expiresAt : 0;
  const cacheFailed = assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(environmentId, resource);
  // At most one mint per mount: expiry is server time and the check uses the
  // client clock, so a skewed clock must not mint again on every update.
  const minting = useRef(false);
  useEffect(() => {
    if (src !== null || minting.current) return;
    if (cacheFailed) {
      // oxlint-disable-next-line react/set-state-in-effect -- Mirrors the cached URL's failure.
      setFailed(true);
      return;
    }
    if (cachedUrl === null) return;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      setSrc(cachedUrl);
      return;
    }
    minting.current = true;
    void refresh().then(
      (url) => (url === null ? setFailed(true) : setSrc(url)),
      () => setFailed(true),
    );
  }, [cacheFailed, cachedExpiresAt, cachedUrl, refresh, src]);

  return { src, failed };
}

interface HtmlRenderFrameProps {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef?: ScopedThreadRef | null;
  /** The thread's folder; with `threadRef` it lets the report's evidence links open files. */
  readonly cwd?: string | undefined;
}

/** A published page in the thread: a `show_visual` diagram in full, or a report preview. */
export function HtmlRenderFrame(props: HtmlRenderFrameProps) {
  return props.htmlRender.kind === "visual" ? (
    <HtmlVisualFrame {...props} />
  ) : (
    <HtmlReportFrame {...props} />
  );
}

/**
 * An agent's diagram or chart, shown whole at its own height under a
 * "Made a visual" toggle. The frame stays mounted while collapsed, so
 * reopening it keeps the visual's state.
 */
function HtmlVisualFrame(props: HtmlRenderFrameProps) {
  const { attachmentId, title } = props.htmlRender;
  const { canReadFiles } = useFilesystemReadAccess(props.environmentId);
  const { threadRef, cwd } = props;
  const fileTarget = useMemo<HtmlRenderFileTarget | undefined>(
    () => (threadRef && cwd ? { threadRef, cwd, canReadFiles } : undefined),
    [threadRef, cwd, canReadFiles],
  );
  const { src, failed } = useHtmlRenderSrc(props.environmentId, attachmentId, title);
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (box.clientWidth > 0) setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      // A collapsed visual measures 0 wide; it keeps the last real width.
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const label = title.replace(/[_-]+/g, " ").trim() || "Visual";
  return (
    <section className="html-visual" aria-label={label}>
      <button
        type="button"
        className="html-visual-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Made a visual</span>
        <svg
          aria-hidden
          viewBox="0 0 10 10"
          className={cn("size-2.5 transition-transform duration-150", !open && "-rotate-90")}
        >
          <path d="M1.5 3h7L5 7.5z" fill="currentColor" />
        </svg>
      </button>
      <div id={bodyId} className="html-visual-body" hidden={!open}>
        <div ref={boxRef} className="html-visual-document" style={{ height }}>
          {src !== null ? (
            <HtmlRenderDocument
              src={src}
              title={label}
              className="block size-full"
              onContentHeight={setContentHeight}
              fileTarget={fileTarget}
            />
          ) : (
            <p className="html-visual-placeholder" role="status">
              {failed ? `Unable to load ${label}` : "Loading visual…"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** A bounded preview that moves the same live document into the focused reader. */
function HtmlReportFrame(props: HtmlRenderFrameProps) {
  const { attachmentId, title } = props.htmlRender;
  // Evidence links open in this reply's own thread and folder, whatever the page claims.
  const { canReadFiles } = useFilesystemReadAccess(props.environmentId);
  const { threadRef, cwd } = props;
  const fileTarget = useMemo<HtmlRenderFileTarget | undefined>(
    () => (threadRef && cwd ? { threadRef, cwd, canReadFiles } : undefined),
    [threadRef, cwd, canReadFiles],
  );
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const readerScroll = useRef(0);
  const [expanded, setExpanded] = useState(false);
  // A stable portal target avoids remounting the iframe (and resetting tabs/forms).
  const [mount] = useState(() => document.createElement("div"));
  const moveTo = (target: HTMLElement) => {
    if (mount.parentElement === target) return;
    if (mount.isConnected && "moveBefore" in target) {
      (
        target as HTMLElement & { moveBefore: (node: Node, before: Node | null) => void }
      ).moveBefore(mount, null);
    } else target.appendChild(mount);
  };
  const close = () => {
    readerScroll.current = readerRef.current?.scrollTop ?? 0;
    // Move back before the overlay host is removed from the document.
    if (inlineRef.current) moveTo(inlineRef.current);
    setExpanded(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };
  const slots = useViewerOverlay({
    open: expanded,
    title: props.htmlRender.title,
    kind: "Report",
    badge: null,
    threadRef: props.threadRef,
    onClose: close,
  });
  useLayoutEffect(() => {
    const target = expanded ? slots?.content : inlineRef.current;
    if (!target) return;
    moveTo(target);
    if (expanded && readerRef.current) readerRef.current.scrollTop = readerScroll.current;
  }, [expanded, mount, slots?.content]);
  useEffect(
    () => () => {
      mount.remove();
    },
    [mount],
  );
  const open = () => {
    useViewerOverlayStore.getState().setThreadCollapsed(true);
    setExpanded(true);
  };
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [mount]);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const { src, failed } = useHtmlRenderSrc(props.environmentId, attachmentId, title);

  const previewHeight = Math.min(height, 360);
  const documentHeight = expanded ? Math.min(50_000, contentHeight ?? height) : height;
  return (
    <section className="html-report-card" aria-label={title}>
      <header className="html-report-card-head">
        <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="html-report-card-title">{title}</h3>
          <p className="html-report-card-kind">Interactive report</p>
        </div>
        <Button ref={triggerRef} variant="ghost" size="sm" onClick={open} disabled={src === null}>
          Open report <ArrowUpRightIcon aria-hidden className="size-4" />
        </Button>
      </header>
      <div className="html-report-preview" style={{ height: previewHeight }}>
        <div ref={inlineRef} />
        {expanded ? <p className="html-report-placeholder">Open in reader</p> : null}
        {!expanded && src !== null ? (
          <div className="html-report-preview-fade" aria-hidden />
        ) : null}
        {src === null ? (
          <p className="html-report-placeholder" role="status">
            {failed ? `Unable to load ${title}` : "Loading report…"}
          </p>
        ) : null}
      </div>
      <p className="html-report-card-foot">
        Open the report to explore its diagrams, details and evidence.
      </p>
      {createPortal(
        <div
          ref={readerRef}
          className={expanded ? "html-report-reader" : "html-report-preview-page"}
        >
          <div
            ref={boxRef}
            className="html-report-document"
            inert={!expanded}
            style={{ height: documentHeight }}
          >
            {src !== null ? (
              <HtmlRenderDocument
                src={src}
                title={title}
                className="block size-full"
                onContentHeight={setContentHeight}
                onEscape={expanded ? close : undefined}
                fileTarget={fileTarget}
              />
            ) : null}
          </div>
        </div>,
        mount,
      )}
    </section>
  );
}
