import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { HandoffTimelineRun } from "@specweave-studio/client-runtime/handoff";
import { resolveUserMessagePresentation } from "@specweave-studio/client-runtime/user-message";
import { useEnvironment } from "../../state/environments";
import { requestExecutionLabel } from "../../studio/projectDomain";
import { useProjectMessageRouting } from "../../studio/projectMessageRouting";
import type { ChatMessage } from "../../types";
import { ScheduledTaskLink } from "../settings/ScheduledTaskLink";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Sender and execution origin are distinct: an agent may ask a different host/model to run. */
export function UserMessageProvenance({
  message,
  runs,
  environmentId,
  onOpenThread,
}: {
  readonly message: ChatMessage;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const routing = useProjectMessageRouting();
  const environment = useEnvironment(environmentId);
  const presentation = resolveUserMessagePresentation(message);
  const senderThreadId = message.senderThreadId;
  // The transcript is bound to its execution environment. Its run, not today's
  // composer selection, owns the historical provider/model attribution.
  const execution = requestExecutionLabel(message, runs, environment?.label ?? environmentId);
  return (
    <>
      {presentation.isAutomation ? (
        <p
          className="me-1 text-2xs text-muted-foreground"
          data-user-message-attribution="automation"
        >
          {presentation.scheduledTaskId ? (
            <ScheduledTaskLink
              environmentId={environmentId}
              taskId={presentation.scheduledTaskId}
              className="rounded-sm hover:text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              Sent by automation
            </ScheduledTaskLink>
          ) : (
            "Sent by automation"
          )}
        </p>
      ) : message.createdBy === "user" && senderThreadId ? (
        // The user's own words, delivered here by the thread that routed them.
        <p className="me-1 text-2xs text-muted-foreground" data-user-message-attribution="routed">
          <InlineButton
            onClick={() =>
              senderThreadId === routing?.coordinatorThreadId
                ? routing.openCoordinator()
                : onOpenThread(senderThreadId)
            }
            tone="muted"
            aria-label="Open routing thread"
          >
            {senderThreadId === routing?.coordinatorThreadId
              ? "Your message · Routed by coordinator · View coordinator"
              : "Your message · Routed by another thread"}
          </InlineButton>
        </p>
      ) : message.createdBy === "agent" ? (
        <p className="me-1 text-2xs text-muted-foreground" data-user-message-attribution="agent">
          {senderThreadId ? (
            <InlineButton
              onClick={() =>
                senderThreadId === routing?.coordinatorThreadId
                  ? routing.openCoordinator()
                  : onOpenThread(senderThreadId)
              }
              tone="muted"
              aria-label="Open sending thread"
            >
              {senderThreadId === routing?.coordinatorThreadId
                ? "Message received from coordinator · View coordinator"
                : "Sent by another agent"}
            </InlineButton>
          ) : (
            "Sent by another agent"
          )}
        </p>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={<p />}
          className="me-1 max-w-[80%] break-words text-right text-2xs text-muted-foreground"
          data-request-execution-origin="true"
          data-environment-id={environmentId}
          data-run-id={message.runId ?? undefined}
          aria-label={`${execution}. Execution environment: ${environmentId}`}
        >
          {execution}
        </TooltipTrigger>
        <TooltipPopup>Execution environment: {environmentId}</TooltipPopup>
      </Tooltip>
    </>
  );
}
