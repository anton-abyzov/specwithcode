/**
 * What an Away session did, item by item: moved (with Open on <machine>),
 * paused, or stayed here with the reason. After Bring back each row says
 * whether it came back.
 */
import type { AwaySession, EnvironmentId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { awaySessionHeadline, summarizeAwaySession } from "./awaySession.logic";

const TONE = {
  ready: "text-success-foreground",
  attention: "text-warning-foreground",
  muted: "text-muted-foreground",
} as const;

export function AwaySessionSummary(props: {
  session: AwaySession;
  running: boolean;
  selfEnvironmentId: EnvironmentId;
  selfLabel: string;
  onOpenThread?: (threadId: string, environmentId: EnvironmentId) => void;
}) {
  const groups = useMemo(
    () => summarizeAwaySession(props.session, props.selfEnvironmentId),
    [props.session, props.selfEnvironmentId],
  );
  return (
    <div className="flex flex-col gap-3" data-testid="away-summary">
      <p
        role="status"
        className="text-sm text-muted-foreground"
        data-testid="away-summary-headline"
      >
        {awaySessionHeadline(props.session, props.running)}
      </p>
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">{group.title}</h3>
          <ul className="flex flex-col gap-1.5" aria-label={group.title}>
            {group.rows.map((row) => (
              <li
                key={row.key}
                data-away-outcome={row.item.outcome}
                className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{row.item.title}</span>
                  <span className="text-xs text-muted-foreground">{row.detail}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn("text-xs font-medium", TONE[row.tone])}>{row.label}</span>
                  {row.open && props.onOpenThread ? (
                    <button
                      type="button"
                      className="rounded-md text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        props.onOpenThread?.(row.open!.threadId, row.open!.environmentId)
                      }
                    >
                      {row.open.environmentId === props.session.targetEnvironmentId
                        ? `Open on ${props.session.targetLabel}`
                        : `Open on ${props.selfLabel}`}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
