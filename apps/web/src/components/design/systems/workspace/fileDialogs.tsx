/** Rename and delete confirmations shared by Files and Assets. */
import { useId, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";
import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";

/** The text a person types in a rename field; `problem` explains a name the folder can't hold. */
export function RenameDialog({
  title,
  label,
  initial,
  description,
  problem,
  onRename,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  description?: ReactNode;
  problem: (value: string) => string | null;
  /** Resolves to an error message, or null once renamed. */
  onRename: (value: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === initial) return onClose();
    const invalid = problem(trimmed);
    if (invalid !== null) return setError(invalid);
    setBusy(true);
    setError(null);
    void onRename(trimmed).then((failure) => {
      setBusy(false);
      if (failure === null) onClose();
      else setError(failure);
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup className="sm:max-w-md" data-testid="rename-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{label}</Label>
              <Input
                id={id}
                size="sm"
                value={value}
                maxLength={180}
                aria-invalid={error !== null}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
              {error ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || value.trim() === ""}>
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function ConfirmDeleteDialog({
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  /** Resolves to an error message, or null once deleted. */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogPopup data-testid="confirm-delete">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="px-6 text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onConfirm().then((failure) => {
                setBusy(false);
                if (failure === null) onClose();
                else setError(failure);
              });
            }}
          >
            {busy ? "Deleting…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
