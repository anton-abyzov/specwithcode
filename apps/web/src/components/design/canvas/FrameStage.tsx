import type { DesignNode, DesignPage } from "@specweave-studio/contracts";
import { designSubtreeIds } from "@specweave-studio/shared/designOps";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { DesignPageView } from "./NodeView";

/** One frame as its own page with the frame at the origin. */
export function framePage(page: DesignPage, frame: DesignNode): DesignPage {
  const ids = designSubtreeIds(page, frame.id);
  return {
    ...page,
    nodes: page.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => (node.id === frame.id ? { ...node, x: 0, y: 0, rotation: 0 } : node)),
  };
}

/** A frame scaled to fit its box, centered; `fade` eases each new frame in. */
export function FrameStage({
  page,
  frame,
  padding = 24,
  fade = false,
  className,
  testId,
}: {
  page: DesignPage;
  frame: DesignNode;
  padding?: number;
  fade?: boolean;
  className?: string;
  testId?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  // A short fade per new frame (the only transition), skipped for reduced motion.
  useEffect(() => {
    if (!fade || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = sheet.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      easing: "ease-out",
    });
    return () => animation?.cancel();
  }, [fade]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setScale(
        Math.max(
          0,
          Math.min(
            (box.width - padding * 2) / frame.width,
            (box.height - padding * 2) / frame.height,
          ),
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame.height, frame.width, padding]);

  const view = useMemo(() => framePage(page, frame), [frame, page]);

  return (
    <div
      ref={stage}
      data-testid={testId}
      className={cn(
        "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden",
        className,
      )}
    >
      <div
        ref={sheet}
        className="relative shrink-0 overflow-hidden shadow-2xl"
        style={{ width: frame.width * scale, height: frame.height * scale }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `scale(${scale})` }}
        >
          <DesignPageView page={view} />
        </div>
      </div>
    </div>
  );
}
