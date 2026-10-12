import type { ThreadContextRecord } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { useOpenThread } from "~/hooks/useOpenThread";
import { useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Inline chip for an attached thread, in the composer and in sent messages. Prefers the
 * live title so a renamed thread never shows a stale label, and opens the thread on click.
 */
export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  copyMarkdown?: string;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const title = shell?.title?.trim() || props.record.title;
  const { openInProject } = useOpenThread();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId }}
                onClick={(event) => {
                  // A modified click keeps the link's own behavior; a plain one stays in the project.
                  const modified =
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey;
                  if (!modified && openInProject({ environmentId, threadId }))
                    event.preventDefault();
                }}
              />
            }
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            <MessagesSquareIcon />
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{shell ? "Open thread" : "Thread no longer available"}</TooltipPopup>
    </Tooltip>
  );
}
