import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@specweave-studio/contracts";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { getProjectOrderKey } from "../logicalProject";
import { visibleWithAide } from "../studio/personalAssistant";
import { legacyProjectCwdPreferenceKey } from "../uiStateStore";

type OrderableProject = Parameters<typeof getProjectOrderKey>[0] & {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly kind?: string | undefined;
  readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
};

/**
 * Where New thread lands with no chat or project in context (Cmd+N, the
 * palette on Overview): the first project in sidebar order. A hidden personal
 * assistant (Settings → General) is skipped, so a new chat never opens in it.
 */
export function defaultNewThreadProjectRef<T extends OrderableProject>(input: {
  readonly projects: readonly T[];
  readonly projectOrder: readonly string[];
  readonly aideEnabled: boolean;
}): ScopedProjectRef | null {
  const ordered = orderItemsByPreferredIds({
    items: visibleWithAide(input.projects, input.aideEnabled),
    preferredIds: input.projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const first = ordered[0];
  return first ? scopeProjectRef(first.environmentId, first.id) : null;
}
