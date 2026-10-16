import { HandIcon } from "lucide-react";

/**
 * The blocker a Blocked thread waits on, shown in full above the transcript.
 * Lists say Blocked from the same value, so the thread always shows why.
 */
export function ThreadBlockerNote({ blocker }: { blocker: string }) {
  return (
    <section
      className="pointer-events-auto flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/8 px-3 py-2 text-sm dark:bg-warning/16"
      aria-label="Blocked"
      data-thread-blocker
    >
      <HandIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <p className="min-w-0 break-words text-foreground/90">
        <span className="font-medium text-warning-foreground">Blocked: </span>
        {blocker}
      </p>
    </section>
  );
}
