import { useCallback, useRef, useState } from "react";
import type { EnvironmentId, ProjectId, ProjectWorktree } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";

import { formatBytes } from "../../studio/folderCopy";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import {
  defaultProjectWorktreeChoice,
  projectWorktreeRemovalRequest,
  projectWorktreeRemovalToast,
  summarizeProjectWorktrees,
  worktreeCount,
  worktreeCountWithSize,
  type ProjectWorktreeChoice,
  type ProjectWorktreeRemovalRequest,
  type ProjectWorktreeSummary,
} from "./projectDeletionWorktrees.logic";

export interface ProjectWorktreeTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

type Preview =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly summary: ProjectWorktreeSummary;
      readonly sizes: ReadonlyMap<string, number | null>;
    };

/** What removing a worktree takes with it, for the confirmed request. */
export interface ConfirmedProjectWorktrees {
  readonly request: ProjectWorktreeRemovalRequest;
  readonly sizes: ReadonlyMap<string, number | null>;
}

/**
 * The delete dialog's worktree section: reads the project's worktrees when the
 * dialog opens, and removes the confirmed ones after the project is deleted.
 * Worktrees are removed only after deletion, so no live thread still uses them.
 */
export function useProjectDeletionWorktrees() {
  const readWorktrees = useAtomCommand(projectEnvironment.worktreesRead, { reportFailure: false });
  const removeWorktrees = useAtomCommand(projectEnvironment.worktreesRemove, {
    reportFailure: false,
  });
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const [choice, setChoice] = useState<ProjectWorktreeChoice>({
    removeClean: false,
    discardChanges: false,
  });
  // A later dialog must not receive an earlier dialog's late preview.
  const generation = useRef(0);

  const load = useCallback(
    async (target: ProjectWorktreeTarget | null) => {
      const current = ++generation.current;
      setChoice({ removeClean: false, discardChanges: false });
      if (target === null) {
        setPreview({ status: "idle" });
        return;
      }
      setPreview({ status: "loading" });
      const result = await readWorktrees({
        environmentId: target.environmentId,
        input: { projectId: target.projectId },
      });
      if (current !== generation.current) return;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setPreview({
          status: "failed",
          message: cause instanceof Error ? cause.message : "The worktrees could not be checked.",
        });
        return;
      }
      const summary = summarizeProjectWorktrees(result.value.worktrees);
      setPreview({
        status: "ready",
        summary,
        sizes: new Map(result.value.worktrees.map((entry) => [entry.path, entry.sizeBytes])),
      });
      setChoice(defaultProjectWorktreeChoice(summary));
    },
    [readWorktrees],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setPreview({ status: "idle" });
    setChoice({ removeClean: false, discardChanges: false });
  }, []);

  /** The person's current choice, or null when nothing will be removed. */
  const confirmed = (): ConfirmedProjectWorktrees | null => {
    if (preview.status !== "ready") return null;
    const request = projectWorktreeRemovalRequest(preview.summary, choice);
    return request === null ? null : { request, sizes: preview.sizes };
  };

  const remove = useCallback(
    async (target: ProjectWorktreeTarget, worktrees: ConfirmedProjectWorktrees) => {
      const result = await removeWorktrees({
        environmentId: target.environmentId,
        input: { projectId: target.projectId, ...worktrees.request },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "The project was deleted, but its worktrees were kept",
          description: cause instanceof Error ? cause.message : "Removing them failed.",
        });
        return;
      }
      toastManager.add(projectWorktreeRemovalToast(result.value, worktrees.sizes));
    },
    [removeWorktrees],
  );

  const section = (
    <ProjectDeletionWorktrees preview={preview} choice={choice} onChoiceChange={setChoice} />
  );
  return { load, reset, confirmed, remove, section };
}

function WorktreeList({ worktrees }: { worktrees: ReadonlyArray<ProjectWorktree> }) {
  return (
    <ul className="ms-6 grid max-h-36 gap-1 overflow-y-auto text-xs text-muted-foreground">
      {worktrees.map((worktree) => (
        <li key={worktree.path} className="[overflow-wrap:anywhere]">
          {worktree.path}
          {worktree.sizeBytes !== null ? ` · ${formatBytes(worktree.sizeBytes)}` : ""}
          {worktree.branch !== null ? ` · ${worktree.branch}` : ""}
          {worktree.status === "in_use" || worktree.status === "not_removable"
            ? ` · ${worktree.detail ?? "Kept."}`
            : ""}
        </li>
      ))}
    </ul>
  );
}

export function ProjectDeletionWorktrees({
  preview,
  choice,
  onChoiceChange,
}: {
  preview: Preview;
  choice: ProjectWorktreeChoice;
  onChoiceChange: (choice: ProjectWorktreeChoice) => void;
}) {
  if (preview.status === "idle") return null;
  if (preview.status === "loading")
    return <p className="text-sm text-muted-foreground">Checking this project's worktrees…</p>;
  if (preview.status === "failed")
    return <p className="text-sm text-muted-foreground">Worktrees are kept: {preview.message}</p>;
  const { summary } = preview;
  if (summary.removable.length + summary.localChanges.length + summary.kept.length === 0)
    return <p className="text-sm text-muted-foreground">This project has no worktrees on disk.</p>;
  return (
    <div className="my-4 grid gap-3" data-testid="project-deletion-worktrees">
      {summary.removable.length > 0 && (
        <div className="grid gap-1">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              aria-label="Also delete clean worktrees"
              checked={choice.removeClean}
              onCheckedChange={(checked) =>
                onChoiceChange({ ...choice, removeClean: checked === true })
              }
            />
            <span className="grid gap-1">
              <span>
                Also delete{" "}
                {worktreeCountWithSize(summary.removable.length, summary.removableBytes)}
              </span>
              <span className="text-xs text-muted-foreground">
                They have no uncommitted files. Their branches are kept, so committed work stays in
                Git.
                {summary.localCommitBranches > 0
                  ? ` ${worktreeCount(summary.localCommitBranches)} ${summary.localCommitBranches === 1 ? "has" : "have"} commits that exist only on this machine; they stay on the branch.`
                  : ""}
              </span>
            </span>
          </label>
          <WorktreeList worktrees={summary.removable} />
        </div>
      )}
      {summary.localChanges.length > 0 && (
        <div className="grid gap-1">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              aria-label="Also delete worktrees with uncommitted files"
              checked={choice.discardChanges}
              onCheckedChange={(checked) =>
                onChoiceChange({ ...choice, discardChanges: checked === true })
              }
            />
            <span className="grid gap-1">
              <span className="text-destructive-foreground">
                Also delete{" "}
                {worktreeCountWithSize(summary.localChanges.length, summary.localChangesBytes)} with
                uncommitted files. Those files are lost.
              </span>
              <span className="text-xs text-muted-foreground">
                Leave this unticked to keep them, then commit or copy what you need.
              </span>
            </span>
          </label>
          <WorktreeList worktrees={summary.localChanges} />
        </div>
      )}
      {summary.kept.length > 0 && (
        <div className="grid gap-1 text-sm">
          <span>{worktreeCount(summary.kept.length)} will be kept</span>
          <WorktreeList worktrees={summary.kept} />
        </div>
      )}
    </div>
  );
}
