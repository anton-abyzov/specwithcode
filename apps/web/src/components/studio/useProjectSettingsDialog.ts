import { useCallback, useState } from "react";

import { useProjectSettingsRequest } from "../../studio/projectSettingsRequests";
import type { ProjectSettingsTab } from "./ProjectWorkspaceSettings";
import { isProjectSettingsTab } from "./projectSettingsSearch.logic";

/**
 * The project page's settings dialog: which tab is open, the row to land on,
 * and whether the name field takes focus. Follows settings requests sent to
 * this project from search or a double-click.
 */
export function useProjectSettingsDialog(projectKey: string) {
  const [tab, setTab] = useState<ProjectSettingsTab | null>(null);
  const [focusName, setFocusName] = useState(false);
  const [settingsRow, setSettingsRow] = useState<string | null>(null);
  const openSettingsAt = useCallback((next: ProjectSettingsTab, row: string | null) => {
    setFocusName(false);
    setSettingsRow(row);
    setTab(next);
  }, []);
  const closeSettings = useCallback(() => {
    setTab(null);
    setFocusName(false);
    setSettingsRow(null);
  }, []);
  useProjectSettingsRequest(
    projectKey,
    useCallback(
      (target) => {
        // A search result opens its tab and row; a bare request (double-click) renames.
        if (target && isProjectSettingsTab(target.tab))
          return openSettingsAt(target.tab, target.row ?? null);
        setFocusName(true);
        setTab("general");
      },
      [openSettingsAt],
    ),
  );
  return { tab, setTab, focusName, settingsRow, openSettingsAt, closeSettings };
}
