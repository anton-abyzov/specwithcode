import type { CoordinatorReplySource } from "@specweave-studio/shared/coordinatorReplySources";
import { useContext } from "react";

import { ConversationMachineContext, sourceMachine } from "../../studio/conversationMachine";

/** Structured turn provenance, independent of model-written text. */
export function CoordinatorReplySources({
  sources,
  onOpenThread,
  resolveTitle,
  inline = false,
  canOpenThread,
}: {
  sources: readonly CoordinatorReplySource[];
  onOpenThread: (threadId: string, environmentId: string) => void;
  resolveTitle?: (threadId: string, environmentId: string) => string | undefined;
  inline?: boolean;
  canOpenThread?: (environmentId: string) => boolean;
}) {
  // A source thread on another machine than the coordinator's names it (1427 AC-06).
  const coordinatorMachine = useContext(ConversationMachineContext);
  if (sources.length === 0) return null;
  return (
    <span className="sws-reply-sources" data-reply-sources="" aria-label="Reply sources">
      {sources.map((source, index) => {
        const prefix = inline ? "" : "re: ";
        if (source.kind === "thread") {
          const title =
            resolveTitle?.(source.threadId, source.environmentId)?.trim() ||
            source.title?.trim() ||
            "Source thread";
          const machine = sourceMachine(coordinatorMachine, source.environmentId);
          return (
            <button
              type="button"
              className="sws-reply-source"
              key={`${source.environmentId}:${source.threadId}`}
              disabled={canOpenThread?.(source.environmentId) === false}
              aria-label={`Open source thread ${title}${machine ? ` on ${machine}` : ""}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenThread(source.threadId, source.environmentId);
              }}
            >
              {prefix}
              {title}
              {machine ? <span data-reply-source-machine="">{` · ${machine}`}</span> : null}
              {canOpenThread?.(source.environmentId) === false ? " · unavailable" : ""}
              <span aria-hidden="true"> ↗</span>
            </button>
          );
        }
        if (source.kind === "pull_request")
          return (
            <a
              className="sws-reply-source"
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              {prefix}
              {source.title}
              <span aria-hidden="true"> ↗</span>
            </a>
          );
        return (
          <span className="sws-reply-source-label" key={index}>
            {prefix}
            {source.title}
          </span>
        );
      })}
    </span>
  );
}
