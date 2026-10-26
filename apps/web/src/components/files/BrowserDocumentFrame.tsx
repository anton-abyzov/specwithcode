import type { ScopedThreadRef } from "@specweave-studio/contracts";
import {
  HTML_RENDER_COPY_PATH_METHOD,
  HTML_RENDER_OPEN_FILE_METHOD,
  htmlRenderError,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  legacyLocalPathFromOpenLink,
  readHtmlRenderContentHeight,
  readHtmlRenderFileRequest,
  readHtmlRenderLinkRequest,
} from "@specweave-studio/shared/htmlRender";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { openFileInFront } from "~/lib/openInFront";
import { cn } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";

/**
 * Chromium's viewer opens with its own toolbar, a thumbnail rail and a small
 * zoom. The panel header is the only chrome we want, so ask for the page
 * alone, fitted to the panel width. Pinch and keyboard zoom, scrolling, text
 * selection and find still work inside the frame.
 */
const PDF_VIEWER_FRAGMENT = "#toolbar=0&view=FitH";

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Renders an HTML or PDF document from its URL. HTML runs in a sandboxed frame
 * with an opaque origin, so a page cannot reach the app's session or storage.
 * The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
 * An agent's HTML render also wears the app theme.
 */
export function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly htmlRender?: boolean;
}) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  return props.pdf ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- the built-in PDF viewer needs an unsandboxed frame.
    <iframe
      key={props.src}
      src={`${props.src}${PDF_VIEWER_FRAGMENT}`}
      title={props.title}
      className={className}
    />
  ) : props.htmlRender ? (
    <HtmlRenderPage key={props.src} src={props.src} title={props.title} />
  ) : (
    <iframe
      key={props.src}
      src={props.src}
      title={props.title}
      className={className}
      sandbox="allow-scripts allow-forms allow-popups"
    />
  );
}

// Stops a page sized in viewport units from growing its frame without end.
const HTML_RENDER_PAGE_MAX_HEIGHT = 50_000;

/**
 * An agent's HTML render opened on its own, on the page every report opens
 * on: the shared measure and margins, and room below its end. The frame takes
 * the height the page reports, so the page scrolls as one document. Until the
 * page reports, or if it never does, the frame holds a fixed height and
 * scrolls inside.
 */
function HtmlRenderPage(props: { readonly src: string; readonly title: string }) {
  const [height, setHeight] = useState<number>();
  const onContentHeight = useCallback(
    (next: number) => setHeight(Math.min(HTML_RENDER_PAGE_MAX_HEIGHT, Math.ceil(next))),
    [],
  );
  return (
    <div className="report-reader-body" data-html-render-page="true">
      <div className="report-document-page" data-measure="wide">
        <div style={{ height: height ?? "min(70vh, 40rem)" }}>
          <HtmlRenderDocument
            src={props.src}
            title={props.title}
            className="report-html-frame h-full"
            onContentHeight={onContentHeight}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Where a render's evidence links open: the thread and folder of the reply
 * showing it. It comes from the app, never from the page.
 */
export interface HtmlRenderFileTarget {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  /** False when this connection cannot read the machine's files. */
  readonly canReadFiles: boolean;
}

// One evidence request per this long; a page cannot flood the reader with files.
const FILE_REQUEST_INTERVAL_MS = 400;

/** The frame's own page asked, while the reader is using it. */
function trustedFrameMessage(event: MessageEvent, frame: HTMLIFrameElement | null): boolean {
  return (
    frame !== null &&
    event.source === frame.contentWindow &&
    // A sandboxed page without allow-same-origin always posts from the opaque origin.
    event.origin === "null"
  );
}

function readerIsUsing(frame: HTMLIFrameElement): boolean {
  return (
    !document.hidden &&
    document.activeElement === frame &&
    navigator.userActivation?.isActive !== false
  );
}

/** A home-relative path against the thread's folder, or undefined when no home is known. */
function absoluteEvidencePath(path: string, cwd: string): string | undefined {
  if (!path.startsWith("~/")) return path;
  const resolved = resolvePathLinkTarget(path, cwd);
  return resolved.startsWith("~") ? undefined : resolved;
}

/**
 * A sandboxed agent HTML render in the app theme. The page reads the theme from
 * its URL fragment before first paint, then follows changes posted to its
 * bootstrap. The first URL is kept for the frame's lifetime: signed asset URLs
 * re-mint while it stays mounted, and a new src would reload the page.
 */
export function HtmlRenderDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  /** Receives the page's content height whenever it changes, so an inline frame can fit it. */
  readonly onContentHeight?: (height: number) => void;
  readonly onEscape?: (() => void) | undefined;
  /** Lets the page's evidence links open and copy files; without it they are refused. */
  readonly fileTarget?: HtmlRenderFileTarget | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fileTargetRef = useRef(props.fileTarget);
  useLayoutEffect(() => {
    fileTargetRef.current = props.fileTarget;
  });
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  // The page cannot open windows itself (an inline page runs unopened, and
  // desktop sends any window to the browser). It asks the client, which opens
  // the link only while this frame has focus and the reader has just used the
  // app. A page can take focus by script, so this stops opens on load, not a
  // page that waits for the reader's next click or key.
  useEffect(() => {
    let lastFileRequest = Number.NEGATIVE_INFINITY;
    let copying = false;
    const reply = (frame: HTMLIFrameElement, message: object) =>
      frame.contentWindow?.postMessage(message, "*");
    // Every file request, new or from an old report, shares one pace and waits for a copy.
    const admitted = (frame: HTMLIFrameElement, id: string | number) => {
      const now = performance.now();
      if (now - lastFileRequest < FILE_REQUEST_INTERVAL_MS || copying) {
        reply(frame, htmlRenderError(id, "Policy violation"));
        return false;
      }
      lastFileRequest = now;
      return true;
    };
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (request === undefined || !trustedFrameMessage(event, frame) || !readerIsUsing(frame!)) {
        return;
      }
      // A report published before evidence links sends `/Users/…` as a URL on its own server.
      const legacyPath = legacyLocalPathFromOpenLink(request.url, frame!.src);
      if (legacyPath !== undefined) {
        if (admitted(frame!, request.id)) openEvidence(frame!, request.id, legacyPath, undefined);
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      reply(frame!, htmlRenderResult(request.id));
    };
    const openEvidence = (
      frame: HTMLIFrameElement,
      id: string | number,
      requested: string,
      line: number | undefined,
    ) => {
      const target = fileTargetRef.current;
      if (target === undefined) return reply(frame, htmlRenderError(id, "Not allowed here"));
      if (!target.canReadFiles) return reply(frame, htmlRenderError(id, "Policy violation"));
      const path = absoluteEvidencePath(requested, target.cwd);
      if (path === undefined) return reply(frame, htmlRenderError(id, "Invalid path"));
      // The file pane reads through the connection's file grant and the server's path guards.
      openFileInFront({
        environmentId: target.threadRef.environmentId,
        threadRef: target.threadRef,
        cwd: target.cwd,
        path,
        line,
      });
      reply(frame, htmlRenderResult(id));
    };
    const fileRequest = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!trustedFrameMessage(event, frame)) return;
      const data = event.data as { method?: unknown; id?: unknown } | null;
      if (
        data?.method !== HTML_RENDER_OPEN_FILE_METHOD &&
        data?.method !== HTML_RENDER_COPY_PATH_METHOD
      )
        return;
      if (!readerIsUsing(frame!)) return;
      const request = readHtmlRenderFileRequest(event.data);
      if (request === undefined) {
        if (typeof data.id === "string" || Number.isSafeInteger(data.id))
          reply(frame!, htmlRenderError(data.id as string | number, "Invalid path"));
        return;
      }
      if (!admitted(frame!, request.id)) return;
      if (request.method === "open-file") {
        openEvidence(frame!, request.id, request.path, request.line);
        return;
      }
      if (fileTargetRef.current === undefined)
        return reply(frame!, htmlRenderError(request.id, "Not allowed here"));
      // The app writes the clipboard: the sandboxed page cannot. It copies the
      // validated path exactly as the link wrote it, `~/` included.
      copying = true;
      void writeTextToClipboard(request.path, "path", undefined, { preserveBytes: true })
        .then(
          (copied) =>
            reply(
              frame!,
              copied ? htmlRenderResult(request.id) : htmlRenderError(request.id, "Copy failed"),
            ),
          () => reply(frame!, htmlRenderError(request.id, "Copy failed")),
        )
        .finally(() => {
          copying = false;
        });
    };
    window.addEventListener("message", openLink);
    window.addEventListener("message", fileRequest);
    return () => {
      window.removeEventListener("message", openLink);
      window.removeEventListener("message", fileRequest);
    };
  }, []);
  const { onContentHeight, onEscape } = props;
  useEffect(() => {
    if (!onEscape) return;
    const escape = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        document.activeElement !== frameRef.current
      )
        return;
      if (event.data?.jsonrpc === "2.0" && event.data?.method === "ui/notifications/report-escape")
        onEscape();
    };
    window.addEventListener("message", escape);
    return () => window.removeEventListener("message", escape);
  }, [onEscape]);
  // A page posts its height once per change, so listen from the commit that
  // inserts the frame; a passive effect could run after a fast page's first post.
  useLayoutEffect(() => {
    if (onContentHeight === undefined) return;
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        onContentHeight(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [onContentHeight]);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      loading="lazy"
      onLoad={() => {
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      className={cn("border-0 scheme-light", props.className)}
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
