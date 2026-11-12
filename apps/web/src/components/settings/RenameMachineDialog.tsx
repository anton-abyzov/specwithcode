import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import {
  ENVIRONMENT_MACHINE_KINDS,
  MACHINE_NICKNAME_MAX_LENGTH,
  MACHINE_SHORT_NAME_MAX_LENGTH,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import {
  normalizeMachineNickname,
  normalizeMachineShortName,
} from "@specweave-studio/shared/machineNicknames";
import { MACHINE_SHORT_LABEL_MIN_LENGTH } from "@specweave-studio/shared/machineShortLabel";
import { useEffect, useId, useState } from "react";

import {
  renameMachineLockText,
  useCustomMachineNickname,
  useMachineNameSources,
  useMachineNicknames,
} from "../../studio/machineNickname";
import {
  MACHINE_COLOR_IDS,
  MACHINE_COLOR_LABELS,
  useMachineIdentity,
} from "../../studio/machineIdentity";
import { useRenameMachine } from "../../studio/useRenameMachine";
import { cn } from "~/lib/utils";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
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
 * Gives a machine a short name of up to 16 characters, a color, an icon and
 * the two or three characters its chip keeps when it runs out of room.
 * They are saved against the machine's id, so renaming the computer or
 * reconnecting it under another address keeps them, and every paired machine
 * shows the same name, color and icon.
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
  const tx = useTx();
  const fieldId = useId();
  const countId = useId();
  const shortId = useId();
  const shortHintId = useId();
  const resolve = useMachineNicknames();
  const custom = useCustomMachineNickname(environmentId);
  const { lock, saveIdentity } = useRenameMachine();
  const identity = useMachineIdentity(environmentId, hostLabel);
  const colorId = useId();
  const iconId = useId();
  const [color, setColor] = useState(identity?.color ?? MACHINE_COLOR_IDS[0]);
  const [icon, setIcon] = useState(identity?.icon ?? "server");
  const defaultName = shortMachineName(hostLabel).slice(0, MACHINE_NICKNAME_MAX_LENGTH);
  const current = environmentId ? resolve(environmentId, hostLabel) : defaultName;
  const [value, setValue] = useState(current);
  const { nicknames } = useMachineNameSources();
  const storedShort = (environmentId ? nicknames[environmentId]?.short : undefined) ?? "";
  const [shortValue, setShortValue] = useState(storedShort);
  useEffect(() => {
    if (open) setValue(current);
    if (open) setShortValue(storedShort);
    if (open && identity) {
      setColor(identity.color);
      setIcon(identity.icon);
    }
    // Reset only when the dialog opens; a fleet update must not clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const next = normalizeMachineNickname(value);
  const lockText = renameMachineLockText(lock);
  const nextShort = normalizeMachineShortName(shortValue);
  const shortValid = nextShort === "" || [...nextShort].length >= MACHINE_SHORT_LABEL_MIN_LENGTH;
  const looksChanged =
    identity !== null &&
    (color !== identity.color || icon !== identity.icon || nextShort !== storedShort);
  const canSave =
    environmentId !== null &&
    lock === null &&
    next !== "" &&
    shortValid &&
    (next !== current || looksChanged);
  const save = (name: string) => {
    // The default name is kept as "no nickname", so a host rename still shows through.
    const saved = name === defaultName && custom === null ? "" : name;
    if (
      environmentId === null ||
      !saveIdentity(environmentId, { name: saved, color, icon, short: nextShort })
    ) {
      return;
    }
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm" data-testid="rename-machine-dialog">
        <DialogHeader>
          <DialogTitle>{tx("Rename machine")}</DialogTitle>
          <DialogDescription>
            {renderRich(
              tx(
                "A short name for {hostLabel}. Thread rows, Run on and your other devices show it.",
              ),
              { hostLabel: hostLabel },
            )}
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
            <Label htmlFor={fieldId}>{tx("Name")}</Label>
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
            <Label htmlFor={shortId} className="mt-2">
              {tx("Short label")}
            </Label>
            <Input
              id={shortId}
              className="w-24"
              value={shortValue}
              maxLength={MACHINE_SHORT_NAME_MAX_LENGTH}
              placeholder={identity?.derivedShort ?? ""}
              aria-describedby={shortHintId}
              aria-invalid={!shortValid || undefined}
              autoComplete="off"
              spellCheck={false}
              disabled={lock !== null}
              data-machine-short-input=""
              onChange={(event) => setShortValue(event.target.value)}
            />
            <p id={shortHintId} className="text-muted-foreground text-xs">
              {shortValid
                ? tx("2 or 3 characters a narrow chip shows instead of the icon.")
                : tx("Use 2 or 3 characters.")}
            </p>
            <span id={colorId} className="mt-2 text-sm font-medium">
              {tx("Color")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby={colorId}
              className="flex flex-wrap gap-1.5"
              data-machine-color-choices=""
            >
              {MACHINE_COLOR_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={color === id}
                  aria-label={MACHINE_COLOR_LABELS[id]}
                  disabled={lock !== null}
                  data-machine-color={id}
                  className={cn(
                    "machine-swatch size-7 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    color === id && "machine-swatch-on",
                  )}
                  onClick={() => setColor(id)}
                />
              ))}
            </div>
            <span id={iconId} className="mt-2 text-sm font-medium">
              {tx("Icon")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby={iconId}
              className="flex flex-wrap gap-1.5"
              data-machine-icon-choices=""
            >
              {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={icon === kind}
                  aria-label={ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
                  disabled={lock !== null}
                  data-machine-color={color}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    icon === kind && "machine-chip",
                  )}
                  onClick={() => setIcon(kind)}
                >
                  <EnvironmentMachineIcon kind={kind} className="size-4" aria-hidden />
                </button>
              ))}
            </div>
            {lockText ? <p className="text-muted-foreground text-xs">{lockText}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {custom !== null ? (
            <Button
              variant="ghost"
              className="me-auto"
              disabled={lock !== null || !shortValid}
              onClick={() => save("")}
            >
              {renderRich(tx("Use {defaultName}"), { defaultName: defaultName })}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tx("Cancel")}
          </Button>
          <Button disabled={!canSave} onClick={() => save(next)}>
            {tx("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
