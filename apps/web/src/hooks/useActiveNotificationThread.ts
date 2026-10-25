import { useParams, useSearch } from "@tanstack/react-router";
import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { parseProjectWorkspaceSearch } from "../studio/projectPaneThreads";

/** Only a known, scoped destination can suppress an alert for the visible chat. */
export function useActiveNotificationThread() {
  const route = useParams({ strict: false });
  const search = useSearch({
    strict: false,
    select: (value) => parseProjectWorkspaceSearch(value as Record<string, unknown>),
  });
  const groups = useSettingsProjectGroups();
  if (route.environmentId && route.threadId)
    return { environmentId: route.environmentId, threadId: route.threadId };
  if (!route.projectKey || !search?.thread) return null;
  const group = groups.find((candidate) => candidate.projectKey === route.projectKey);
  const member = search.checkout
    ? group?.memberProjects.find(
        (candidate) => `${candidate.environmentId}:${candidate.id}` === search.checkout,
      )
    : undefined;
  const environmentId = search.threadEnvironment ?? member?.environmentId;
  // Do not guess from the notifying environment or a thread ID shared by machines.
  return environmentId ? { environmentId, threadId: search.thread } : null;
}
