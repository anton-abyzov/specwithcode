/**
 * The header of a helper chat: a thread another machine's project thread
 * started in this machine's "No project" folder, because this machine has no
 * copy of that project. It is that project's work, so the header names the
 * project and opens the thread that asked for it, never "No project".
 */
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { FolderGit2Icon } from "lucide-react";
import { useMemo } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { useOpenThread } from "../../hooks/useOpenThread";
import { useProjects, useThreadShell } from "../../state/entities";
import { helperChatOrigin, helperParentKey } from "../../studio/standaloneChats";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

export interface HelperChatHeaderOrigin {
  readonly projectName: string;
  readonly fromMachine: string | undefined;
  readonly parentRef: ScopedThreadRef;
}

/** Where a helper chat came from, or undefined for any other thread. */
export function useHelperChatOrigin(
  chat: EnvironmentThreadShell | null | undefined,
): HelperChatHeaderOrigin | undefined {
  const key = chat ? helperParentKey(chat) : undefined;
  const parentRef = useMemo(() => {
    if (key === undefined) return null;
    const split = key.indexOf(":");
    return scopeThreadRef(key.slice(0, split) as never, key.slice(split + 1) as never);
  }, [key]);
  const parent = useThreadShell(parentRef);
  const projects = useProjects();
  const parentProject = parent
    ? projects.find(
        (project) =>
          project.environmentId === parent.environmentId && project.id === parent.projectId,
      )?.title
    : undefined;
  if (!chat || parentRef === null) return undefined;
  const helper = helperChatOrigin(chat, parentProject);
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
  const tooltip = helper.fromMachine
    ? renderRich(tx("A thread in {project} on {machine} asked for this. Open that thread."), {
        project: helper.projectName,
        machine: helper.fromMachine,
      })
    : renderRich(tx("A thread in {project} asked for this. Open that thread."), {
        project: helper.projectName,
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
                aria-label={`${helper.projectName}${helper.fromMachine ? ` on ${helper.fromMachine}` : ""}: open the thread that asked for this`}
                onClick={onOpen}
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
            <WorkspaceBreadcrumbText className="max-w-40">
              {helper.projectName}
            </WorkspaceBreadcrumbText>
            {helper.fromMachine ? (
              <WorkspaceBreadcrumbText className="max-w-24 text-muted-foreground/70">
                {renderRich(tx("· on {machine}"), { machine: helper.fromMachine })}
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
