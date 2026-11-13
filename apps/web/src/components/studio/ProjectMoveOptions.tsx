import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import type { HandoffFolderMethod } from "../../studio/folderCopy";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";

/** What the person wants: the project continues there, or only its files go there. */
export type MoveIntent = "move" | "copy";

/**
 * What the project dialog shares with the copy flow it hosts: the file method lives in the
 * dialog, but on screen 1 it sits under the copy flow's Details. Absent outside the dialog.
 */
export interface ProjectMoveDialogContext {
  readonly method: HandoffFolderMethod;
  readonly onMethodChange: (method: HandoffFolderMethod) => void;
  readonly methodDisabled: boolean;
  readonly intent: MoveIntent;
  /** Closes the dialog the way its corner close does; null while a step must finish here. */
  readonly close: (() => void) | null;
  /** True while the other machines' first status read has not settled. */
  readonly machinesLoading?: boolean;
  /** Shown under every machine list: account machines this app has not saved. */
  readonly machinesExtra?: ReactNode;
  /** Sync into a machine that already has the project: only files travel, nothing to hand off. */
  readonly sync?: boolean;
}

export const ProjectMoveDialog = createContext<ProjectMoveDialogContext | null>(null);

export function useProjectMoveDialog() {
  return useContext(ProjectMoveDialog);
}

/**
 * "Where should the coordinator run?": the one difference between copying a project and
 * handing it over. Keep runs `copy-only` and links the copy as workers; Move runs
 * `copy-and-move`. A sync into a machine's own copy never moves it, so it shows nothing.
 */
export function CoordinatorChoice({
  value,
  onChange,
  canMove,
  sourceLabel,
  targetLabel,
  disabled = false,
}: {
  readonly value: MoveIntent;
  readonly onChange: (intent: MoveIntent) => void;
  readonly canMove: boolean;
  readonly sourceLabel: string;
  readonly targetLabel: string | null;
  readonly disabled?: boolean;
}) {
  if (useProjectMoveDialog()?.sync) return null;
  const there = targetLabel ?? "the other machine";
  const options: ReadonlyArray<{
    readonly value: MoveIntent;
    readonly label: string;
    readonly detail: string;
    readonly off: boolean;
  }> = [
    {
      value: "copy",
      label: `Keep on ${sourceLabel}`,
      detail: `${there} runs workers. You can move it later.`,
      off: false,
    },
    {
      value: "move",
      label: `Move to ${there}`,
      detail: `Its conversation and threads continue on ${there}; ${sourceLabel} runs workers.`,
      off: !canMove,
    },
  ];
  return (
    <fieldset disabled={disabled} className="min-w-0" data-slot="handoff-coordinator">
      <legend className="mb-2 text-sm font-medium">Where should the coordinator run?</legend>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (next === "copy" || (next === "move" && canMove)) onChange(next);
        }}
        disabled={disabled}
        aria-label="Where should the coordinator run?"
      >
        {options.map((item) => (
          <label
            key={item.value}
            className={`flex min-w-0 items-start gap-3 rounded-lg border p-2.5 text-sm has-data-checked:border-primary has-data-checked:bg-primary/4 ${item.off ? "cursor-not-allowed opacity-60" : disabled ? "cursor-default" : "cursor-pointer"}`}
          >
            <span className="flex h-5 items-center">
              <Radio value={item.value} disabled={item.off} />
            </span>
            <span className="min-w-0 leading-5">
              <span className="block wrap-anywhere">{item.label}</span>
              <span className="block wrap-anywhere text-xs text-muted-foreground">
                {item.detail}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/** One line of "What comes along": ticked when it travels, a dash when it stays. */
export function AlongLine({
  stays = false,
  slot,
  children,
}: {
  readonly stays?: boolean;
  readonly slot?: string;
  readonly children: ReactNode;
}) {
  return (
    <li
      className="flex min-w-0 items-start gap-2.5"
      data-stays={stays || undefined}
      data-slot={slot}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground">
        {stays ? "–" : <CheckIcon className="size-4 text-primary" aria-label="comes along" />}
      </span>
      <span className={`min-w-0 wrap-anywhere leading-5 ${stays ? "text-muted-foreground" : ""}`}>
        {children}
      </span>
    </li>
  );
}

/** "What comes along": a short list instead of warnings, the details one click away. */
export function WhatComesAlong({ children }: { readonly children: ReactNode }) {
  return (
    <section className="min-w-0 text-sm" data-slot="handoff-along" aria-label="What comes along">
      <h3 className="mb-2 font-medium">What comes along</h3>
      <ul className="space-y-1.5 rounded-lg border p-3">{children}</ul>
    </section>
  );
}

/**
 * Details: the paths, the worktree notes and the rare file methods, folded away. Kept
 * mounted so their state survives closing it.
 */
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
        Details
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
    label: "Copy everything",
    detail: "Includes uncommitted and ignored files, and secrets unless you leave them out.",
  },
  {
    value: "clone",
    label: "Clone clean repositories from Git",
    detail: "Repositories with nothing uncommitted come from their remotes; the rest is copied.",
  },
  {
    value: "folder",
    label: "Git only, no file copy",
    detail:
      "Continues in a folder already saved there, which updates from origin. Always moves the coordinator.",
  },
];

/** The plain name of a way files travel, as Details lists it. */
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
          // Git carries the coordinator with the commits; it cannot keep it here.
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
                  {blocked ? "Only when the coordinator moves." : item.detail}
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
  const tail = useTailVisible(value);
  return (
    <div className="space-y-1.5 text-sm" data-slot={slot}>
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      <div className="flex min-w-0 gap-2">
        <div ref={tail.box} className="group/folder relative min-w-0 flex-1" data-slot="folder-box">
          <Input
            ref={tail.input}
            id={id}
            // Clipped, the path's cut-off start fades out under the "…", in every theme: the
            // mark needs no background of its own, so nothing shows through it.
            className="min-w-0 group-data-[clipped]/folder:[&_input]:[mask-image:linear-gradient(to_right,transparent_1.375rem,black_1.375rem)]"
            font="mono"
            value={value}
            title={value || undefined}
            readOnly={readOnly}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            aria-label={label}
            onFocus={tail.onFocus}
            onBlur={tail.onBlur}
            onChange={(event) => onChange?.(event.currentTarget.value)}
          />
          {/* A long path shows its end, where the folder names differ; this marks the cut. */}
          <span
            aria-hidden
            data-slot="folder-ellipsis"
            className="pointer-events-none absolute inset-y-px left-px hidden items-center ps-2.5 pe-0.5 font-mono text-base text-muted-foreground group-data-[clipped]/folder:flex sm:text-sm"
          >
            …
          </span>
        </div>
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

/**
 * Keeps the end of a long path in view while the field is not being edited, and marks the
 * box `data-clipped` when its start is cut off. Editing shows the field as typed.
 */
function useTailVisible(value: string) {
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const editing = useRef(false);
  const show = () => {
    const field = input.current;
    if (!field || editing.current) return;
    field.scrollLeft = field.scrollWidth;
    box.current?.toggleAttribute("data-clipped", field.scrollWidth > field.clientWidth + 1);
  };
  useLayoutEffect(show, [value]);
  useEffect(() => {
    const field = input.current;
    if (!field || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(show);
    observer.observe(field);
    return () => observer.disconnect();
  }, []);
  return {
    box,
    input,
    onFocus: () => {
      editing.current = true;
      box.current?.removeAttribute("data-clipped");
    },
    onBlur: () => {
      editing.current = false;
      show();
    },
  };
}
