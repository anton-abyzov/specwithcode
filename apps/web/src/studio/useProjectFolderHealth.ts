/**
 * Whether a registered project's folder is still there on its machine. The
 * project page reads it once per project and again after its machine
 * reconnects, at most once per {@link RECHECK_AFTER_MS}, so a folder moved or
 * deleted outside the app is named instead of every thread failing on its own.
 *
 * @module useProjectFolderHealth
 */
import { useEffect, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { ProjectFolderCheck } from "@specweave-studio/contracts";

import { useEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * unknown: not checked yet, or the check failed. missing: no folder at the
 * project's path. file: a file sits at the project's path.
 *
 * A folder without a repository of its own is not reported: a project may be
 * a subfolder of a repository, or a plain folder on purpose.
 */
export type ProjectFolderHealth = "unknown" | "ok" | "missing" | "file";

/** The health a folder check of the project's own folder reports. */
export function projectFolderHealth(check: ProjectFolderCheck): ProjectFolderHealth {
  if (check.refusal?.reason === "folder_not_directory") return "file";
  if (check.targetExists === false) return "missing";
  return "ok";
}

/**
 * A machine that drops and reconnects again and again checks each folder once
 * in this window. Each check runs git and walks the folder on that machine.
 */
export const RECHECK_AFTER_MS = 2 * 60_000;

/** The latest check per project and folder, shared by every page showing it. */
const checks = new Map<
  string,
  { readonly at: number; readonly health: Promise<ProjectFolderHealth> }
>();

export function resetProjectFolderChecksForTests(): void {
  checks.clear();
}

export function useProjectFolderHealth(
  project: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">,
): ProjectFolderHealth {
  // A failed check is never shown, so it raises no toast either.
  const runCheck = useAtomCommand(projectEnvironment.folderCheck, {
    reportFailure: false,
    reportDefect: false,
  });
  const connected = useEnvironment(project.environmentId)?.connection.phase === "connected";
  const { environmentId, id: projectId, workspaceRoot } = project;
  const key = `${environmentId}\n${projectId}\n${workspaceRoot}`;
  const [result, setResult] = useState<{
    readonly key: string;
    readonly health: ProjectFolderHealth;
  } | null>(null);
  // One check per project and folder, and one more when the machine reconnects
  // once the last check is older than RECHECK_AFTER_MS.
  useEffect(() => {
    if (!connected || workspaceRoot.trim() === "") return;
    let live = true;
    const now = Date.now();
    const recent = checks.get(key);
    let health = recent !== undefined && now - recent.at < RECHECK_AFTER_MS ? recent.health : null;
    if (health === null) {
      const entry = {
        at: now,
        health: runCheck({ environmentId, input: { projectId, workspaceRoot } }).then(
          (outcome): ProjectFolderHealth =>
            outcome._tag === "Success" ? projectFolderHealth(outcome.value) : "unknown",
          (): ProjectFolderHealth => "unknown",
        ),
      };
      checks.set(key, entry);
      health = entry.health;
      // A failed check is tried again on the next reconnect.
      void entry.health.then((settled) => {
        if (settled === "unknown" && checks.get(key) === entry) checks.delete(key);
      });
    }
    void health.then((settled) => {
      if (live) setResult({ key, health: settled });
    });
    return () => {
      live = false;
    };
  }, [connected, environmentId, key, projectId, runCheck, workspaceRoot]);
  return result?.key === key ? result.health : "unknown";
}
