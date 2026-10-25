import type { DesignNode, DesignPage } from "@specweave-studio/contracts";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { FrameStage } from "./FrameStage";

interface PresentedFrame {
  readonly page: DesignPage;
  readonly frame: DesignNode;
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A stopwatch that starts when present mode opens; pause and reset from the view. */
function useStopwatch() {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pausedAt !== null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [pausedAt]);
  const elapsed = (pausedAt ?? now) - startedAt;
  return {
    elapsed,
    paused: pausedAt !== null,
    toggle: () => {
      if (pausedAt === null) setPausedAt(Date.now());
      else {
        setStartedAt((start) => start + (Date.now() - pausedAt));
        setPausedAt(null);
        setNow(Date.now());
      }
    },
    reset: () => {
      const at = Date.now();
      setStartedAt(at);
      setNow(at);
      setPausedAt((paused) => (paused === null ? null : at));
    },
  };
}

/**
 * What the presenter sees: the current slide, the next one, the speaker
 * notes and a timer. The audience view is the same present mode without it.
 * Below 640 px the parts stack and scroll, the current slide first at full
 * width; from 640 px the current slide takes the wider left column.
 */
export function PresenterView({
  current,
  next,
  noun,
}: {
  current: PresentedFrame;
  next: PresentedFrame | undefined;
  noun: "slide" | "frame";
}) {
  const watch = useStopwatch();
  const notes = current.page.notes?.trim() ?? "";
  return (
    <div
      data-testid="presenter-view"
      className="grid min-h-0 flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-4 pb-3 sm:grid-cols-[minmax(0,1.75fr)_minmax(16rem,1fr)] sm:content-stretch sm:gap-6 sm:overflow-visible sm:p-6 sm:pb-3"
    >
      <section aria-label={`Current ${noun}`} className="flex min-h-0 flex-col gap-2">
        <h2 className="text-xs text-white/55">Now</h2>
        {/* Stacked, the grid row has no height of its own: the 16:9 box gives the slide one. */}
        <div
          data-testid="presenter-current-box"
          className="flex aspect-video w-full sm:aspect-auto sm:min-h-0 sm:flex-1"
        >
          <FrameStage
            key={current.frame.id}
            page={current.page}
            frame={current.frame}
            padding={0}
            fade
            testId="presenter-current"
            className="items-start"
          />
        </div>
      </section>
      <div className="flex min-h-0 flex-col gap-5">
        <section aria-label={`Next ${noun}`} className="flex shrink-0 flex-col gap-2">
          <h2 className="text-xs text-white/55">Next</h2>
          <div className="flex aspect-video w-full">
            {next === undefined ? (
              <p className="m-auto text-sm text-white/45">End of the deck</p>
            ) : (
              <FrameStage
                key={next.frame.id}
                page={next.page}
                frame={next.frame}
                padding={0}
                testId="presenter-next"
                className="opacity-85"
              />
            )}
          </div>
        </section>
        <section aria-label="Timer" className="flex shrink-0 items-center gap-2">
          <span
            className="text-4xl font-medium tabular-nums tracking-tight text-white"
            data-testid="presenter-timer"
            aria-live="off"
          >
            {formatElapsed(watch.elapsed)}
          </span>
          <Button
            variant="media-close"
            size="icon-sm"
            aria-label={watch.paused ? "Resume timer" : "Pause timer"}
            onClick={watch.toggle}
          >
            {watch.paused ? <PlayIcon /> : <PauseIcon />}
          </Button>
          <Button
            variant="media-close"
            size="icon-sm"
            aria-label="Reset timer"
            onClick={watch.reset}
          >
            <RotateCcwIcon />
          </Button>
        </section>
        <section aria-label="Speaker notes" className="flex min-h-0 flex-1 flex-col gap-2">
          <h2 className="text-xs text-white/55">Notes</h2>
          <div
            data-testid="presenter-notes"
            className="min-h-0 flex-1 overflow-y-auto pr-2 text-lg leading-relaxed whitespace-pre-wrap text-white/90"
          >
            {notes === "" ? (
              <span className="text-white/40">No notes for this {noun}.</span>
            ) : (
              notes
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
