import type { DesignDocument, DesignSystem } from "@specweave-studio/contracts";
import { renderDesignHtml } from "@specweave-studio/shared/designRender";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Image assets have no URL in a thumbnail; a neutral tile keeps the layout. */
const ASSET_PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#d9dbe0"/></svg>',
  );

/** The first visible top-level frame of the first page, else the whole page. */
export function thumbnailTarget(document: DesignDocument) {
  const page = document.pages[0];
  if (page === undefined) return null;
  const frame = page.nodes.find(
    (node) => node.parentId === null && node.type === "frame" && node.hidden !== true,
  );
  return frame ? { pageId: page.id, frameId: frame.id } : { pageId: page.id };
}

/**
 * Nothing in a thumbnail may reach the network: designs can hold agent-written
 * HTML. Images and fonts come inline. When image assets move to signed
 * /api/assets URLs, add that exact origin to img-src.
 */
export const THUMBNAIL_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

export function thumbnailHtml(document: DesignDocument, system: DesignSystem | null) {
  const target = thumbnailTarget(document);
  if (target === null) return null;
  try {
    const rendered = renderDesignHtml(document, target, {
      system,
      mode: system?.modes[0]?.id ?? "default",
      assetUrl: () => ASSET_PLACEHOLDER,
    });
    const csp = `<meta http-equiv="Content-Security-Policy" content="${THUMBNAIL_CSP}">`;
    const html = rendered.html.includes("<head>")
      ? rendered.html.replace("<head>", `<head>${csp}`)
      : `${csp}${rendered.html}`;
    return { ...rendered, html };
  } catch {
    return null;
  }
}

/** Mounts its children once the slot comes near the viewport, and keeps them. */
export function NearViewport({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return (
    <div ref={ref} className={className}>
      {near ? children : null}
    </div>
  );
}

/**
 * A live picture of a design: its first frame rendered by the shared renderer
 * into an opaque-origin iframe (no scripts, no same-origin), scaled to fit the
 * slot like a sheet laid on a desk.
 */
export function DesignThumbnail({
  document,
  system = null,
  className,
}: {
  document: DesignDocument | null;
  system?: DesignSystem | null;
  className?: string;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const rendered = useMemo(
    () => (document === null ? null : thumbnailHtml(document, system)),
    [document, system],
  );

  useEffect(() => {
    const element = slot.current;
    if (element === null) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale =
    rendered && box
      ? Math.min((box.width * 0.86) / rendered.width, (box.height * 0.84) / rendered.height, 1)
      : 0;

  return (
    <div
      ref={slot}
      className={cn("relative flex items-center justify-center overflow-hidden", className)}
      data-slot="design-thumbnail"
      data-state={document === null ? "loading" : rendered === null ? "empty" : "ready"}
    >
      {rendered && scale > 0 ? (
        <div
          className="relative overflow-hidden rounded-xs bg-white ring-1 ring-black/8 dark:ring-white/10"
          style={{ width: rendered.width * scale, height: rendered.height * scale }}
        >
          <iframe
            title="Design preview"
            aria-hidden
            tabIndex={-1}
            sandbox=""
            loading="lazy"
            srcDoc={rendered.html}
            className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
            style={{
              width: rendered.width,
              height: rendered.height,
              transform: `scale(${scale})`,
            }}
          />
        </div>
      ) : document === null ? (
        <div className="h-3/5 w-3/5 animate-pulse rounded-xs bg-foreground/[0.04] motion-reduce:animate-none" />
      ) : (
        <div className="h-3/5 w-3/5 rounded-xs bg-white ring-1 ring-black/8 dark:ring-white/10" />
      )}
    </div>
  );
}
