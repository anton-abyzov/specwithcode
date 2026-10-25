/**
 * "0996 · 3/5" beside a thread in lists: how far its increment or the agent's
 * checklist is ("Checklist 3/5" for a provider todo list, so it never reads as
 * an increment's tasks; "0996" alone for an increment with no tasks yet),
 * with what runs now and what comes next on hover and for screen readers.
 * Never a button: it sits inside rows that are buttons.
 */
import { ListChecksIcon, ListTodoIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  CHECKLIST_LABEL,
  describeThreadPlan,
  incrementNumber,
  type ThreadPlanCompact,
} from "../../studio/threadPlanProgress";
import { Tip } from "./shell/Tip";

export function PlanProgressChip({
  plan,
  className,
  tip = true,
}: {
  plan: ThreadPlanCompact;
  className?: string;
  /** False inside a row that already has its own tooltip. */
  tip?: boolean;
}) {
  const done = plan.total > 0 && plan.completed >= plan.total;
  const count = plan.total > 0 ? `${plan.completed}/${plan.total}` : null;
  const label =
    plan.source === "increment" && plan.label !== null
      ? [incrementNumber(plan.label), count].filter(Boolean).join(" · ")
      : `${CHECKLIST_LABEL} ${count ?? "0/0"}`;
  const description = describeThreadPlan(plan);
  const Icon = plan.source === "increment" ? ListChecksIcon : ListTodoIcon;
  const chip = (
    <span
      className={cn(
        "sws-thread-plan inline-flex shrink-0 items-center gap-1 text-xs tabular-nums",
        done ? "text-success-foreground" : "text-muted-foreground",
        className,
      )}
      data-plan-source={plan.source}
      data-plan-progress={`${plan.completed}/${plan.total}`}
    >
      <Icon aria-hidden className="size-3.5" />
      <span aria-hidden>
        {plan.source === "increment" && plan.label !== null ? (
          <>
            <span className={count ? "sws-thread-plan-id" : undefined}>
              {incrementNumber(plan.label)}
              {count ? " · " : ""}
            </span>
            {count}
          </>
        ) : (
          label
        )}
      </span>
      <span className="sr-only">{description}</span>
    </span>
  );
  return tip ? (
    <Tip label={description} side="top">
      {chip}
    </Tip>
  ) : (
    chip
  );
}
