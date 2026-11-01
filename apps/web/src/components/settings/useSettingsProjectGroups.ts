import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useMachineNicknames } from "../../studio/machineNickname";

/**
 * Settings uses the same logical projects as the sidebar, sorted by display name.
 * Each member names its machine by the short name the person gave it ("M4"), so
 * every list built from these groups names machines the same way.
 */
export function useSettingsProjectGroups() {
  const projects = useProjects();
  const nickname = useMachineNicknames();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    return buildSidebarProjectSnapshots({
      projects,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => {
        const label = labels.get(id);
        return label === undefined ? null : nickname(id, label);
      },
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, nickname, primaryEnvironmentId, projects, settings]);
}
