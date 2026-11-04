/**
 * Threads of the project waiting for the person to allow access, at the end of
 * the coordinator's conversation: a quiet card per thread (what it asks for and
 * a way to open it), then one timeline line naming the machine and the reason.
 * The answer itself is given on the thread's own card.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { HandIcon } from "lucide-react";

import type { AccessWaitingThread } from "../../studio/accessWaiting";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectThreadChip } from "./ProjectThreadCards";

export function CoordinatorAccessWaiting({
  entries,
  onOpenThread,
}: {
  entries: ReadonlyArray<AccessWaitingThread>;
  onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="sws-access-wait-list" aria-label="Threads waiting for access">
      {entries.map((entry) => (
        <li
          key={`${entry.thread.environmentId}:${entry.thread.id}`}
          data-access-waiting={entry.thread.id}
        >
          <div
            className="sws-access-wait"
            role="group"
            aria-label={`${entry.title}: ${entry.subtitle}`}
          >
            <span className="sws-access-wait-tile" aria-hidden>
              <HandIcon />
            </span>
            <span className="sws-access-wait-text">
              <Tooltip>
                <TooltipTrigger render={<span className="sws-access-wait-title" />}>
                  {entry.title}
                </TooltipTrigger>
                <TooltipPopup>{entry.title}</TooltipPopup>
              </Tooltip>
              <span className="sws-access-wait-subtitle">{entry.subtitle}</span>
            </span>
            <button
              type="button"
              className="sws-access-wait-open"
              aria-label={`View thread ${entry.title}`}
              onClick={() => onOpenThread(entry.thread)}
            >
              View thread
            </button>
          </div>
          <p className="sws-access-wait-line" data-access-waiting-line="">
            <ProjectThreadChip
              thread={entry.thread}
              label={entry.title}
              onOpen={() => onOpenThread(entry.thread)}
            />{" "}
            {entry.sentence}
          </p>
        </li>
      ))}
    </ul>
  );
}
