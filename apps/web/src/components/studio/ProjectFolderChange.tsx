import { useState, type ReactNode } from "react";
import {
  CircleCheckIcon,
  CircleXIcon,
  FolderGit2Icon,
  FolderInputIcon,
  FolderOpenIcon,
  InfoIcon,
  LoaderCircleIcon,
  ScanSearchIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { ProjectFolderCheck } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The home folder as "~", so the part that differs between projects stays readable. */
function displayFolder(path: string) {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

type Tone = "ok" | "warn" | "error" | "info";
const TONE_ICON = {
  ok: CircleCheckIcon,
  warn: TriangleAlertIcon,
  error: CircleXIcon,
  info: InfoIcon,
} as const;

function CheckLine({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <p
      className="project-check-line"
      data-tone={tone}
      role={tone === "error" ? "alert" : undefined}
    >
      <Icon size={15} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function repositoryLabel(repository: string | null) {
  return repository ?? "no Git remote";
}

const LAYOUT_LABEL = {
  single: "One Git repository",
  umbrella: "Umbrella workspace (repositories/<owner>/<repo>)",
  nested: "Folder with nested repositories",
  plain: "Plain folder, no Git repository found",
} as const;

/** One line on what the folder holds, for the check. Exported for tests. */
export function layoutSummary(layout: NonNullable<ProjectFolderCheck["layout"]>): string {
  const base = LAYOUT_LABEL[layout.kind];
  if (layout.repositoryCount === 0) return `${base}.`;
  const shown = layout.repositories.slice(0, 3).join(", ");
  const more = layout.repositoryCount > 3 ? ` and ${layout.repositoryCount - 3} more` : "";
  const partial = layout.truncated ? " The search stopped early; there may be more." : "";
  return `${base}${layout.rootIsRepository ? ", itself a checkout," : ""} with ${layout.repositoryCount} ${layout.repositoryCount === 1 ? "repository" : "repositories"}: ${shown}${more}.${partial}`;
}

/** The planning change the user must confirm, or null when plan cards read the same increments. */
export function planningSummary(check: Pick<ProjectFolderCheck, "planning" | "currentRoot">) {
  const planning = check.planning;
  if (planning === undefined || !planning.changes) return null;
  const before =
    planning.currentRoot === null
      ? "no SpecWeave increments"
      : `${plural(planning.currentIncrements, "increment")} in ${displayFolder(planning.currentRoot)}`;
  const after =
    planning.targetRoot === null
      ? "none"
      : `${plural(planning.targetIncrements, "increment")} in ${displayFolder(planning.targetRoot)}`;
  return {
    change: `Plan cards read ${before} now and would read ${after}.`,
    broken:
      planning.brokenLinks.length === 0
        ? null
        : `${plural(planning.brokenLinks.length, "linked increment")} would show "not found": ${planning.brokenLinks.slice(0, 5).join(", ")}${planning.brokenLinks.length > 5 ? ", …" : ""}.`,
    undo: `Nothing is deleted or rewritten. To go back, change the folder to ${displayFolder(check.currentRoot)} again.`,
  };
}

/**
 * Moves a project to another folder. The server checks the folder first: it must
 * exist, belong to no other project, and nothing may be running; a folder from a
 * different repository needs an explicit confirmation, and so does a folder
 * whose SpecWeave planning root differs (plan cards would read other
 * increments). The check also shows what the folder holds. Threads, worktree
 * bindings and memory move with the project; leaving a checkout of another
 * repository keeps its threads running there.
 */
export function ProjectFolderChange({
  project,
  disabled,
  onChanged,
}: {
  project: EnvironmentProject;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [folder, setFolder] = useState("");
  const [check, setCheck] = useState<ProjectFolderCheck | null>(null);
  const [confirmRepository, setConfirmRepository] = useState(false);
  const [confirmPlanning, setConfirmPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const runCheck = useAtomCommand(projectEnvironment.folderCheck);
  const changeFolder = useAtomCommand(projectEnvironment.changeFolder);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn);
  // Only the desktop app can open a native folder picker.
  const pickFolder =
    typeof window !== "undefined" && window.desktopBridge !== undefined
      ? readLocalApi()?.dialogs.pickFolder
      : undefined;
  const locked = disabled || busy;

  function failed(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function inspect(path = folder) {
    const workspaceRoot = path.trim();
    if (locked || workspaceRoot.length === 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await runCheck({
      environmentId: project.environmentId,
      input: { projectId: project.id, workspaceRoot },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setCheck(null);
      failed(result, "The folder could not be checked. Try again.");
      return;
    }
    setCheck(result.value);
    setConfirmRepository(false);
    setConfirmPlanning(false);
  }

  async function choose() {
    if (locked || !pickFolder) return;
    const picked = await pickFolder({ initialPath: project.workspaceRoot });
    if (!picked) return;
    setFolder(picked);
    await inspect(picked);
  }

  async function stopRuns() {
    if (locked || !check) return;
    setBusy(true);
    setError(null);
    const results = await Promise.all(
      check.activeThreads.map((thread) =>
        interrupt({ environmentId: project.environmentId, input: { threadId: thread.id } }),
      ),
    );
    setBusy(false);
    const failure = results.find((result) => result._tag === "Failure");
    if (failure) failed(failure, "Some work could not be stopped. Stop it from its thread.");
    await inspect(check.targetRoot);
  }

  async function apply() {
    if (locked || !check) return;
    const previousRoot = check.currentRoot;
    setBusy(true);
    setError(null);
    const result = await changeFolder({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        workspaceRoot: check.targetRoot,
        ...(check.sameRepository ? {} : { confirmDifferentRepository: confirmRepository }),
        ...(planning === null ? {} : { confirmPlanningImpact: confirmPlanning }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      failed(result, "The folder did not change. Check it again and retry.");
      return;
    }
    setDone(
      `The project now uses ${check.targetRoot}. Its threads run there from their next turn. To undo, change the folder back to ${previousRoot}.`,
    );
    setCheck(null);
    setFolder("");
    onChanged();
  }

  const planning = check === null ? null : planningSummary(check);
  const blocked =
    check === null ||
    (planning !== null && !confirmPlanning) ||
    check.unchanged ||
    !check.targetExists ||
    check.conflictingProject !== null ||
    check.activeThreads.length > 0 ||
    (!check.sameRepository && !confirmRepository);

  return (
    <section className="project-setting-row" aria-labelledby="project-folder-title">
      <div>
        <h3 id="project-folder-title">Project folder</h3>
        <p className="project-muted">
          Point this project at another folder, such as the repository root after it moved. Its
          threads, memory and history stay with the project.
        </p>
        <div className="project-folder-current" title={project.workspaceRoot}>
          <FolderGit2Icon size={15} aria-hidden="true" />
          <span>
            <bdi>{displayFolder(project.workspaceRoot)}</bdi>
          </span>
          <small>Current</small>
        </div>
        <div className="project-input-row">
          <input
            aria-label="New project folder"
            placeholder="New folder path, for example ~/Projects/my-repo"
            value={folder}
            disabled={locked}
            onChange={(e) => {
              setFolder(e.target.value);
              setCheck(null);
              setDone(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void inspect();
            }}
          />
          {pickFolder ? (
            <button
              type="button"
              className="project-control"
              disabled={locked}
              onClick={() => void choose()}
            >
              <FolderOpenIcon aria-hidden="true" />
              Choose…
            </button>
          ) : null}
          <button
            type="button"
            className="project-control"
            disabled={locked || folder.trim().length === 0}
            onClick={() => void inspect()}
          >
            {busy ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <ScanSearchIcon aria-hidden="true" />
            )}
            Check
          </button>
        </div>
        {error ? <CheckLine tone="error">{error}</CheckLine> : null}
        {done ? <CheckLine tone="ok">{done}</CheckLine> : null}
        {check ? (
          <div aria-label="Folder check">
            {check.unchanged ? (
              <CheckLine tone="info">The project already uses this folder.</CheckLine>
            ) : !check.targetExists ? (
              <CheckLine tone="error">
                {check.targetRoot} does not exist. Create or clone it first.
              </CheckLine>
            ) : check.conflictingProject ? (
              <CheckLine tone="error">
                {check.targetRoot} belongs to the project "{check.conflictingProject.title}" (
                {plural(check.conflictingProject.threadCount, "thread")}
                {check.conflictingProject.archived ? ", archived" : ""}). Point that project at
                another folder or delete it first.
              </CheckLine>
            ) : (
              <>
                <CheckLine tone={check.sameRepository ? "ok" : "warn"}>
                  {check.sameRepository
                    ? `Same repository: ${repositoryLabel(check.targetRepository)}.`
                    : `Different repository: the new folder has ${repositoryLabel(check.targetRepository)}, the current one ${repositoryLabel(check.currentRepository)}.`}{" "}
                  {check.keptInPlaceCount > 0
                    ? `${plural(check.threadCount, "thread")} stay in the project. ${plural(check.keptInPlaceCount, "thread")} keep running in ${check.currentRoot}, so their files and sessions do not change; new threads and the coordinator use the new folder`
                    : `${plural(check.threadCount, "thread")} move with the project`}
                  {check.reboundWorktreeCount > 0
                    ? `; ${plural(check.reboundWorktreeCount, "thread checkout")} inside the old folder will point at the same place in the new one`
                    : ""}
                  .
                </CheckLine>
                {!check.sameRepository ? (
                  <label className="project-checkbox">
                    <input
                      type="checkbox"
                      checked={confirmRepository}
                      disabled={locked}
                      onChange={(e) => setConfirmRepository(e.target.checked)}
                    />
                    This is the right folder for this project
                  </label>
                ) : null}
                {check.layout ? (
                  <CheckLine tone="info">
                    <span data-folder-layout={check.layout.kind}>
                      {layoutSummary(check.layout)}
                    </span>
                  </CheckLine>
                ) : null}
                {planning ? (
                  <>
                    <CheckLine tone="warn">
                      <span data-folder-planning="changes">
                        {planning.change} {planning.broken ?? ""} {planning.undo}
                      </span>
                    </CheckLine>
                    <label className="project-checkbox">
                      <input
                        type="checkbox"
                        checked={confirmPlanning}
                        disabled={locked}
                        onChange={(e) => setConfirmPlanning(e.target.checked)}
                      />
                      Plan cards should read the new folder's increments
                    </label>
                  </>
                ) : null}
                {check.activeThreads.length > 0 ? (
                  <div className="project-notice">
                    <p>
                      Stop the running work first:{" "}
                      {check.activeThreads.map((thread) => `"${thread.title}"`).join(", ")}.
                    </p>
                    <button
                      type="button"
                      className="project-control"
                      disabled={locked}
                      onClick={() => void stopRuns()}
                    >
                      <SquareIcon aria-hidden="true" />
                      Stop {plural(check.activeThreads.length, "run")}
                    </button>
                  </div>
                ) : null}
                {check.specweaveWorkspace ? (
                  <CheckLine tone="info">
                    This folder has a SpecWeave workspace. After the move, use Import SpecWeave
                    workspace under Environment to bring in its plan.
                  </CheckLine>
                ) : null}
              </>
            )}
            {!check.unchanged ? (
              <div className="project-actions">
                <button
                  type="button"
                  className="project-control project-control-strong"
                  disabled={locked || blocked}
                  onClick={() => void apply()}
                >
                  <FolderInputIcon aria-hidden="true" />
                  Change folder
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
