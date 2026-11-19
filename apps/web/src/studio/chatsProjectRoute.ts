import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { findProjectGroup } from "../components/studio/ProjectWorkspace";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useServerConfigs } from "../state/entities";
import { chatsProjectRoute, type ChatsProjectRoute } from "./chatsProjectRoute.logic";

/** Whether `/projects/$projectKey` names a "No project" folder; the route then leaves for Overview. */
export function useChatsProjectRoute(projectKey: string): ChatsProjectRoute {
  const groups = useSettingsProjectGroups();
  const configs = useServerConfigs();
  return chatsProjectRoute({
    group: findProjectGroup(groups, projectKey),
    scratchRootFor: (environmentId) => {
      const config = configs.get(environmentId as EnvironmentId);
      return config === undefined ? undefined : (config.scratchWorkspaceRoot ?? null);
    },
  });
}
