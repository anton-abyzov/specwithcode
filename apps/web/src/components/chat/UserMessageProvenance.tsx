import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import type { HandoffTimelineRun } from "@specweave-studio/client-runtime/handoff";
import { resolveUserMessagePresentation } from "@specweave-studio/client-runtime/user-message";
import { useEnvironment } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { useMachineNickname } from "../../studio/machineNickname";
import { requestExecutionLabel } from "../../studio/projectDomain";
import { useProjectMessageRouting } from "../../studio/projectMessageRouting";
import type { ChatMessage } from "../../types";
import { ScheduledTaskLink } from "../settings/ScheduledTaskLink";
import { InlineButton } from "../ui/button";
import { useProviderEntries } from "../studio/shell/ModelBadge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface UserMessageProvenanceProps {
  readonly message: ChatMessage;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly environmentId: EnvironmentId;
  readonly threadRef?: ScopedThreadRef | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

function useUserMessageProvenance({
  message,
  runs,
  environmentId,
  threadRef,
}: UserMessageProvenanceProps) {
  const routing = useProjectMessageRouting();
  const environment = useEnvironment(environmentId);
  const providers = useProviderEntries(environmentId);
  const presentation = resolveUserMessagePresentation(message);
  const senderThreadId = message.senderThreadId;
  // The transcript is bound to its execution environment. Its run, not today's
  // composer selection, owns the historical provider/model attribution.
  // A subagent's task arrives outside any run; it ran on the subagent thread's own model.
  const thread = useThreadShell(threadRef ?? null);
  const machine = useMachineNickname(environmentId, environment?.label);
  const execution = requestExecutionLabel(
    message,
    runs,
    machine,
    providers,
    thread?.modelSelection ?? null,
  );
  const fromCoordinator =
    senderThreadId !== undefined && senderThreadId === routing?.coordinatorThreadId;
  // The user's own words the coordinator passed back to the thread they were
  // typed in read as typed here: routing them home is not news.
  const returnedHome = fromCoordinator && message.createdBy === "user";
  // Typed here and routed elsewhere: the line under the bubble says where.
  // Routed through another thread: one quiet marker carries where it ran on hover.
  const layout = message.routedNote
    ? "none"
    : !presentation.isAutomation &&
        senderThreadId &&
        !returnedHome &&
        (fromCoordinator || message.createdBy === "user")
      ? "routed"
      : "standard";
  return { routing, presentation, senderThreadId, execution, fromCoordinator, layout } as const;
}

/**
 * Where a request ran (machine · provider · model). It sits in the hover row
 * under the bubble beside the timestamp, so it costs no line of its own.
 */
export function UserMessageExecutionOrigin(props: UserMessageProvenanceProps) {
  const { execution, layout } = useUserMessageProvenance(props);
  if (layout !== "standard") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<p />}
        className="min-w-0 truncate text-2xs text-muted-foreground"
        data-request-execution-origin="true"
        data-environment-id={props.environmentId}
        data-run-id={props.message.runId ?? undefined}
        aria-label={`${execution}. Execution environment: ${props.environmentId}`}
      >
        {execution}
      </TooltipTrigger>
      <TooltipPopup>Execution environment: {props.environmentId}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Who sent a request when it was not the user typing here: another agent, the
 * coordinator, automation or another thread. One quiet line above the bubble,
 * none for the user's own messages.
 */
export function UserMessageProvenance(props: UserMessageProvenanceProps) {
  const { message, environmentId, onOpenThread } = props;
  const { routing, presentation, senderThreadId, execution, fromCoordinator, layout } =
    useUserMessageProvenance(props);
  if (layout === "none") return null;
  if (layout === "routed" && senderThreadId)
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
  return presentation.isAutomation ? (
    <p className="me-1 text-2xs text-muted-foreground" data-user-message-attribution="automation">
      {presentation.scheduledTaskId ? (
        <ScheduledTaskLink
          environmentId={environmentId}
          taskId={presentation.scheduledTaskId}
          className="rounded-sm hover:text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Sent by routine
        </ScheduledTaskLink>
      ) : (
        "Sent by routine"
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
  ) : null;
}
