/**
 * Once a project is added, says which workspace suits its folder: the current
 * checkout for an umbrella or several service clones, worktrees for one Git
 * repository. It reads the project's own folder check and changes no setting.
 *
 * @module workspaceGuidanceToast
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { workspaceGuidance } from "../lib/folderLayoutGuidance";
import { toastManager } from "../components/ui/toast";
import { stackedThreadToast } from "../components/ui/toastHelpers";
import { readProjectFolderCheck, type RunProjectFolderCheck } from "./useProjectFolderHealth";

export async function announceWorkspaceGuidance(
  runCheck: RunProjectFolderCheck,
  project: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">,
): Promise<void> {
  const check = await readProjectFolderCheck(runCheck, project);
  const guidance = check?.layout ? workspaceGuidance(check.layout) : null;
  if (guidance === null) return;
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: guidance.title,
      description:
        guidance.recommended === "local"
          ? `${guidance.detail} Keep Project settings > Use worktrees off.`
          : `${guidance.detail} Turn on Project settings > Use worktrees to give every thread, including the coordinator's, its own worktree.`,
    }),
  );
}
