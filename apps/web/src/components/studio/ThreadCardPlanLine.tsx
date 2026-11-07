/**
 * The task a worker card's thread is on, in one muted line under its title.
 * What comes next stays in the progress chip's tooltip, so the card never
 * grows a second clause. Nothing shows until the task has a real title.
 */
import type { ThreadPlanCompact } from "../../studio/threadPlanProgress";

export function ThreadCardPlanLine({ plan }: { plan: ThreadPlanCompact | null }) {
  if (!plan?.current) return null;
  return (
    <span className="sws-thread-card-plan" data-thread-card-plan>
      <span className="sr-only">Now: </span>
      {plan.current}
    </span>
  );
}
