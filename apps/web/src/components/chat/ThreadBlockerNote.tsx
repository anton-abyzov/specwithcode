import { useTx } from "../../i18n";
import { HandIcon } from "lucide-react";
import { useState } from "react";

/**
 * Past about one line the note starts folded to that line, so it never covers the
 * transcript; the reply above usually carries the same words in full.
 */
const CLAMP_AFTER_CHARS = 90;

/**
 * The blocker a Blocked thread waits on, shown above the transcript.
 * Lists say Blocked from the same value, so the thread always shows why.
 * The note sits in the banner lane that overlays the timeline, so its
 * background must be opaque: a see-through tint lets scrolled rows show
 * through and overlap its text.
 */
export function ThreadBlockerNote({ blocker }: { blocker: string }) {
  const tx = useTx();
  const long = blocker.length > CLAMP_AFTER_CHARS;
  const [expanded, setExpanded] = useState(false);
  const clamped = long && !expanded;
  return (
    <section
      className="pointer-events-auto flex items-start gap-2 rounded-xl border border-warning/40 lane-surface px-3 py-1.5 text-sm shadow-xs [--lane-tint:color-mix(in_srgb,var(--warning)_8%,transparent)] dark:[--lane-tint:color-mix(in_srgb,var(--warning)_16%,transparent)]"
      aria-label={tx("Blocked")}
      data-thread-blocker
    >
      <HandIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <div className={`min-w-0 flex-1 ${long ? "flex items-start gap-2" : ""}`}>
        <p
          className={`min-w-0 flex-1 break-words text-foreground/90 ${clamped ? "line-clamp-1" : "max-h-[40vh] overflow-y-auto"}`}
          data-thread-blocker-text
        >
          <span className="font-medium text-warning-foreground">{tx("Blocked:")} </span>
          {blocker}
        </p>
        {long ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? tx("Show less") : tx("Show more")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
