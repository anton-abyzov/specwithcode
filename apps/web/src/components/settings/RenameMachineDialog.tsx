import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import {
  ENVIRONMENT_MACHINE_KINDS,
  MACHINE_NICKNAME_MAX_LENGTH,
  MACHINE_SHORT_NAME_MAX_LENGTH,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import {
  fitMachineNickname,
  normalizeMachineNickname,
  normalizeMachineShortName,
  suggestMachineNickname,
} from "@specweave-studio/shared/machineNicknames";
import {
  assignMachineShortLabels,
  graphemeLength,
  MACHINE_SHORT_LABEL_MIN_LENGTH,
} from "@specweave-studio/shared/machineShortLabel";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  renameMachineLockText,
  resolveMachineNickname,
  useCustomMachineNickname,
  useMachineNameHolder,
  useMachineNameSources,
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
 * Names a machine. One field, "Machine name", is what Runs on, thread rows,
 * the sidebar and every paired device show; the computer's own name is shown
 * under it and never changes. The 2 or 3 chip letters follow the name unless
 * set under Customize, with the color and icon. A live preview shows the
 * result. Everything is saved against the machine's id, so renaming the
 * computer or reconnecting it under another address keeps it.
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
  const hostId = useId();
  const shortId = useId();
  const shortHintId = useId();
  const clashId = useId();
  const customizeId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const colorId = useId();
  const iconId = useId();
  const custom = useCustomMachineNickname(environmentId);
  const { lock, saveIdentity } = useRenameMachine();
  const identity = useMachineIdentity(environmentId, hostLabel);
  const [color, setColor] = useState(identity?.color ?? MACHINE_COLOR_IDS[0]);
  const [icon, setIcon] = useState(identity?.icon ?? "server");
  // What the machine shows with no name chosen, and that name cut to fit the field
  // so the dialog never opens over its limit.
  const fullDefaultName = shortMachineName(hostLabel);
  const defaultName = fitMachineNickname(fullDefaultName);
  const current = custom ?? defaultName;
  const suggested = suggestMachineNickname(hostLabel);
  const [value, setValue] = useState(current);
  const [nameTouched, setNameTouched] = useState(false);
  const { nicknames, labels } = useMachineNameSources();
  const nameHolder = useMachineNameHolder();
  const storedShort = (environmentId ? nicknames[environmentId]?.short : undefined) ?? "";
  const [shortValue, setShortValue] = useState(storedShort);
  // Until the letters are typed here, a changed name brings its own letters.
  const [shortTouched, setShortTouched] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  useEffect(() => {
    if (!open) return;
    setValue(current);
    setNameTouched(false);
    setShortValue(storedShort);
    setShortTouched(false);
    setCustomizing(false);
    if (identity) {
      setColor(identity.color);
      setIcon(identity.icon);
    }
    // Reset only when the dialog opens; a fleet update must not clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const next = normalizeMachineNickname(value);
  const lockText = renameMachineLockText(lock);
  const nameChanged = next !== current;
  // Letters typed here win; otherwise a changed name brings its own and an
  // unchanged one keeps the stored pair. The preview shows which, before Save.
  const nextShort = shortTouched
    ? normalizeMachineShortName(shortValue)
    : nameChanged
      ? ""
      : storedShort;
  const shortValid =
    nextShort === "" || graphemeLength(nextShort) >= MACHINE_SHORT_LABEL_MIN_LENGTH;
  // With nothing typed over it, the machine shows its whole computer name.
  const previewName = next === "" || (!nameTouched && custom === null) ? fullDefaultName : next;
  // Saving re-runs the fleet-wide letter assignment, so the preview runs it too,
  // with this machine's new name and letters in place.
  const derivedShort = useMemo(() => {
    const ids = new Set([...Object.keys(nicknames), ...labels.keys()]);
    if (environmentId !== null) ids.add(environmentId);
    const assigned = assignMachineShortLabels(
      [...ids].map((id) =>
        id === environmentId
          ? { environmentId: id, name: previewName, short: undefined }
          : {
              environmentId: id,
              name: resolveMachineNickname(nicknames, id, labels.get(id)),
              short: nicknames[id]?.short,
            },
      ),
    );
    return environmentId === null ? "" : (assigned.get(environmentId) ?? "");
  }, [nicknames, labels, environmentId, previewName]);
  const previewShort = nextShort !== "" ? nextShort : derivedShort;
  const clash = environmentId !== null && nameChanged ? nameHolder(environmentId, next) : null;
  const looksChanged =
    identity !== null &&
    (color !== identity.color || icon !== identity.icon || nextShort !== storedShort);
  // Typing the cut computer name on purpose chooses it, though it matches the start value.
  const choosesCutName =
    custom === null && nameTouched && next === defaultName && defaultName !== fullDefaultName;
  const canSave =
    environmentId !== null &&
    lock === null &&
    next !== "" &&
    shortValid &&
    (nameChanged || looksChanged || choosesCutName);
  const typeName = (name: string) => {
    setValue(name);
    setNameTouched(true);
  };
  const save = (name: string, short: string = nextShort) => {
    // An untouched default is kept as "no nickname", so a host rename still shows through.
    const saved = name === defaultName && custom === null && !choosesCutName ? "" : name;
    if (
      environmentId === null ||
      !saveIdentity(environmentId, { name: saved, color, icon, short })
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
            {tx("Runs on, thread rows, the sidebar and your other devices show this name.")}
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
            <Label htmlFor={fieldId}>{tx("Machine name")}</Label>
            <Input
              id={fieldId}
              value={value}
              maxLength={MACHINE_NICKNAME_MAX_LENGTH}
              placeholder={suggested ?? defaultName}
              ref={nameRef}
              aria-describedby={[hostId, countId, clash !== null ? clashId : null]
                .filter(Boolean)
                .join(" ")}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={lock !== null}
              onChange={(event) => typeName(event.target.value)}
            />
            <div className="flex items-start justify-between gap-2">
              <p id={hostId} className="text-muted-foreground min-w-0 text-xs" data-machine-host-name>
                {renderRich(tx("Computer name: {hostLabel}, unchanged."), { hostLabel })}
              </p>
              <CharacterCount id={countId} value={value} max={MACHINE_NICKNAME_MAX_LENGTH} />
            </div>
            {suggested !== null && next !== suggested ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="justify-self-start"
                disabled={lock !== null}
                data-machine-name-suggestion={suggested}
                onClick={() => {
                  typeName(suggested);
                  // The button leaves once used; keep focus in the field it filled.
                  nameRef.current?.focus();
                }}
              >
                {renderRich(tx("Use {defaultName}"), { defaultName: suggested })}
              </Button>
            ) : null}
            {clash !== null ? (
              <p
                id={clashId}
                className="rounded-md bg-warning/10 px-2 py-1.5 text-warning-foreground text-xs"
                data-machine-name-clash={clash.environmentId}
              >
                {renderRich(
                  tx(
                    "Another machine is already called {name}. If it is an old copy of this one, remove it under Other machines.",
                  ),
                  { name: clash.name },
                )}
              </p>
            ) : null}
            <div
              className="mt-2 grid gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs"
              role="group"
              data-machine-name-preview=""
              aria-label={tx("Preview")}
            >
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">{tx("Runs on")}</span>
                <span
                  data-machine-color={color}
                  className="machine-chip inline-flex h-6 max-w-40 items-center gap-1.5 rounded-full ps-1.5 pe-2 font-semibold"
                >
                  <EnvironmentMachineIcon kind={icon} className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate" data-preview-name="">
                    {previewName}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">{tx("Narrow chip")}</span>
                <span
                  data-machine-color={color}
                  className="machine-chip inline-flex h-6 items-center rounded-full px-2 font-semibold"
                  data-preview-short=""
                >
                  {previewShort}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 justify-self-start text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={customizing}
              aria-controls={customizeId}
              data-machine-customize=""
              onClick={() => setCustomizing((was) => !was)}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3.5 transition-transform", customizing && "rotate-90")}
              />
              {tx("Customize chip letters, color and icon")}
            </button>
            {customizing ? (
              <div id={customizeId} className="grid gap-1.5" data-machine-customize-panel="">
                <Label htmlFor={shortId} className="mt-1">
                  {tx("Chip letters")}
                </Label>
                <Input
                  id={shortId}
                  className="w-24"
                  value={shortTouched ? shortValue : nextShort}
                  maxLength={MACHINE_SHORT_NAME_MAX_LENGTH}
                  placeholder={derivedShort}
                  aria-describedby={shortHintId}
                  aria-invalid={!shortValid || undefined}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={lock !== null}
                  data-machine-short-input=""
                  onChange={(event) => {
                    setShortTouched(true);
                    setShortValue(event.target.value);
                  }}
                />
                <p id={shortHintId} className="text-muted-foreground text-xs">
                  {shortValid
                    ? tx("2 or 3 characters for a chip too narrow for the name. Empty follows the name.")
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
              </div>
            ) : null}
            {lockText ? <p className="text-muted-foreground text-xs">{lockText}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {custom !== null ? (
            <Button
              variant="ghost"
              className="me-auto"
              disabled={lock !== null || !shortValid}
              // The letters follow the computer name too, as they follow any new name.
              onClick={() => save("", "")}
            >
              {tx("Use the computer name")}
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
