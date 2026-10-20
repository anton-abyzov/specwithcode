import { MACHINE_NICKNAME_MAX_LENGTH, type EnvironmentId } from "@specweave-studio/contracts";
import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import { useEffect, useId, useState } from "react";

import {
  renameMachineLockText,
  useCustomMachineNickname,
  useMachineNicknames,
} from "../../studio/machineNickname";
import { useRenameMachine } from "../../studio/useRenameMachine";
import { shortMachineName } from "../../studio/shellModel";
import { Button } from "../ui/button";
import { CharacterCount } from "../ui/character-count";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Gives a machine a short name of up to 16 characters. The name is saved
 * against the machine's id, so renaming the computer or reconnecting it under
 * another address keeps it, and every paired machine shows the same name.
 */
export function RenameMachineDialog({
  environmentId,
  hostLabel,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly hostLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const countId = useId();
  const resolve = useMachineNicknames();
  const custom = useCustomMachineNickname(environmentId);
  const { lock, rename } = useRenameMachine();
  const defaultName = shortMachineName(hostLabel).slice(0, MACHINE_NICKNAME_MAX_LENGTH);
  const current = environmentId ? resolve(environmentId, hostLabel) : defaultName;
  const [value, setValue] = useState(current);
  useEffect(() => {
    if (open) setValue(current);
    // Reset only when the dialog opens; a fleet update must not clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const next = normalizeMachineNickname(value);
  const lockText = renameMachineLockText(lock);
  const canSave = environmentId !== null && lock === null && next !== "" && next !== current;
  const save = (name: string) => {
    if (environmentId === null || !rename(environmentId, name)) return;
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm" data-testid="rename-machine-dialog">
        <DialogHeader>
          <DialogTitle>Rename machine</DialogTitle>
          <DialogDescription>
            A short name for {hostLabel}. Thread rows, Run on and your other devices show it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) save(next);
            }}
          >
            <Label htmlFor={fieldId}>Name</Label>
            <Input
              id={fieldId}
              value={value}
              maxLength={MACHINE_NICKNAME_MAX_LENGTH}
              placeholder={defaultName}
              aria-describedby={countId}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={lock !== null}
              onChange={(event) => setValue(event.target.value)}
            />
            <CharacterCount id={countId} value={value} max={MACHINE_NICKNAME_MAX_LENGTH} />
            {lockText ? <p className="text-muted-foreground text-xs">{lockText}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {custom !== null ? (
            <Button
              variant="ghost"
              className="me-auto"
              disabled={lock !== null}
              onClick={() => save("")}
            >
              Use {defaultName}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => save(next)}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
