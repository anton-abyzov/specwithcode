import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";

/** The same divider sizes both the thread list and an opened worker. */
export function ProjectWorkspaceColumns({ open, expanded, phone, workerOpen, children }: {
  open: boolean;
  expanded: boolean;
  phone: boolean;
  workerOpen: boolean;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { width, handlers } = usePreviewPanelInlineSize(undefined, {
    widthStorageKey: "studio:project-panel-width:v1",
    defaultWidth: 460,
    containerWidth,
  });
  const resizable = open && !expanded && !phone;
  return (
    <div
      ref={row}
      className={`project-workspace-columns sws-columns ${workerOpen ? "project-worker-open" : ""}`}
      data-overview={open ? "open" : "closed"}
      data-expanded={open && expanded ? "true" : undefined}
      style={{ position: "relative", ...(resizable ? { gridTemplateColumns: `minmax(0, 1fr) ${width}px` } : {}) }}
    >
      {children}
      {resizable && (
        <div
          role="separator"
          aria-label="Resize project panel"
          aria-orientation="vertical"
          className="sws-project-divider"
          style={{ right: width - 4 }}
          {...handlers}
        />
      )}
    </div>
  );
}
