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
import { ProjectThreadHeader } from "./shell/ProjectThreadHeader";
import { ProjectRoutedReplies } from "./ProjectRoutedReplies";

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
}) {
  const local = thread.environmentId === project.environmentId;
  return (
    <SelectedThreadShell value={thread}>
      <ProjectThreadHeader {...header} />
      <div className="project-route-note">
        Replies pass through the coordinator with this thread as context.
      </div>
      {coordinatorId && local ? (
        <ProjectRoutedReplies
          project={project}
          coordinatorId={coordinatorId}
          thread={thread}
          onOpenCoordinator={openCoordinator}
        />
      ) : null}
      <ProjectMessageRoutingContext
        value={{
          coordinatorThreadId: coordinatorId,
          openCoordinator,
          openThread,
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
            suspendShortcuts={suspendShortcuts}
            embeddedHeaderToolsTarget={toolsSlot}
            reserveTitleBarControlInset={false}
          />
        </div>
      </ProjectMessageRoutingContext>
    </SelectedThreadShell>
  );
}
