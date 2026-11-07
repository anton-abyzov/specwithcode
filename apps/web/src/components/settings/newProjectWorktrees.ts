import type { EnvironmentId, ServerSettings } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

interface WorktreesEnvironment {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

/** Which listed code projects have their own Use worktrees switch on. */
export interface ProjectWorktreesSummary {
  /** Names of the projects with it on, in list order. */
  readonly on: readonly string[];
  readonly total: number;
}

/**
 * A project has Use worktrees on when any of its checkouts turned the switch on
 * for itself, as a thread launch reads it. Projects without a known checkout
 * setting count as off; the personal assistant and archived projects are left out.
 */
export function projectWorktreesSummary(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "displayName" | "memberProjects">>,
  environments: ReadonlyArray<WorktreesEnvironment>,
): ProjectWorktreesSummary {
  const settingsOf = new Map(
    environments.flatMap((environment) =>
      environment.serverConfig
        ? [[environment.environmentId, environment.serverConfig.settings] as const]
        : [],
    ),
  );
  const listed = groups.filter((group) =>
    group.memberProjects.some(
      (member) =>
        member.workspaceSettings?.kind !== "personal" && !member.workspaceSettings?.archived,
    ),
  );
  const on = listed
    .filter((group) =>
      group.memberProjects.some((member) => {
        const settings = settingsOf.get(member.environmentId);
        if (!settings) return false;
        const resolved = resolveProjectSettings(settings, member.id, member);
        return (
          resolved.sources.defaultThreadEnvMode === "project" &&
          resolved.settings.defaultThreadEnvMode === "worktree"
        );
      }),
    )
    .map((group) => group.displayName);
  return { on, total: listed.length };
}

/** Whether the listed projects agree; null when there are none. */
export function projectWorktreesAgreement(
  summary: ProjectWorktreesSummary,
): "all-off" | "all-on" | "differ" | null {
  if (summary.total === 0) return null;
  if (summary.on.length === 0) return "all-off";
  return summary.on.length === summary.total ? "all-on" : "differ";
}
