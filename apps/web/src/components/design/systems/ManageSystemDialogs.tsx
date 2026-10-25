/**
 * Rename and delete for a whole design system, shared by Settings rows and
 * anything else that manages systems. The caller owns the RPCs.
 */
import { ConfirmDeleteDialog, RenameDialog } from "./workspace/fileDialogs";

export function systemNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A design system needs a name.";
  if (trimmed.length > 180) return "Keep the name under 180 characters.";
  return null;
}

export function RenameSystemDialog({
  name,
  onRename,
  onClose,
}: {
  name: string;
  /** Resolves to an error message, or null once renamed. */
  onRename: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  return (
    <RenameDialog
      title={`Rename ${name}`}
      label="Name"
      initial={name}
      description="Designs that use it keep using it under the new name."
      problem={systemNameProblem}
      onRename={onRename}
      onClose={onClose}
    />
  );
}

/** What deleting does to designs, from the usage count; null while it is counted. */
export function usageWarning(designs: number | null, ownerLabel: string): string {
  if (designs === null) return "Checking which designs use it…";
  if (designs === 0) return `No designs in ${ownerLabel} use it.`;
  return `${designs} ${designs === 1 ? "design" : "designs"} in ${ownerLabel} ${designs === 1 ? "uses" : "use"} it. They keep its id and lose its tokens and components until you pick another design system.`;
}

export function DeleteSystemDialog({
  name,
  ownerLabel,
  designs,
  usageError,
  onDelete,
  onClose,
}: {
  name: string;
  ownerLabel: string;
  /** Designs of the owner that use the system; null while counting. */
  designs: number | null;
  usageError: string | null;
  /** Resolves to an error message, or null once deleted. */
  onDelete: () => Promise<string | null>;
  onClose: () => void;
}) {
  return (
    <ConfirmDeleteDialog
      title={`Delete ${name}?`}
      confirmLabel="Delete design system"
      description={
        <span className="flex flex-col gap-2" data-testid="delete-system-warning">
          <span>
            This deletes the design system, its files and its history from {ownerLabel}. Proposals
            waiting to update it are discarded.
          </span>
          <span className="font-medium text-foreground">
            {usageError === null
              ? usageWarning(designs, ownerLabel)
              : `The app couldn't check which designs use it: ${usageError}`}
          </span>
        </span>
      }
      onConfirm={onDelete}
      onClose={onClose}
    />
  );
}
