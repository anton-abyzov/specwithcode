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
import { displayFolder } from "../../lib/displayFolder";
import {
  existingCopyLine,
  pickedHolding,
  SEND_CHOICES,
  sendPlan,
  type MachineHolding,
} from "../../studio/sendToMachine";
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
  /** What the chosen machine already holds of this project, for Copy or Move and the plan. */
  readonly send?: SendFacts | null;
}

/** The chosen machine's holding and the names the plan sentence needs. */
export interface SendFacts {
  readonly holding: MachineHolding<{ readonly id: string; readonly workspaceRoot: string }>;
  /** The copy picked among several on that machine; null until one is. */
  readonly picked: string | null;
  readonly onPick: (id: string) => void;
  /** The machine Main is on now. */
  readonly mainLabel: string;
  /** Uncommitted files here; null when unknown. */
  readonly localFiles: number | null;
}

export const ProjectMoveDialog = createContext<ProjectMoveDialogContext | null>(null);

export function useProjectMoveDialog() {
  return useContext(ProjectMoveDialog);
}

/**
 * Copy or Move, the one difference between sending a copy and handing the project over.
 * Copy runs `copy-only` and the copy takes work from Main; Move runs `copy-and-move`. Above
 * the choice, what the machine already holds; below it, the plan in one sentence. A machine
 * that holds Main has nothing to move to, so it shows no choice; a sync shows nothing.
 */
export function CoordinatorChoice({
  value,
  onChange,
  canMove,
  targetLabel,
  disabled = false,
}: {
  readonly value: MoveIntent;
  readonly onChange: (intent: MoveIntent) => void;
  readonly canMove: boolean;
  /** The machine sending; kept for callers, the choice names only the destination. */
  readonly sourceLabel: string;
  readonly targetLabel: string | null;
  readonly disabled?: boolean;
}) {
  const dialog = useProjectMoveDialog();
  const send = targetLabel ? (dialog?.send ?? null) : null;
  const holding = send ? pickedHolding(send.holding, send.picked) : null;
  const toMain = holding?.kind === "main";
  // Picking the copy that is Main leaves nothing to move: the choice falls back to Copy.
  useEffect(() => {
    if (toMain && value === "move") onChange("copy");
  }, [toMain, value, onChange]);
  if (dialog?.sync) return null;
  const there = targetLabel ?? "the other machine";
  const line = send && targetLabel ? existingCopyLine({ there, holding: send.holding }) : null;
  const plan =
    send && holding && targetLabel
      ? sendPlan({
          choice: toMain ? "copy" : value,
          there,
          main: send.mainLabel,
          holding,
          way: dialog?.method === "folder" ? "git" : "copy",
          localFiles: send.localFiles,
        })
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-slot="handoff-coordinator">
      {line && (
        <p className="text-sm text-muted-foreground" data-slot="send-existing-copy">
          {line}
        </p>
      )}
      {send?.holding.kind === "several" && (
        <CopyPicker
          copies={send.holding.copies}
          mainId={send.holding.mainId}
          picked={send.picked}
          onPick={send.onPick}
          disabled={disabled}
        />
      )}
      {toMain ? null : (
        <fieldset disabled={disabled} className="min-w-0">
          <legend className="mb-2 text-sm font-medium">Copy or move</legend>
          <RadioGroup
            value={value}
            onValueChange={(next) => {
              if (next === "copy" || (next === "move" && canMove)) onChange(next);
            }}
            disabled={disabled}
            aria-label="Copy or move"
          >
            {(["copy", "move"] as const).map((choice) => {
              const off = choice === "move" && !canMove;
              return (
                <label
                  key={choice}
                  data-send-choice={choice}
                  className={`flex min-w-0 items-start gap-3 rounded-lg border p-2.5 text-sm has-data-checked:border-primary has-data-checked:bg-primary/4 ${off ? "cursor-not-allowed opacity-60" : disabled ? "cursor-default" : "cursor-pointer"}`}
                >
                  <span className="flex h-5 items-center">
                    <Radio value={choice} disabled={off} />
                  </span>
                  <span className="min-w-0 leading-5">
                    <span className="block wrap-anywhere">{SEND_CHOICES[choice].label(there)}</span>
                    <span className="block wrap-anywhere text-xs text-muted-foreground">
                      {SEND_CHOICES[choice].detail}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        </fieldset>
      )}
      {plan && (
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm" data-slot="send-plan">
          {plan}
        </p>
      )}
    </div>
  );
}

/** Several copies of this project on the chosen machine: the person picks the one to send to. */
function CopyPicker({
  copies,
  mainId,
  picked,
  onPick,
  disabled,
}: {
  readonly copies: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>;
  readonly mainId: string | null;
  readonly picked: string | null;
  readonly onPick: (id: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0" data-slot="send-copy-picker">
      <legend className="mb-2 text-sm font-medium">Copy to send to</legend>
      <RadioGroup
        value={picked ?? ""}
        onValueChange={(next) => {
          if (typeof next === "string" && next) onPick(next);
        }}
        disabled={disabled}
        aria-label="Copy to send to"
      >
        {copies.map((copy) => (
          <label
            key={copy.id}
            className="flex min-w-0 items-center gap-3 rounded-lg border p-2.5 text-sm has-data-checked:border-primary has-data-checked:bg-primary/4"
          >
            <Radio value={copy.id} />
            <span className="min-w-0 wrap-anywhere font-mono text-xs">
              {displayFolder(copy.workspaceRoot)}
            </span>
            {copy.id === mainId && (
              <span className="ms-auto text-xs text-muted-foreground">Main</span>
            )}
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
