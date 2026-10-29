/**
 * Whether a registered project's folder is still there on its machine. The
 * project page reads it once per project and again after its machine
 * reconnects, at most once per {@link RECHECK_AFTER_MS}, so a folder moved or
 * deleted outside the app is named instead of every thread failing on its own.
 *
 * The same check says what the folder holds (its layout), which the new-thread
 * workspace default and the workspace guidance read from this one cache.
 *
 * @module useProjectFolderHealth
 */
import { useEffect, useState } from "react";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ProjectFolderCheck, ProjectId } from "@specweave-studio/contracts";

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
  { readonly at: number; readonly check: Promise<ProjectFolderCheck | null> }
>();

export function resetProjectFolderChecksForTests(): void {
  checks.clear();
}

export type RunProjectFolderCheck = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly projectId: ProjectId; readonly workspaceRoot: string };
}) => Promise<AtomCommandResult<ProjectFolderCheck, unknown>>;

type CheckedProject = Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">;

/**
 * The project's own folder check: the cached one when it is younger than
 * {@link RECHECK_AFTER_MS}, otherwise a new one. Null when the check failed;
 * a failed check is tried again on the next read.
 */
export function readProjectFolderCheck(
  runCheck: RunProjectFolderCheck,
  project: CheckedProject,
): Promise<ProjectFolderCheck | null> {
  const { environmentId, id: projectId, workspaceRoot } = project;
  const key = `${environmentId}\n${projectId}\n${workspaceRoot}`;
  const now = Date.now();
  const recent = checks.get(key);
  if (recent !== undefined && now - recent.at < RECHECK_AFTER_MS) return recent.check;
  const entry = {
    at: now,
    check: runCheck({ environmentId, input: { projectId, workspaceRoot } }).then(
      (outcome) => (outcome._tag === "Success" ? outcome.value : null),
      () => null,
    ),
  };
  checks.set(key, entry);
  void entry.check.then((settled) => {
    if (settled === null && checks.get(key) === entry) checks.delete(key);
  });
  return entry.check;
}

/** The folder check command, quiet: a failed check is never shown, so it raises no toast either. */
export function useProjectFolderCheckCommand(): RunProjectFolderCheck {
  return useAtomCommand(projectEnvironment.folderCheck, {
    reportFailure: false,
    reportDefect: false,
  }) as RunProjectFolderCheck;
}

/** The project's folder check, read once per project and again after its machine reconnects. */
export function useProjectFolderCheck(project: CheckedProject | null): ProjectFolderCheck | null {
  const runCheck = useProjectFolderCheckCommand();
  const environmentId = project?.environmentId ?? null;
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const projectId = project?.id ?? null;
  const workspaceRoot = project?.workspaceRoot ?? "";
  const key = `${environmentId}\n${projectId}\n${workspaceRoot}`;
  const [result, setResult] = useState<{
    readonly key: string;
    readonly check: ProjectFolderCheck | null;
  } | null>(null);
  // One check per project and folder, and one more when the machine reconnects
  // once the last check is older than RECHECK_AFTER_MS.
  useEffect(() => {
    if (!connected || environmentId === null || projectId === null) return;
    if (workspaceRoot.trim() === "") return;
    let live = true;
    void readProjectFolderCheck(runCheck, { environmentId, id: projectId, workspaceRoot }).then(
      (check) => {
        if (live) setResult({ key, check });
      },
    );
    return () => {
      live = false;
    };
  }, [connected, environmentId, key, projectId, runCheck, workspaceRoot]);
  return result?.key === key ? result.check : null;
}

export function useProjectFolderHealth(project: CheckedProject): ProjectFolderHealth {
  const check = useProjectFolderCheck(project);
  return check === null ? "unknown" : projectFolderHealth(check);
}
