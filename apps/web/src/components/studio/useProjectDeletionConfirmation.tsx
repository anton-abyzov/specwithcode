import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import {
  useProjectDeletionWorktrees,
  type ConfirmedProjectWorktrees,
} from "./ProjectDeletionWorktrees";

type Target = {
  title: string;
  workspaceRoot: string;
  environmentLabel?: string | null;
  /** With both, the dialog offers to delete the project's worktrees too. */
  id?: ProjectId;
  environmentId?: EnvironmentId;
};
const targetKey = (target: Target) => `${target.environmentId ?? ""}:${target.id ?? ""}`;
/**
 * The returned receipt is the user's exact text, never a programmatic title.
 * After the project is deleted, `removeConfirmedWorktrees` removes the
 * worktrees the user ticked for it.
 */
export function useProjectDeletionConfirmation() {
  const [target, setTarget] = useState<Target | null>(null);
  const [typed, setTyped] = useState("");
  const pending = useRef<((value: string | null) => void) | null>(null);
  const {
    load: loadWorktrees,
    reset: resetWorktrees,
    remove: removeWorktrees,
    section: worktreeSection,
    confirmed: confirmedWorktreeChoice,
  } = useProjectDeletionWorktrees();
  const confirmedWorktrees = useRef(new Map<string, ConfirmedProjectWorktrees>());
  const finish = useCallback(
    (value: string | null) => {
      const resolve = pending.current;
      pending.current = null;
      setTarget(null);
      setTyped("");
      resetWorktrees();
      resolve?.(value);
    },
    [resetWorktrees],
  );
  useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    [],
  );
  const confirmDeletion = useCallback(
    (next: Target): Promise<string | null> => {
      if (pending.current) return Promise.resolve(null);
      setTarget(next);
      setTyped("");
      confirmedWorktrees.current.delete(targetKey(next));
      void loadWorktrees(
        next.id !== undefined && next.environmentId !== undefined
          ? { environmentId: next.environmentId, projectId: next.id }
          : null,
      );
      return new Promise((resolve) => {
        pending.current = resolve;
      });
    },
    [loadWorktrees],
  );
  const removeConfirmedWorktrees = useCallback(
    async (deleted: Target) => {
      const key = targetKey(deleted);
      const confirmed = confirmedWorktrees.current.get(key);
      confirmedWorktrees.current.delete(key);
      if (
        confirmed === undefined ||
        deleted.id === undefined ||
        deleted.environmentId === undefined
      )
        return;
      await removeWorktrees(
        { environmentId: deleted.environmentId, projectId: deleted.id },
        confirmed,
      );
    },
    [removeWorktrees],
  );
  const deletionDialog = (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup>
        <DialogPanel>
          <DialogTitle>Delete project</DialogTitle>
          <DialogDescription>
            Permanently delete this project and all of its threads, including archived history. This
            cannot be undone. The project folder and Git branches are kept.
          </DialogDescription>
          {target && (
            <div className="grid gap-3">
              <p className="break-all text-sm text-muted-foreground">
                {target.workspaceRoot}
                {target.environmentLabel ? ` · ${target.environmentLabel}` : ""}
              </p>
              <label className="grid gap-2 text-sm">
                Type {target.title} to confirm
                <Input
                  aria-label="Confirm project deletion"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                />
              </label>
              {worktreeSection}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!target || typed !== target.title}
            onClick={() => {
              if (!target || typed !== target.title) return;
              const confirmed = confirmedWorktreeChoice();
              if (confirmed !== null) confirmedWorktrees.current.set(targetKey(target), confirmed);
              finish(typed);
            }}
          >
            Delete project and threads
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
  return { confirmDeletion, deletionDialog, removeConfirmedWorktrees };
}
