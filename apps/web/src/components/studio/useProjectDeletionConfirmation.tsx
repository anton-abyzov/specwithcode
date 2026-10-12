import { useCallback, useEffect, useRef, useState } from "react";
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

type Target = { title: string; workspaceRoot: string; environmentLabel?: string | null };
/** The returned receipt is the user's exact text, never a programmatic title. */
export function useProjectDeletionConfirmation() {
  const [target, setTarget] = useState<Target | null>(null);
  const [typed, setTyped] = useState("");
  const pending = useRef<((value: string | null) => void) | null>(null);
  const finish = useCallback((value: string | null) => {
    const resolve = pending.current;
    pending.current = null;
    setTarget(null);
    setTyped("");
    resolve?.(value);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    [],
  );
  const confirmDeletion = useCallback((next: Target): Promise<string | null> => {
    if (pending.current) return Promise.resolve(null);
    setTarget(next);
    setTyped("");
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }, []);
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
            cannot be undone. Files on disk are kept.
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
              if (target && typed === target.title) finish(typed);
            }}
          >
            Delete project and threads
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
  return { confirmDeletion, deletionDialog };
}
