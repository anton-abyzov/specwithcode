import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { cn } from "../../lib/utils";

/**
 * Archived projects stay out of Settings lists by default. This collapsed toggle
 * shows them, grayed, for the rare case someone still wants to change one.
 */
export function ArchivedDisclosure({
  count,
  children,
  className,
}: {
  readonly count: number;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (count === 0) return null;
  return (
    <div className={cn("flex flex-col", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="flex items-center gap-1 self-start px-3 py-2 text-muted-foreground text-xs hover:text-foreground sm:px-4"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {open ? "Hide archived" : "Show archived"} ({count})
      </button>
      {open ? (
        <div id={id} data-archived-projects className="opacity-60">
          {children}
        </div>
      ) : null}
    </div>
  );
}
