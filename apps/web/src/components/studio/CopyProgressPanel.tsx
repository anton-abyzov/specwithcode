import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  addRateSample,
  COPY_PHASES,
  countsText,
  formatRate,
  phaseLabel,
  phaseParts,
  rateOf,
  timeLeftText,
  type CopyPhase,
  type CopyProgressView,
  type RateSample,
} from "../../studio/copyProgress";
import { formatDuration } from "../../studio/folderCopy";

/**
 * Bytes per second for the step a view is in, from what the counts did over the last few
 * seconds. Readings go in once a second, so a stall shows as no speed rather than an old one.
 * Bytes already on the destination are left out: they arrive without being sent.
 */
export function useCopyRate(view: CopyProgressView | null): number | null {
  const key = view?.outcome === "running" && view.bytes ? view.rateKey : null;
  const latest = useRef<number | null>(null);
  latest.current = view?.bytes ? view.bytes.done - view.bytesLocal : null;
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    setRate(null);
    if (key === null) return;
    let samples: ReadonlyArray<RateSample> = [];
    const sample = () => {
      if (latest.current === null) return;
      samples = addRateSample(samples, { at: Date.now(), bytes: latest.current });
      setRate(rateOf(samples));
    };
    sample();
    const timer = window.setInterval(sample, 1_000);
    return () => window.clearInterval(timer);
  }, [key]);
  return rate;
}

/** "2 min 05 s elapsed" since `startedAt`, ticking while the copy runs. */
function useElapsed(startedAt: string | null | undefined, running: boolean): string | null {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  const live = running && Number.isFinite(started);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return live ? `${formatDuration(Math.max(0, now - started))} elapsed` : null;
}

type SegmentState = "done" | "active" | "todo" | "failed";

const segmentState = (phase: CopyPhase, view: CopyProgressView): SegmentState => {
  const at = COPY_PHASES.indexOf(view.phase);
  const index = COPY_PHASES.indexOf(phase);
  if (view.outcome === "finished" || index < at) return "done";
  if (index > at) return "todo";
  return view.outcome === "failed" ? "failed" : "active";
};

/**
 * The copy's three phases as one track: finished phases full, the running one filled as far
 * as it is, the rest empty. A phase that cannot say how far it is shows a moving sweep.
 */
export function CopyPhaseTrack({
  view,
  sourceLabel,
  targetLabel,
  compact = false,
}: {
  readonly view: CopyProgressView;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** The banner's slim track: no phase names under it. */
  readonly compact?: boolean;
}) {
  const percent = view.fraction === null ? null : Math.floor(view.fraction * 100);
  return (
    <div data-slot="copy-phase-track" data-outcome={view.outcome} data-phase={view.phase}>
      <div
        className={`grid grid-cols-3 ${compact ? "gap-0.5" : "gap-1"}`}
        role="progressbar"
        aria-label={`${phaseLabel(view.phase, sourceLabel, targetLabel)}: ${view.step}`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { "aria-valuenow": percent })}
        aria-valuetext={percent === null ? view.step : `${view.step}, ${percent}%`}
      >
        {COPY_PHASES.map((phase) => {
          const state = segmentState(phase, view);
          // A stopped phase fills red up to where it stopped, or whole when that is unknown.
          const fill =
            state === "failed" && view.fraction !== null
              ? Math.max(4, view.fraction * 100)
              : state === "done" || state === "failed"
                ? 100
                : state === "active" && view.fraction !== null
                  ? view.fraction * 100
                  : 0;
          return (
            <span
              key={phase}
              data-segment={phase}
              data-state={state}
              className={`relative overflow-hidden rounded-full bg-muted ${compact ? "h-1" : "h-2"}`}
            >
              <span
                className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${
                  view.outcome === "finished"
                    ? "bg-success"
                    : state === "failed"
                      ? "bg-destructive"
                      : "bg-primary"
                }`}
                style={{ width: `${fill}%` }}
              />
              {state === "active" && view.fraction === null && (
                <span className="copy-phase-sweep absolute inset-y-0 w-1/3 rounded-full bg-primary/70" />
              )}
            </span>
          );
        })}
      </div>
      {!compact && (
        <ol className="mt-1.5 grid grid-cols-3 gap-1 text-xs" aria-hidden>
          {COPY_PHASES.map((phase) => {
            const state = segmentState(phase, view);
            return (
              <li
                key={phase}
                data-state={state}
                className={`min-w-0 leading-tight ${
                  state === "active"
                    ? "text-foreground"
                    : state === "failed"
                      ? "text-destructive-foreground"
                      : "text-muted-foreground"
                }`}
              >
                <span
                  className={`flex items-center gap-1 ${state === "active" || state === "failed" ? "font-medium" : ""}`}
                >
                  {state === "done" && <CheckIcon className="size-3 shrink-0" />}
                  {state === "failed" && <XIcon className="size-3 shrink-0" />}
                  {phaseParts(phase, sourceLabel, targetLabel)[0]}
                </span>
                <span className="block truncate text-muted-foreground">
                  {phaseParts(phase, sourceLabel, targetLabel)[1]}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * The running copy, in the dialog: what is happening now and how far, the three phases,
 * how much of what has moved, and the speed and time left once there is a pace to go by.
 */
export function CopyProgressPanel({
  view,
  sourceLabel,
  targetLabel,
  startedAt,
  stepSlot = "copy-progress-step",
}: {
  readonly view: CopyProgressView;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** When the person approved the copy; elapsed time counts from there. */
  readonly startedAt?: string | null;
  /** The step line's data-slot, for tests and checks that read it. */
  readonly stepSlot?: string;
}) {
  const rate = useCopyRate(view);
  const elapsed = useElapsed(startedAt, view.outcome === "running");
  const percent = view.fraction === null ? null : Math.floor(view.fraction * 100);
  const counts = countsText(view);
  const left = timeLeftText(view, rate);
  const local =
    view.bytesLocal > 0 && view.phase === "send"
      ? `${countsText({ bytes: { done: view.bytesLocal, total: null }, files: null }).bytes} already on ${targetLabel}`
      : null;
  return (
    <section
      className="space-y-3 rounded-lg border bg-card px-4 py-3.5"
      data-slot="copy-progress"
      data-outcome={view.outcome}
      aria-live="polite"
    >
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium" data-slot={stepSlot}>
            {view.step}
            {view.outcome === "running" ? "…" : ""}
          </p>
        </div>
        {percent !== null && (
          <span
            className="shrink-0 text-2xl font-semibold leading-none tracking-tight tabular-nums"
            data-slot="copy-progress-percent"
            aria-hidden
          >
            {percent}
            <span className="ml-0.5 text-sm font-medium text-muted-foreground">%</span>
          </span>
        )}
      </div>
      <CopyPhaseTrack view={view} sourceLabel={sourceLabel} targetLabel={targetLabel} />
      {(counts.bytes || counts.files || rate || elapsed) && (
        <div className="space-y-0.5 text-xs tabular-nums" aria-live="off">
          {(counts.bytes || counts.files) && (
            <p className="flex flex-wrap gap-x-4" data-slot="copy-progress-counts">
              {counts.bytes && <span>{counts.bytes}</span>}
              {counts.files && <span>{counts.files}</span>}
              {local && <span className="text-muted-foreground">{local}</span>}
            </p>
          )}
          {(rate || left || elapsed) && (
            <p
              className="flex flex-wrap gap-x-4 text-muted-foreground"
              data-slot="copy-progress-pace"
            >
              {rate && <span>{formatRate(rate)}</span>}
              {left && <span>{left}</span>}
              {elapsed && <span>{elapsed}</span>}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
