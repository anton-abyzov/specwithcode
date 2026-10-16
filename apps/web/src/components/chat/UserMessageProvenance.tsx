import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import type { HandoffTimelineRun } from "@specweave-studio/client-runtime/handoff";
import { resolveUserMessagePresentation } from "@specweave-studio/client-runtime/user-message";
import { useEnvironment } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { requestExecutionLabel } from "../../studio/projectDomain";
import { useProjectMessageRouting } from "../../studio/projectMessageRouting";
import type { ChatMessage } from "../../types";
import { ScheduledTaskLink } from "../settings/ScheduledTaskLink";
import { InlineButton } from "../ui/button";
import { useProviderEntries } from "../studio/shell/ModelBadge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Sender and execution origin are distinct: an agent may ask a different host/model to run. */
export function UserMessageProvenance({
  message,
  runs,
  environmentId,
  threadRef,
  onOpenThread,
}: {
  readonly message: ChatMessage;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly environmentId: EnvironmentId;
  readonly threadRef?: ScopedThreadRef | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const routing = useProjectMessageRouting();
  const environment = useEnvironment(environmentId);
  const providers = useProviderEntries(environmentId);
  const presentation = resolveUserMessagePresentation(message);
  const senderThreadId = message.senderThreadId;
  // The transcript is bound to its execution environment. Its run, not today's
  // composer selection, owns the historical provider/model attribution.
  // A subagent's task arrives outside any run; it ran on the subagent thread's own model.
  const thread = useThreadShell(threadRef ?? null);
  const execution = requestExecutionLabel(
    message,
    runs,
    environment?.label ?? environmentId,
    providers,
    thread?.modelSelection ?? null,
  );
  // Typed here and routed elsewhere: the line under the bubble says where.
  if (message.routedNote) return null;
  const fromCoordinator =
    senderThreadId !== undefined && senderThreadId === routing?.coordinatorThreadId;
  // The user's own words the coordinator passed back to the thread they were
  // typed in read as typed here: routing them home is not news.
  const returnedHome = fromCoordinator && message.createdBy === "user";
  if (
    !presentation.isAutomation &&
    senderThreadId &&
    !returnedHome &&
    (fromCoordinator || message.createdBy === "user")
  )
    // Routed through another thread: one quiet marker; who routed it and where it ran on hover.
    return (
      <p
        className="me-1 text-2xs text-muted-foreground"
        data-user-message-attribution={message.createdBy === "user" ? "routed" : "agent"}
        data-environment-id={environmentId}
      >
        <InlineButton
          onClick={() =>
            fromCoordinator ? routing!.openCoordinator() : onOpenThread(senderThreadId)
          }
          tone="muted"
          aria-label={message.createdBy === "user" ? "Open routing thread" : "Open sending thread"}
          title={`${message.createdBy === "user" ? "Your message, routed by" : "Sent by"} ${
            fromCoordinator ? "the coordinator" : "another thread"
          } · ${execution}`}
        >
          {message.createdBy === "user"
            ? "via another thread"
            : fromCoordinator
              ? "from coordinator"
              : "from another agent"}
        </InlineButton>
      </p>
    );
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
