/**
 * The header of a helper chat: a thread another machine's project thread
 * started in this machine's "No project" folder, because this machine has no
 * copy of that project. It is that project's work, so the header names the
 * project (or at least the machine that asked) and opens the thread that asked
 * for it, never "No project".
 */
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { FolderGit2Icon } from "lucide-react";
import { useMemo } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { useOpenThread } from "../../hooks/useOpenThread";
import { useProjects, useServerConfigs, useThreadShell } from "../../state/entities";
import { isScratchMember } from "../../studio/projectListVisibility";
import {
  helperChatOrigin,
  helperParentRef,
  type HelperRequester,
} from "../../studio/standaloneChats";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

export interface HelperChatHeaderOrigin {
  readonly projectName: string | undefined;
  readonly fromMachine: string | undefined;
  readonly parentRef: ScopedThreadRef;
}

/** Where a helper chat came from, or undefined for any other thread. */
export function useHelperChatOrigin(
  chat: EnvironmentThreadShell | null | undefined,
): HelperChatHeaderOrigin | undefined {
  const ref = chat ? helperParentRef(chat) : undefined;
  const parentRef = useMemo(
    () =>
      ref === undefined
        ? null
        : scopeThreadRef(ref.environmentId as EnvironmentId, ref.threadId as ThreadId),
    [ref?.environmentId, ref?.threadId],
  );
  const parent = useThreadShell(parentRef);
  const projects = useProjects();
  const configs = useServerConfigs();
  if (!chat || parentRef === null) return undefined;
  const parentProject = parent
    ? projects.find(
        (project) =>
          project.environmentId === parent.environmentId && project.id === parent.projectId,
      )
    : undefined;
  // A chat another person's chat started is a chat too: the header stays as it is.
  const requester: HelperRequester =
    parentProject === undefined
      ? { kind: "unknown" }
      : isScratchMember(
            parentProject,
            (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
          )
        ? { kind: "chat" }
        : { kind: "project", name: parentProject.title };
  const helper = helperChatOrigin(chat, requester);
  return helper === undefined ? undefined : { ...helper, parentRef };
}

export function HelperChatBreadcrumb({ helper }: { helper: HelperChatHeaderOrigin }) {
  const { openThread } = useOpenThread();
  return (
    <HelperChatBreadcrumbView helper={helper} onOpen={() => void openThread(helper.parentRef)} />
  );
}

export function HelperChatBreadcrumbView({
  helper,
  onOpen,
}: {
  helper: Pick<HelperChatHeaderOrigin, "projectName" | "fromMachine">;
  onOpen: () => void;
}) {
  const tx = useTx();
  const { projectName, fromMachine } = helper;
  const machine = fromMachine ?? "";
  const label = projectName ?? tx("From {machine}", { machine });
  const ariaLabel = projectName
    ? fromMachine
      ? tx("{project} on {machine}: open the thread that asked for this", {
          project: projectName,
          machine,
        })
      : tx("{project}: open the thread that asked for this", { project: projectName })
    : tx("{machine}: open the thread that asked for this", { machine });
  const tooltip = projectName
    ? fromMachine
      ? renderRich(tx("A thread in {project} on {machine} asked for this. Open that thread."), {
          project: projectName,
          machine: fromMachine,
        })
      : renderRich(tx("A thread in {project} asked for this. Open that thread."), {
          project: projectName,
        })
    : renderRich(tx("A thread on {machine} asked for this. Open that thread."), {
        machine: fromMachine ?? "",
      });
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-helper-chat-origin
                aria-label={ariaLabel}
                onClick={onOpen}
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
            <WorkspaceBreadcrumbText className="max-w-40">{label}</WorkspaceBreadcrumbText>
            {projectName && fromMachine ? (
              <WorkspaceBreadcrumbText className="max-w-24 text-muted-foreground/70">
                {renderRich(tx("· on {machine}"), { machine: fromMachine })}
              </WorkspaceBreadcrumbText>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">{tooltip}</TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
