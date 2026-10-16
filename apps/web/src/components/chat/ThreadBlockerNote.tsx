import { HandIcon } from "lucide-react";
import { useState } from "react";

/** Longer blockers start clamped so the note never covers most of the transcript. */
const CLAMP_AFTER_CHARS = 200;

/**
 * The blocker a Blocked thread waits on, shown above the transcript.
 * Lists say Blocked from the same value, so the thread always shows why.
 * The note sits in the banner lane that overlays the timeline, so its
 * background must be opaque: a see-through tint lets scrolled rows show
 * through and overlap its text.
 */
export function ThreadBlockerNote({ blocker }: { blocker: string }) {
  const long = blocker.length > CLAMP_AFTER_CHARS;
  const [expanded, setExpanded] = useState(false);
  const clamped = long && !expanded;
  return (
    <section
      className="pointer-events-auto flex items-start gap-2 rounded-xl border border-warning/40 bg-card bg-linear-to-b from-warning/8 to-warning/8 px-3 py-2 text-sm shadow-xs dark:from-warning/16 dark:to-warning/16"
      aria-label="Blocked"
      data-thread-blocker
    >
      <HandIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <div className="min-w-0 flex-1">
        <p
          className={`break-words text-foreground/90 ${clamped ? "line-clamp-3" : "max-h-[40vh] overflow-y-auto"}`}
          data-thread-blocker-text
        >
          <span className="font-medium text-warning-foreground">Blocked: </span>
          {blocker}
        </p>
        {long ? (
          <button
            type="button"
            className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
