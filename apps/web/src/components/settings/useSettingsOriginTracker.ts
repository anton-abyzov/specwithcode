import { useLocation, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import {
  rememberSettingsOriginProject,
  resolveSettingsOriginProjectKey,
} from "./settingsEntryScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

/** Records the current page's project so Settings opens scoped to it. */
export function useSettingsOriginTracker(): void {
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeProjectKey = useParams({
    strict: false,
    select: (params) => params.projectKey ?? null,
  });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const thread = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const groups = useSettingsProjectGroups();
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const source = thread ?? draft;
  const environmentId = source?.environmentId ?? null;
  const projectId = source?.projectId ?? null;
  useEffect(() => {
    if (onSettings) return;
    rememberSettingsOriginProject(
      resolveSettingsOriginProjectKey({
        routeProjectKey,
        projectRef:
          environmentId === null || projectId === null ? null : { environmentId, projectId },
        groups,
      }),
    );
  }, [environmentId, groups, onSettings, projectId, routeProjectKey]);
}
