import { SelectedThreadShell } from "../../state/selectedThreadShell";
import type { ComponentProps } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import type { ChatAttachment, ThreadId } from "@specweave-studio/contracts";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../../studio/projectMessageRouting";
import ChatView from "../ChatView";
import type { SubagentEntry } from "../../studio/threadSubagents";
import { ProjectThreadHeader } from "./shell/ProjectThreadHeader";
import { SubagentPeek } from "./shell/SubagentPeek";
import { useRoutedThreadMessages } from "./ProjectRoutedReplies";

export function ProjectWorkerPane({
  project,
  thread,
  coordinatorId,
  header,
  openCoordinator,
  openThread,
  send,
  suspendShortcuts,
  toolsSlot,
  peek = null,
  coordinatorBlocked = false,
}: {
  project: EnvironmentProject;
  thread: EnvironmentThreadShell;
  coordinatorId: ThreadId | null;
  header: ComponentProps<typeof ProjectThreadHeader>;
  openCoordinator: () => void;
  openThread: ProjectMessageRouting["openThread"];
  send: (
    text: string,
    sourceThreadId?: ThreadId,
    attachments?: readonly ChatAttachment[],
  ) => Promise<void>;
  suspendShortcuts: boolean;
  toolsSlot: HTMLSpanElement | null;
  /** A subagent of this thread whose transcript slides over it, read-only. */
  peek?: {
    readonly thread: EnvironmentThreadShell;
    readonly entry: SubagentEntry | null;
    readonly onClose: () => void;
  } | null;
  /** The viewed copy runs workers only, so its coordinator refuses every relay. */
  coordinatorBlocked?: boolean;
}) {
  const local = thread.environmentId === project.environmentId;
  // A thread on another machine is answered there when this copy's coordinator
  // would refuse the relay, instead of failing every reply.
  const direct = local || coordinatorBlocked;
  const routedMessages = useRoutedThreadMessages(project, local ? coordinatorId : null, thread);
  return (
    <SelectedThreadShell value={thread}>
      <ProjectThreadHeader {...header} />
      <ProjectMessageRoutingContext
        value={{
          coordinatorThreadId: coordinatorId,
          // A worker here takes the user's message itself; only a thread on
          // another machine still goes through the coordinator, when it can.
          direct,
          openCoordinator,
          openThread,
          routedMessages,
          send: (text, attachments) => {
            if (local) return send(text, thread.id, attachments);
            if (attachments?.length)
              return Promise.reject(
                new Error(
                  "Attach files in the coordinator composer when replying across machines.",
                ),
              );
            return send(
              `Regarding thread ${thread.id} on machine ${thread.environmentId} (${thread.title}):\n\n${text}`,
            );
          },
        }}
      >
        <div className="project-native-thread">
          <ChatView
            key={`${thread.environmentId}:${thread.id}`}
            environmentId={thread.environmentId}
            threadId={thread.id}
            routeKind="server"
            layoutMode="embedded"
            suspendShortcuts={suspendShortcuts || peek !== null}
            embeddedHeaderToolsTarget={toolsSlot}
            reserveTitleBarControlInset={false}
          />
          {peek ? (
            <SubagentPeek
              thread={peek.thread}
              entry={peek.entry}
              parentTitle={thread.title || "this thread"}
              onClose={peek.onClose}
            />
          ) : null}
        </div>
      </ProjectMessageRoutingContext>
    </SelectedThreadShell>
  );
}
