import type { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { readThreadShell } from "../state/entities";
import { chatNavigationTarget } from "../studio/projectPaneThreads";

export interface OpenChatTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Looked up from the loaded threads when the caller does not have it. */
  readonly projectId?: ProjectId;
}

/**
 * Opens a chat from outside any chat view (a notification, a shortcut): a thread
 * of a project workspace opens in that project's right panel, any other full page.
 * The callback keeps one identity, so effects that hold it do not re-run.
 */
export function useOpenChat() {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();
  const groupsRef = useRef(groups);
  useLayoutEffect(() => {
    groupsRef.current = groups;
  });
  return useCallback(
    (target: OpenChatTarget) => {
      const projectId =
        target.projectId ??
        readThreadShell({ environmentId: target.environmentId, threadId: target.threadId })
          ?.projectId ??
        null;
      const group =
        projectId === null
          ? undefined
          : groupsRef.current.find((candidate) =>
              candidate.memberProjects.some(
                (member) =>
                  member.environmentId === target.environmentId && member.id === projectId,
              ),
            );
      const next = chatNavigationTarget(
        {
          id: target.threadId,
          environmentId: target.environmentId,
          projectId: projectId ?? ("" as ProjectId),
        },
        group,
      );
      return next.to === "/projects/$projectKey"
        ? navigate({ to: next.to, params: { ...next.params }, search: { ...next.search } })
        : navigate({ to: next.to, params: { ...next.params } });
    },
    [navigate],
  );
}
