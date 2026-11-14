import type { ThreadToastData } from "./toast";

/**
 * A toast's progress bar: one bar, or equal segments like the copy's three-phase track,
 * so a copy reads the same in its dialog and in the corner. Segment i fills with the part
 * of the whole that falls inside it.
 */
export function ToastProgress({ data }: { readonly data: ThreadToastData }) {
  const progress = Math.min(1, Math.max(0, data.progress ?? 0));
  const count = Math.max(1, Math.round(data.progressSegments ?? 1));
  const finished = data.progressTone === "success";
  return (
    <div
      aria-label={data.progressLabel ?? "Update progress"}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(progress * 100)}
      className={`mt-2 grid w-full gap-0.5 ${finished ? "seg-finished" : ""}`}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      data-slot="toast-progress"
      role="progressbar"
    >
      {Array.from({ length: count }, (_, index) => {
        const part = Math.min(1, Math.max(0, progress * count - index));
        const running = part > 0 && part < 1;
        return (
          <div key={index} className="relative h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`seg-fill absolute inset-y-0 left-0 rounded-full ${finished ? "bg-success" : "bg-primary"}`}
              style={{ width: `${Math.round(part * 1000) / 10}%` }}
            >
              {data.progressLive && running ? <span className="seg-sheen" /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
