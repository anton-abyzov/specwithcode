/**
 * The editor header's design-system picker. Besides None, the owner's systems
 * and other owners' systems (copied in on pick, or the copy already here
 * reused, with a fresh copy offered when it predates the source), it names the system a
 * found-system design follows, and offers "Open design system" (the system
 * page) and "Manage design systems". Narrow windows reach the same choices
 * through the header's More menu (`EditorSystemMenuSub`).
 */
import type {
  DesignOwnerInput,
  DesignReuse,
  DesignSystemId,
  DesignSystemSummary,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";

import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { copyInLabel, type CopyOptions, type CopyOutcome } from "../systems/DesignSystemPicker";
import {
  copyIn,
  copyPredatesSource,
  ownerName,
  systemKey,
  type OwnerProject,
} from "../systems/reviewModel";
import {
  SYSTEM_COPY,
  SYSTEM_FOUND,
  SYSTEM_FRESH,
  SYSTEM_MANAGE,
  SYSTEM_NONE,
  SYSTEM_OPEN,
  editorSystemChoices,
  type EditorSystemChoices,
} from "./editorSystem";

export interface EditorSystemInput {
  readonly owner: DesignOwnerInput;
  readonly systems: readonly DesignSystemSummary[] | null;
  readonly projects: readonly OwnerProject[];
  readonly value: DesignSystemId | null;
  readonly reuse: DesignReuse | null;
  readonly onChange: (value: DesignSystemId | null) => void;
  readonly onCopy:
    | ((system: DesignSystemSummary, options?: CopyOptions) => Promise<CopyOutcome>)
    | null;
  /** Opens the system page. */
  readonly onOpen: (target: { owner: DesignOwnerInput; systemId: DesignSystemId }) => void;
  /** Opens the list of design systems. */
  readonly onManage: () => void;
  readonly disabled: boolean;
}

export interface EditorSystemControl {
  readonly choices: EditorSystemChoices;
  readonly target: string;
  readonly copying: string | null;
  readonly error: string | null;
  readonly pick: (next: string | null) => void;
  readonly disabled: boolean;
}

/** The picker's state, shared by the header picker and the narrow-window menu. */
export function useEditorSystem(input: EditorSystemInput): EditorSystemControl {
  const [copying, setCopying] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: DesignSystemId; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = editorSystemChoices({
    owner: input.owner,
    systems: input.systems,
    value: input.value,
    reuse: input.reuse,
    canCopy: input.onCopy !== null,
    copied,
  });
  const pick = (next: string | null) => {
    setError(null);
    if (next === SYSTEM_OPEN) {
      if (choices.open !== null) input.onOpen(choices.open);
      return;
    }
    if (next === SYSTEM_MANAGE) return input.onManage();
    if (next === SYSTEM_FOUND) {
      // Picking the found system links the owner's imported copy, once there is one.
      if (choices.found?.importedId != null) input.onChange(choices.found.importedId);
      return;
    }
    if (next === null || next === SYSTEM_NONE) return input.onChange(null);
    const fresh = next.startsWith(SYSTEM_FRESH);
    if (!fresh && !next.startsWith(SYSTEM_COPY)) return input.onChange(next as DesignSystemId);
    const prefix = fresh ? SYSTEM_FRESH : SYSTEM_COPY;
    const source = choices.others.find((system) => `${prefix}${systemKey(system)}` === next);
    if (source === undefined || input.onCopy === null) return;
    // The owner already holds a copy of it: select that copy instead of writing another.
    const existing = copyIn(choices.own, source);
    if (existing !== undefined && !fresh) return input.onChange(existing.ref.systemId);
    setCopying(source.name);
    void input.onCopy(source, fresh ? { fresh: true } : {}).then((outcome) => {
      setCopying(null);
      if (!outcome.ok) return setError(outcome.message);
      setCopied({ id: outcome.systemId, name: outcome.name });
      input.onChange(outcome.systemId);
    });
  };
  return {
    choices,
    target: ownerName(input.owner, input.projects),
    copying,
    error,
    pick,
    disabled: input.disabled || copying !== null,
  };
}

/** Each other owner's system: copy it, or use the copy here, plus a fresh copy when that one is stale. */
function copyRows(choices: EditorSystemChoices, target: string) {
  return choices.others.flatMap((system) => {
    const existing = copyIn(choices.own, system);
    const rows = [
      {
        system,
        value: `${SYSTEM_COPY}${systemKey(system)}`,
        hint:
          existing === undefined ? `Copy into ${target}` : copyInLabel(existing, system, target),
      },
    ];
    if (existing !== undefined && copyPredatesSource(existing, system))
      rows.push({
        system,
        value: `${SYSTEM_FRESH}${systemKey(system)}`,
        hint: `Make a fresh copy in ${target}`,
      });
    return rows;
  });
}

function foundHint(choices: EditorSystemChoices) {
  return choices.found?.importedId != null
    ? "Imported. Pick it to link it by name."
    : "Found in this repository";
}

/** The header picker (a combobox), from 640 px up. */
export function EditorSystemPicker({
  control,
  className,
}: {
  control: EditorSystemControl;
  className?: string;
}) {
  const { choices, copying, error, target } = control;
  return (
    <div className={cn("relative", className)} data-testid="design-system-picker">
      <Select value={choices.value} onValueChange={control.pick} disabled={control.disabled}>
        <SelectTrigger size="sm" aria-label="Design system">
          <SelectValue>
            {copying !== null ? `Copying ${copying} into ${target}…` : choices.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={SYSTEM_NONE}>None</SelectItem>
          {choices.found !== null ? (
            <SelectGroup>
              <SelectGroupLabel>Found in this repository</SelectGroupLabel>
              <SelectItem value={SYSTEM_FOUND} data-testid="design-system-picker-found">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{choices.found.name}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {foundHint(choices)}
                  </span>
                </span>
              </SelectItem>
            </SelectGroup>
          ) : null}
          {choices.own.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>{target}</SelectGroupLabel>
              {choices.own.map((system) => (
                <SelectItem key={system.ref.systemId} value={system.ref.systemId}>
                  {system.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {choices.others.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>Other projects</SelectGroupLabel>
              {copyRows(choices, target).map(({ system, value, hint }) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-testid={
                    value.startsWith(SYSTEM_FRESH)
                      ? "design-system-picker-fresh"
                      : "design-system-picker-copy"
                  }
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{system.name}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {system.ownerLabel} · {hint}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          <div role="separator" aria-hidden className="mx-2 my-1 h-px bg-border" />
          <SelectItem
            value={SYSTEM_OPEN}
            disabled={choices.open === null}
            data-testid="design-system-picker-open"
          >
            Open design system
          </SelectItem>
          <SelectItem value={SYSTEM_MANAGE} data-testid="design-system-picker-manage">
            Manage design systems
          </SelectItem>
        </SelectPopup>
      </Select>
      {error ? (
        <p
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 w-max max-w-72 rounded-md border bg-popover px-2 py-1 text-destructive-foreground text-xs shadow-sm"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The same choices as a submenu of the header's More menu, below 640 px. */
export function EditorSystemMenuSub({
  control,
  className,
}: {
  control: EditorSystemControl;
  className?: string;
}) {
  const { choices, target } = control;
  return (
    <MenuSub>
      <MenuSubTrigger
        disabled={control.disabled}
        {...(className === undefined ? {} : { className })}
        data-testid="design-more-system"
      >
        <span className="flex min-w-0 flex-col">
          <span>Design system</span>
          <span className="truncate text-muted-foreground text-xs">{choices.label}</span>
        </span>
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-56">
        <MenuRadioGroup value={choices.value} onValueChange={(next) => control.pick(next)}>
          <MenuRadioItem value={SYSTEM_NONE}>None</MenuRadioItem>
          {choices.found !== null ? (
            <MenuGroup>
              <MenuGroupLabel>Found in this repository</MenuGroupLabel>
              <MenuRadioItem value={SYSTEM_FOUND}>{choices.found.name}</MenuRadioItem>
            </MenuGroup>
          ) : null}
          {choices.own.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>{target}</MenuGroupLabel>
              {choices.own.map((system) => (
                <MenuRadioItem key={system.ref.systemId} value={system.ref.systemId}>
                  {system.name}
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ) : null}
        </MenuRadioGroup>
        {choices.others.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Other projects</MenuGroupLabel>
            {copyRows(choices, target).map(({ system, value, hint }) => (
              <MenuItem key={value} onClick={() => control.pick(value)}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{system.name}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {system.ownerLabel} · {hint}
                  </span>
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        <MenuSeparator />
        <MenuItem disabled={choices.open === null} onClick={() => control.pick(SYSTEM_OPEN)}>
          Open design system
        </MenuItem>
        <MenuItem onClick={() => control.pick(SYSTEM_MANAGE)}>Manage design systems</MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
