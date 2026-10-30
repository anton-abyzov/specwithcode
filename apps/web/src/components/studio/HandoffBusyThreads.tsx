import type { EnvironmentId, MachineHandoffBusyReason } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { Badge } from "../ui/badge";
import type { TransferBusy } from "./handoffCopySteps";
import { useProjectMoveDialog } from "./ProjectMoveOptions";

export const BUSY_REASON_LABEL: Readonly<Record<MachineHandoffBusyReason, string>> = {
  running: "Running work",
  waiting_for_answer: "Waiting for your answer",
  waiting_for_sign_in: "Waiting for you to sign in",
  pending_approval: "Waiting for your approval",
  provider_session: "Agent session running",
  pending_effect: "Step still pending",
};

const WAITS_FOR_PERSON: ReadonlySet<MachineHandoffBusyReason> = new Set([
  "waiting_for_answer",
  "waiting_for_sign_in",
  "pending_approval",
]);

/**
 * The threads that keep a move from going ahead, each opening that thread so the person
 * can answer it or stop it. The list is the first ones the machine named; the rest are counted.
 */
export function HandoffBusyThreads({
  busy,
  environmentId,
  machineLabel,
  projectTitle,
}: {
  readonly busy: TransferBusy["busy"];
  /** The machine whose threads these are: where each link opens. */
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  /** The project being moved; a thread of another project on the same folder says its own. */
  readonly projectTitle: string;
}) {
  const dialog = useProjectMoveDialog();
  const more = busy.total - busy.threads.length;
  return (
    <div className="space-y-1 text-xs" data-slot="handoff-busy-threads">
      <ul aria-label={`Threads keeping ${machineLabel} busy`} className="space-y-0.5 pl-1">
        {busy.threads.map((thread) => (
          <li
            key={thread.threadId}
            className="flex items-baseline gap-2"
            data-slot="handoff-busy-thread"
            data-reason={thread.reason}
          >
            <Badge size="sm" variant={WAITS_FOR_PERSON.has(thread.reason) ? "warning" : "outline"}>
              {BUSY_REASON_LABEL[thread.reason]}
            </Badge>
            <Link
              className="studio-text-link min-w-0 wrap-anywhere"
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: thread.threadId }}
              onClick={() => dialog?.close?.()}
            >
              {thread.title}
            </Link>
            {thread.projectTitle && thread.projectTitle !== projectTitle && (
              <span className="shrink-0 text-muted-foreground">{thread.projectTitle}</span>
            )}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="pl-1 text-muted-foreground">
          And {more.toLocaleString()} more {more === 1 ? "thread" : "threads"} on {machineLabel}.
        </p>
      )}
    </div>
  );
}
