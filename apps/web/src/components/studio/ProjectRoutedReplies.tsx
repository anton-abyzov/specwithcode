import { useEffect, useMemo, useRef, useState } from "react";
import * as DateTime from "effect/DateTime";
import type { ThreadId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { useThreadProjection } from "../../state/entities";
import { routedRepliesForThread } from "../../studio/projectCoordinatorMessageDisplay";
import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * What the person typed inside this thread. Each message went to the coordinator and
 * is kept on its conversation, so the thread shows that record instead of losing it.
 */
export function ProjectRoutedReplies({
  project,
  coordinatorId,
  thread,
  onOpenCoordinator,
}: {
  project: { readonly id: string; readonly environmentId: EnvironmentThreadShell["environmentId"] };
  coordinatorId: ThreadId;
  thread: EnvironmentThreadShell;
  /** Leaves this thread for the coordinator's conversation in the main column. */
  onOpenCoordinator: () => void;
}) {
  const ref = useMemo(
    () => scopeThreadRef(project.environmentId, coordinatorId),
    [project.environmentId, coordinatorId],
  );
  const coordinator = useThreadProjection(ref);
  const messages = coordinator?.projection.messages;
  const replies = useMemo(
    () => (messages ? routedRepliesForThread(messages, project, thread) : []),
    [messages, project, thread],
  );
  const [open, setOpen] = useState(false);
  // A message sent just now is the one the person is looking for.
  const seen = useRef(replies.length);
  useEffect(() => {
    if (replies.length > seen.current) setOpen(true);
    seen.current = replies.length;
  }, [replies.length]);
  if (replies.length === 0) return null;
  return (
    <details
      className="project-routed"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {replies.length === 1
          ? "1 message you sent from this thread"
          : `${replies.length} messages you sent from this thread`}
      </summary>
      <ol aria-label="Messages you sent from this thread">
        {replies.map((reply) => (
          <li key={reply.id}>
            <p className="project-routed-text">{reply.text.trim()}</p>
            <p className="project-routed-answer">
              {reply.createdAt
                ? `${formatRelativeTimeLabel(DateTime.formatIso(reply.createdAt))} · `
                : ""}
              {reply.answer === null
                ? "Waiting for the coordinator"
                : `Coordinator: ${reply.answer}`}
            </p>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="project-control project-text-link"
        onClick={onOpenCoordinator}
      >
        Show in the coordinator chat
      </button>
    </details>
  );
}
