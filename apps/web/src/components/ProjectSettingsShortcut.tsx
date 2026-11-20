import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveShortcutCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useProjects, useServerConfigs } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { openProjectSettings } from "../studio/projectSettingsRequests";
import { requestChatSettings } from "../studio/chatSettingsRequest";
import { findLogicalProjectKey } from "./chat/TimelineDetailMenu";
import { useSettingsProjectGroups } from "./settings/useSettingsProjectGroups";

/**
 * Opens Project settings for the project in view: the project page's, else the
 * active thread or draft's. It opens over the page and never navigates, so the
 * open thread stays where it was. In a chat without a project it opens the chat's own
 * settings instead; elsewhere without a project it does nothing.
 */
export function ProjectSettingsShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeProjectKey = useParams({
    strict: false,
    select: (params) => params.projectKey ?? null,
  });
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projectGroups = useSettingsProjectGroups();
  const threadProject = activeThread ?? activeDraftThread;
  const projects = useProjects();
  const configs = useServerConfigs();
  const chatProject =
    routeProjectKey === null && threadProject
      ? projects.find(
          (project) =>
            project.environmentId === threadProject.environmentId &&
            project.id === threadProject.projectId,
        )
      : undefined;
  const isChat =
    chatProject !== undefined &&
    isScratchProject(chatProject, configs.get(chatProject.environmentId)?.scratchWorkspaceRoot);
  // Plain values, so the listener below is replaced only when they change.
  const chatEnvironmentId = isChat ? chatProject.environmentId : null;
  const chatThreadId = isChat && activeThread ? activeThread.id : null;
  const projectKey =
    routeProjectKey ??
    (threadProject
      ? findLogicalProjectKey(projectGroups, {
          environmentId: threadProject.environmentId,
          projectId: threadProject.projectId,
        })
      : null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command !== "projectSettings.open" || (projectKey === null && chatEnvironmentId === null))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (chatEnvironmentId !== null)
        requestChatSettings({
          environmentId: chatEnvironmentId,
          threadRef: chatThreadId === null ? null : scopeThreadRef(chatEnvironmentId, chatThreadId),
        });
      else if (projectKey !== null)
        openProjectSettings(routeProjectKey, projectKey, { tab: "general" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chatEnvironmentId, chatThreadId, keybindings, projectKey, routeProjectKey]);

  return null;
}
