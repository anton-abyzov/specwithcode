import type { RunActivity } from "~/studio/coordinatorActivity";
import { Button } from "../ui/button";

/**
 * Verbose detail for one coordinator turn: what it did, step by step. Long
 * output is available in the coordinator details within the same project.
 */
export function CoordinatorRunActivity({
  activity,
  live = false,
  onOpenCoordinatorPage,
}: {
  activity: RunActivity;
  /** The turn is still running; its steps keep arriving. */
  live?: boolean;
  onOpenCoordinatorPage: (runId: string) => void;
}) {
  return (
    <details
      open
      className="sws-run-activity"
      data-run-activity={activity.runId}
      data-live={live ? "" : undefined}
    >
      <summary>{activity.summary}</summary>
      <ol aria-label={live ? "Steps so far" : "Steps"}>
        {activity.steps.map((step) => (
          <li key={step.id} data-failed={step.failed ? "" : undefined}>
            <span className="sws-run-activity-label">
              {step.label}
              {step.failed ? <span className="sr-only"> (failed)</span> : null}
            </span>
            {step.detail ? (
              <span className="sws-run-activity-detail" data-prose={step.prose ? "" : undefined}>
                {step.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <Button variant="ghost-muted" size="xs" onClick={() => onOpenCoordinatorPage(activity.runId)}>
        View tool output
      </Button>
    </details>
  );
}
