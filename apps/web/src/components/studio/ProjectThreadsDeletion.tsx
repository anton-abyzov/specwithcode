import { useCallback, useEffect, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { CommandId } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";

import { refreshArchivedThreadsForEnvironment } from "../../lib/archivedThreadsState";
import { randomUUID } from "../../lib/utils";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useProjectDeletionWorktrees } from "./ProjectDeletionWorktrees";

export function threadCountLabel(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/**
 * The danger zone's "Delete all threads": every thread but the coordinator goes,
 * with the worktrees the person ticks. Project memory, plan, routines and the
 * project folder stay, so threads made by an older version can be started anew.
 * Rendered inside the danger zone section, whose styles apply to its children.
 */
export function ProjectThreadsDeletion({
  project,
  disabled,
}: {
  project: EnvironmentProject;
  disabled: boolean;
}) {
  const deleteThreads = useAtomCommand(projectEnvironment.threadsDelete, { reportFailure: false });
  const worktrees = useProjectDeletionWorktrees({
    failureTitle: "The threads were deleted, but their worktrees were kept",
    threadsOnly: true,
  });
  // The server's own list, so the count matches what it deletes: null while unknown.
  const [threadCount, setThreadCount] = useState<number | null>(null);
  const countThreads = useCallback(async () => {
    const result = await deleteThreads({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        commandId: CommandId.make(`count-threads:${randomUUID()}`),
        confirmationTitle: "",
        dryRun: true,
      },
    });
    setThreadCount(result._tag === "Success" ? result.value.deletedThreadIds.length : null);
  }, [deleteThreads, project.environmentId, project.id]);
  useEffect(() => {
    void countThreads();
  }, [countThreads]);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = { environmentId: project.environmentId, projectId: project.id };
  // Reading worktree sizes walks their folders, so wait until deletion starts.
  const typeConfirmation = (value: string) => {
    if ((confirmation === "") !== (value === "")) {
      if (value === "") worktrees.reset();
      else void worktrees.load(target);
    }
    setConfirmation(value);
  };
  async function run() {
    if (disabled || busy || confirmation !== project.title) return;
    setBusy(true);
    setError(null);
    const result = await deleteThreads({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        commandId: CommandId.make(`delete-threads:${randomUUID()}`),
        confirmationTitle: confirmation,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The threads could not be deleted.");
      return;
    }
    const confirmed = worktrees.confirmed();
    setConfirmation("");
    worktrees.reset();
    // Archived rows are a cached snapshot; refresh it so deleted ones leave the lists.
    refreshArchivedThreadsForEnvironment(project.environmentId);
    void countThreads();
    toastManager.add({
      type: "success",
      title: `Deleted ${threadCountLabel(result.value.deletedThreadIds.length)}`,
      description: "Project memory, plan and routines were kept.",
    });
    if (confirmed !== null) void worktrees.remove(target, confirmed);
  }
  return (
    <>
      <h4>Delete all threads</h4>
      <p>
        Permanently delete {threadCount === null ? "every thread" : threadCountLabel(threadCount)}{" "}
        in this project, archived ones and threads you started included. This cannot be undone.
      </p>
      <p className="project-muted">
        The coordinator and its own subagents, project memory, plan, routines and connections stay,
        so you can start fresh threads with what the project already knows. Running threads must
        stop first.
      </p>
      <label>
        Type {project.title} to confirm
        <input
          aria-label="Confirm deleting all threads"
          autoComplete="off"
          value={confirmation}
          onChange={(e) => typeConfirmation(e.target.value)}
          disabled={disabled || busy || threadCount === 0}
        />
      </label>
      {worktrees.section}
      {error !== null && (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
      <button
        className="project-control project-danger"
        disabled={disabled || busy || threadCount === 0 || confirmation !== project.title}
        onClick={() => void run()}
      >
        {busy
          ? "Deleting threads…"
          : threadCount === null
            ? "Delete all threads"
            : `Delete ${threadCountLabel(threadCount)}`}
      </button>
      <hr className="my-6 border-border" />
    </>
  );
}
