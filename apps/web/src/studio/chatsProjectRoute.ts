import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { findProjectGroup } from "../components/studio/ProjectWorkspace";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useServerConfigs } from "../state/entities";
import { isChatsProjectRoute } from "./chatsProjectRoute.logic";

/** Whether `/projects/$projectKey` names a "No project" folder; the route then leaves for Overview. */
export function useChatsProjectRoute(projectKey: string): boolean {
  const groups = useSettingsProjectGroups();
  const configs = useServerConfigs();
  return isChatsProjectRoute({
    group: findProjectGroup(groups, projectKey),
    scratchRootFor: (environmentId) =>
      configs.get(environmentId as EnvironmentId)?.scratchWorkspaceRoot ?? null,
  });
}
