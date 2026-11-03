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
}) {
  const routedMessages = useRoutedThreadMessages(project, coordinatorId, thread);
  return (
    <SelectedThreadShell value={thread}>
      <ProjectThreadHeader {...header} />
      <ProjectMessageRoutingContext
        value={{
          coordinatorThreadId: coordinatorId,
          // A thread takes the user's message itself on its own machine, over this
          // client's connection there. The coordinator here may not reach it.
          direct: true,
          openCoordinator,
          openThread,
          routedMessages,
          // Nothing typed in a thread on another machine may reach the coordinator here.
          send: (text, attachments) =>
            thread.environmentId === project.environmentId
              ? send(text, thread.id, attachments)
              : Promise.reject(new Error("This thread takes its messages on its own machine.")),
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
