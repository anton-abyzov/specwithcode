/**
 * Why a Skills control is disabled. A disabled button takes no pointer events
 * (and a native `title` on it never shows), so the reason goes on a focusable
 * wrapper with a tooltip, and is linked to it for screen readers.
 */
import { type ReactElement, useId } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SkillControlReason({
  reason,
  children,
}: {
  /** Null when the control works; the control is then rendered as it is. */
  reason: string | null;
  children: ReactElement;
}) {
  const id = useId();
  if (!reason) return children;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              aria-describedby={id}
              data-testid="skill-control-reason"
              className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side="top">{reason}</TooltipPopup>
      </Tooltip>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}
