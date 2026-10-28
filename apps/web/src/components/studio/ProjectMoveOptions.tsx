import { ChevronDownIcon } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";
import type { HandoffFolderMethod } from "../../studio/folderCopy";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** What the person wants: the project continues there, or only its files go there. */
export type MoveIntent = "move" | "copy";

/**
 * What the project dialog shares with the copy flow it hosts: the file method lives in the
 * dialog, but on screen 1 it sits under the copy flow's More options. Absent outside the dialog.
 */
export interface ProjectMoveDialogContext {
  readonly method: HandoffFolderMethod;
  readonly onMethodChange: (method: HandoffFolderMethod) => void;
  readonly methodDisabled: boolean;
  readonly intent: MoveIntent;
  /** Closes the dialog the way its corner close does; null while a step must finish here. */
  readonly close: (() => void) | null;
}

export const ProjectMoveDialog = createContext<ProjectMoveDialogContext | null>(null);

export function useProjectMoveDialog() {
  return useContext(ProjectMoveDialog);
}

/** The segmented choice at the top of screen 1. */
export function MoveIntentToggle({
  value,
  onChange,
  canMove,
  disabled = false,
}: {
  readonly value: MoveIntent;
  readonly onChange: (intent: MoveIntent) => void;
  readonly canMove: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label="What to do"
      className="w-full *:flex-1"
      data-slot="handoff-intent"
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = next[0];
        if ((chosen === "move" && canMove) || chosen === "copy") onChange(chosen);
      }}
    >
      <Toggle value="move" disabled={!canMove}>
        Move and continue there
      </Toggle>
      <Toggle value="copy">Copy files only</Toggle>
    </ToggleGroup>
  );
}

/** Rare choices, folded away. Kept mounted so their state survives closing it. */
export function MoreOptions({
  defaultOpen = false,
  disabled = false,
  children,
}: {
  readonly defaultOpen?: boolean;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} data-slot="handoff-more-options">
      <CollapsibleTrigger
        className="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        disabled={disabled}
      >
        More options
        <ChevronDownIcon
          className="size-3.5 transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted>
        <div className="flex flex-col gap-4 pt-3">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const METHODS: ReadonlyArray<{
  readonly value: HandoffFolderMethod;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    value: "copy",
    label: "Copy everything except secrets",
    detail:
      "Includes uncommitted and ignored files. Files like .env stay here unless you pick them.",
  },
  {
    value: "clone",
    label: "Clone clean repositories from Git",
    detail: "Repositories with nothing uncommitted come from their remotes; the rest is copied.",
  },
  {
    value: "folder",
    label: "Send committed work through Git only",
    detail: "Pushes commits and continues in a folder already saved there. Nothing else moves.",
  },
];

/** The plain name of a way files travel, as More options lists it. */
export const methodLabel = (method: HandoffFolderMethod): string =>
  METHODS.find((item) => item.value === method)?.label ?? "";

/** How files travel. Reads the dialog's method; renders nothing outside the dialog. */
export function FilesTravelChoice() {
  const dialog = useProjectMoveDialog();
  if (!dialog) return null;
  const { method, onMethodChange, methodDisabled, intent } = dialog;
  return (
    <fieldset disabled={methodDisabled} className="min-w-0" data-slot="handoff-method">
      <legend className="mb-2 text-sm font-medium">How files travel</legend>
      <RadioGroup
        value={method}
        onValueChange={(value) => onMethodChange(value as HandoffFolderMethod)}
        disabled={methodDisabled}
        aria-label="How files travel"
      >
        {METHODS.map((item) => {
          // Git carries the coordinator with the commits; it cannot copy files only.
          const blocked = item.value === "folder" && intent === "copy";
          return (
            <label
              key={item.value}
              className={`flex min-w-0 items-start gap-3 text-sm ${blocked ? "cursor-not-allowed opacity-60" : methodDisabled ? "cursor-default" : "cursor-pointer"}`}
            >
              <span className="flex h-5 items-center">
                <Radio value={item.value} disabled={blocked} />
              </span>
              <span className="min-w-0 leading-5">
                <span className="block wrap-anywhere">{item.label}</span>
                <span className="block wrap-anywhere text-xs text-muted-foreground">
                  {blocked ? "Only when moving the project." : item.detail}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}

/** "Folder on {machine}": the path, with Browse… next to it. */
export function FolderField({
  machineLabel,
  value,
  onChange,
  readOnly = false,
  disabled = false,
  placeholder,
  onBrowse,
  browseDisabled = false,
  browsing = false,
  slot,
  children,
}: {
  readonly machineLabel: string;
  readonly value: string;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly onBrowse?: (() => void) | undefined;
  readonly browseDisabled?: boolean;
  readonly browsing?: boolean;
  readonly slot?: string;
  /** Lines under the field: where the project lands, a folder list, a reason. */
  readonly children?: ReactNode;
}) {
  const id = useId();
  const label = `Folder on ${machineLabel}`;
  return (
    <div className="space-y-1.5 text-sm" data-slot={slot}>
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      <div className="flex min-w-0 gap-2">
        <Input
          id={id}
          className="min-w-0 flex-1"
          font="mono"
          value={value}
          readOnly={readOnly}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={label}
          onChange={(event) => onChange?.(event.currentTarget.value)}
        />
        {onBrowse && (
          <Button
            type="button"
            variant="outline"
            aria-expanded={browsing}
            disabled={disabled || browseDisabled}
            onClick={onBrowse}
          >
            Browse…
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}
