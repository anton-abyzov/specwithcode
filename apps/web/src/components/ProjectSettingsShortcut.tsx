import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveShortcutCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../state/server";
import { openProjectSettings } from "../studio/projectSettingsRequests";
import { findLogicalProjectKey } from "./chat/TimelineDetailMenu";
import { useSettingsProjectGroups } from "./settings/useSettingsProjectGroups";

/**
 * Opens Project settings for the project in view: the project page's, else the
 * active thread or draft's. It opens over the page and never navigates, so the
 * open thread stays where it was. Without a project the shortcut does nothing.
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
      if (command !== "projectSettings.open" || projectKey === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      openProjectSettings(routeProjectKey, projectKey, { tab: "general" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, projectKey, routeProjectKey]);

  return null;
}
