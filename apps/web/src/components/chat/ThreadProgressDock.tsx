import type { ReactNode } from "react";

/**
 * The meta row, plan card and blocker note in the banner lane that overlays
 * the timeline. The lane (.chat-banner-lane) paints the opaque backdrop and
 * the fade below, so scrolled rows never show through the gaps between cards.
 */
export function ThreadProgressDock({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-1.5 px-3 pt-2 pb-2 sm:px-5"
      data-thread-progress-dock
    >
      {children}
    </div>
  );
}
