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
import { useTx } from "../../i18n";
import type { MainOffer } from "../../studio/makeMain";
import {
  existingCopyLine,
  otherProjectNote,
  pickedHolding,
  sendPlan,
  type MachineHolding,
} from "../../studio/sendToMachine";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";

/** What the dialog does: Main moves there (Git only, "Make X main"), or only files go there. */
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
  /** What the chosen machine already holds of this project, where Main is, and the plan. */
  readonly send?: SendFacts | null;
  /** "Continue the coordinator on {machine}" for the finished copy, on its done screen; null where there is none. */
  readonly makeMain?: MakeMainAction | null;
}

/** The chosen machine's holding and the names the plan sentence needs. */
export interface SendFacts {
  readonly holding: MachineHolding<{ readonly id: string; readonly workspaceRoot: string }>;
  /** The copy picked among several on that machine; null until one is. */
  readonly picked: string | null;
  readonly onPick: (id: string) => void;
  /** The machine Main is on now; null when nothing in sight names it. */
  readonly mainLabel: string | null;
  /** Uncommitted files here; null when unknown. */
  readonly localFiles: number | null;
  /**
   * Set when the chosen copy belongs to a project the source is not linked to. `main` is
   * that project's Main machine, null when unknown. Copying then sends files only: Main
   * never moves and the two are never linked from this dialog.
   */
  readonly otherProject?: { readonly main: string | null } | null;
}

/** The done screen's switch: the offer as the machine menu shows it, and what a click runs. */
export interface MakeMainAction {
  readonly offer: MainOffer;
  readonly run: () => void;
}

export const ProjectMoveDialog = createContext<ProjectMoveDialogContext | null>(null);

export function useProjectMoveDialog() {
  return useContext(ProjectMoveDialog);
}

/**
 * Whether Main may move to the chosen copy from this dialog. Not to the copy that is Main
 * already, and never into a project the source is not linked to: that would move this
 * machine's Main into another project and relink its copy without anyone asking for it.
 */
export function moveRefusal(send: SendFacts | null | undefined): "main" | "other-project" | null {
  if (!send) return null;
  if (send.otherProject) return "other-project";
  return pickedHolding(send.holding, send.picked).kind === "main" ? "main" : null;
}

/**
 * Under the machines: what the chosen one already holds, the copy to pick among several,
 * and the plan in one sentence. It asks nothing about Main: a copy keeps Main where it is,
 * and `move` (Git only, or a move asked for with "Make X main") says where it goes. A source
 * that is not linked to the destination copy's project is told so here. A sync shows nothing.
 */
export function SendSummary({
  move,
  sourceLabel,
  targetLabel,
  disabled = false,
}: {
  /** Main moves to the chosen machine. */
  readonly move: boolean;
  readonly sourceLabel: string;
  readonly targetLabel: string | null;
  readonly disabled?: boolean;
}) {
  const tx = useTx();
  const dialog = useProjectMoveDialog();
  const send = targetLabel ? (dialog?.send ?? null) : null;
  if (dialog?.sync || !send || !targetLabel) return null;
  const holding = pickedHolding(send.holding, send.picked);
  const other = send.otherProject ?? null;
  const refused = move ? moveRefusal(send) : null;
  // Git only into a copy: nothing is copied and the plan names that copy's folder, so the
  // "only what it is missing is copied" line would contradict the screen.
  const gitIntoCopy = move && dialog?.method === "folder" && holding.kind === "copy";
  const line = gitIntoCopy ? null : existingCopyLine({ there: targetLabel, holding: send.holding });
  const note = other
    ? refused
      ? {
          text: "The coordinator cannot continue on {machine}: it has this repository as a separate project. Link it first.",
          values: { source: sourceLabel, machine: targetLabel },
        }
      : otherProjectNote({ source: sourceLabel, there: targetLabel, main: other.main })
    : null;
  // A refused move has no plan. The copy picked among several that is Main says why.
  const plan = refused
    ? refused === "main" && send.holding.kind === "several"
      ? existingCopyLine({ there: targetLabel, holding })
      : null
    : sendPlan({
        choice: move ? "move" : "copy",
        there: targetLabel,
        main: other ? other.main : send.mainLabel,
        holding,
        way: dialog?.method === "folder" ? "git" : "copy",
        localFiles: send.localFiles,
      });
  return (
    <div className="flex min-w-0 flex-col gap-2" data-slot="send-summary">
      {line && (
        <p className="text-sm text-muted-foreground" data-slot="send-existing-copy">
          {line}
        </p>
      )}
      {send.holding.kind === "several" && (
        <CopyPicker
          copies={send.holding.copies}
          mainId={send.holding.mainId}
          picked={send.picked}
          onPick={send.onPick}
          disabled={disabled}
        />
      )}
      {note && (
        <p
          role="note"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm wrap-anywhere"
          data-slot="send-unlinked"
        >
          {tx(note.text, note.values)}
        </p>
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
              <span className="ms-auto text-xs text-muted-foreground">Coordinator</span>
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
    value: "clone",
    label: "Download from GitHub (recommended)",
    detail:
      "Repositories new there download from GitHub or their Git host; one with unpushed commits or stashes is copied whole. Uncommitted and ignored files, and secrets unless you leave them out, come from this machine.",
  },
  {
    value: "copy",
    label: "Copy everything",
    detail:
      "Also brings unpushed commits, local branches and stashes. Slower for large repositories.",
  },
  {
    value: "folder",
    label: "Git only, no file copy",
    detail:
      "Continues in a folder already saved there, which updates from origin. Always moves the coordinator there.",
  },
];

/** The plain name of a way files travel, as Details lists it. */
export const methodLabel = (method: HandoffFolderMethod): string =>
  METHODS.find((item) => item.value === method)?.label ?? "";

/** How files travel. Reads the dialog's method; renders nothing outside the dialog. */
export function FilesTravelChoice() {
  const tx = useTx();
  const dialog = useProjectMoveDialog();
  if (!dialog) return null;
  const { method, onMethodChange, methodDisabled } = dialog;
  // Git only moves Main, so it is off where Main may not move (`moveRefusal`).
  const refused = moveRefusal(dialog.send);
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
          const blocked = item.value === "folder" && refused !== null;
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
                  {blocked
                    ? refused === "main"
                      ? tx("Not available: that machine already has the coordinator.")
                      : tx("Not available: it would move the coordinator into a separate project.")
                    : item.detail}
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
