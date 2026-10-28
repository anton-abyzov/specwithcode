import { ArrowRightIcon, CheckIcon, ChevronDownIcon, LaptopIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import type { HandoffFolderMethod } from "../../studio/folderCopy";
import { cn } from "../../lib/utils";
import { MachineOptionRows, type MachineOption } from "../handoff/MachineOptionRows";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { HandoffWorkspaceSummary, type HandoffWorkspaceContext } from "./HandoffWorkspaceSummary";
import { HandoffCopyActionsTarget } from "./HandoffCopyActions";
import {
  FilesTravelChoice,
  FolderField,
  MoreOptions,
  MoveIntentToggle,
  ProjectMoveDialog,
  type MoveIntent,
} from "./ProjectMoveOptions";
import { plainHandoffError } from "./handoffErrors";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export type { MoveIntent };

export interface HandoffDestination {
  readonly key: string;
  readonly environmentId?: string;
  readonly label: string;
  readonly folder: string;
  readonly unavailable: string | null;
}

/** Uncommitted work in the source checkout; committed Git state is what moves. */
export interface HandoffSourceChanges {
  readonly state: "unknown" | "clean" | "dirty";
  readonly fileCount: number;
  readonly committing: boolean;
  readonly error: string | null;
  /** Commits every change with a generated message; null when this connection cannot. */
  readonly onCommit: (() => void) | null;
}

export interface HandoffPreview {
  readonly repositories: ReadonlyArray<{ readonly relativePath: string; readonly head: string }>;
  readonly messageCount: number;
}

export function MachineHandoffButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="sm"
      className={cn("h-6 gap-1.5 px-2 text-xs sm:h-6 sm:text-xs", className)}
      data-slot="handoff-trigger"
      aria-label="Continue this project on another machine"
    >
      <LaptopIcon className="size-3.5 shrink-0" aria-hidden />
      <span>Move project</span>
    </Button>
  );
}

/** The transfer has one explicit destination and one commit point. */
export function MachineHandoffDialog({
  open,
  onOpenChange,
  sourceLabel,
  projectTitle,
  workspaceContext,
  destinationCheckout,
  destinationWorktreeStorage,
  destinations,
  selected,
  onSelect,
  machines = [],
  machine = null,
  onMachineChange,
  intent = "move",
  onIntentChange,
  preview,
  phase,
  error,
  consent,
  onConsent,
  onReview,
  onContinue,
  onOpenDestination,
  onRestart,
  onBack,
  folderPicker,
  sourceChanges = null,
  method = "folder",
  onMethodChange,
  copyFlow,
  copyBusy = false,
  copyLocked,
  copyDoneOn = null,
  machinesLoading = false,
}: {
  /** The other machines' first status read has not settled: their list shows a loading row. */
  readonly machinesLoading?: boolean;
  /** How the destination gets the files; the copy methods render `copyFlow` instead. */
  readonly method?: HandoffFolderMethod;
  readonly onMethodChange?: (method: HandoffFolderMethod) => void;
  readonly copyFlow?: ReactNode;
  readonly copyBusy?: boolean;
  /**
   * Whether the copy flow must keep the dialog open. Measuring, comparing and copying
   * keep running on the machines, so only short critical steps lock it. Defaults to `copyBusy`.
   */
  readonly copyLocked?: boolean;
  /** The machine a finished copy is on: the title says where the project is now. */
  readonly copyDoneOn?: string | null;
  /** Saves a folder on `machine` for the Git move; shown when it has none, or on Browse…. */
  readonly folderPicker?: ReactNode;
  readonly sourceChanges?: HandoffSourceChanges | null;
  /** Move continues the project there; copy only sends files. Titles the dialog. */
  readonly intent?: MoveIntent;
  readonly onIntentChange?: (intent: MoveIntent) => void;
  /** The machines the Git move can choose from, and the chosen one. */
  readonly machines?: ReadonlyArray<MachineOption>;
  readonly machine?: string | null;
  readonly onMachineChange?: (machine: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceLabel: string;
  readonly projectTitle: string;
  readonly workspaceContext?: HandoffWorkspaceContext;
  readonly destinationCheckout?: string | null;
  readonly destinationWorktreeStorage?: string | null;
  /** Saved project folders on other machines; `selected` is one of their keys. */
  readonly destinations: ReadonlyArray<HandoffDestination>;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  readonly preview: HandoffPreview | null;
  readonly phase: "choose" | "checking" | "review" | "transferring" | "complete";
  readonly error: string | null;
  readonly consent: boolean;
  readonly onConsent: (value: boolean) => void;
  readonly onReview: () => void;
  readonly onContinue: () => void;
  readonly onOpenDestination: () => void;
  readonly onRestart?: (() => void) | undefined;
  /** Drops an unpublished preview so every earlier choice can change; absent once published. */
  readonly onBack?: (() => void) | undefined;
}) {
  const target = destinations.find((item) => item.key === selected);
  const copying = copyFlow !== undefined && method !== "folder";
  const busy = copying ? copyBusy : phase === "checking" || phase === "transferring";
  const locked = copying ? (copyLocked ?? copyBusy) : busy;
  const complete = !copying && phase === "complete";
  // The Git review hides the choices; Back discards it to change them.
  const reviewing = !copying && !complete && preview !== null;
  const machineLabel =
    machines.find((item) => item.value === machine)?.label ?? target?.label ?? null;
  const targetLabel = target?.label ?? machineLabel ?? "the other machine";
  const [copyActionsTarget, setCopyActionsTarget] = useState<HTMLDivElement | null>(null);
  const close = () => {
    if (!locked) onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!locked) onOpenChange(value);
      }}
    >
      <DialogPopup showCloseButton={!locked} className="w-full sm:max-w-lg">
        <ProjectMoveDialog
          value={{
            method,
            onMethodChange: (next) => onMethodChange?.(next),
            methodDisabled: busy || !onMethodChange || complete,
            intent,
            close: locked ? null : close,
            machinesLoading,
          }}
        >
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">
              {/* A copy of files only leaves the project here: its title says copied, not on. */}
              {copying && copyDoneOn
                ? `${projectTitle} ${intent === "copy" ? "is copied to" : "is on"} ${copyDoneOn}`
                : complete
                  ? `${projectTitle} is on ${targetLabel}`
                  : `${intent === "copy" ? "Copy" : "Move"} ${projectTitle}`}
            </DialogTitle>
            {/* A finished copy says what happened in its own body. */}
            {!(copying && copyDoneOn) && (
              <DialogDescription className="wrap-anywhere">
                {complete
                  ? `The coordinator now runs on ${targetLabel}.`
                  : `From ${sourceLabel} to another machine. Nothing there is replaced without asking.`}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            {!copying && !complete && workspaceContext && (
              <HandoffWorkspaceSummary
                source={workspaceContext}
                destinationFolder={target?.folder}
                destinationCheckout={destinationCheckout}
                destinationWorktreeStorage={destinationWorktreeStorage}
              />
            )}
            {copying ? (
              <HandoffCopyActionsTarget.Provider value={copyActionsTarget}>
                {copyFlow}
              </HandoffCopyActionsTarget.Provider>
            ) : complete ? (
              <div
                className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm"
                role="status"
              >
                <CheckIcon className="size-5 shrink-0" aria-hidden />
                <span>It continues in its own checkout there, with this project’s history.</span>
              </div>
            ) : reviewing ? (
              <GitReview
                sourceLabel={sourceLabel}
                targetLabel={targetLabel}
                projectTitle={projectTitle}
                preview={preview}
                consent={consent}
                onConsent={onConsent}
                busy={busy}
              />
            ) : (
              <GitWhere
                sourceLabel={sourceLabel}
                destinations={destinations}
                selected={selected}
                onSelect={onSelect}
                machines={machines}
                machine={machine}
                machineLabel={machineLabel}
                onMachineChange={onMachineChange}
                onIntentChange={onIntentChange}
                folderPicker={folderPicker}
                sourceChanges={sourceChanges}
                busy={busy}
                loading={machinesLoading}
              />
            )}
            {!copying && error && (
              <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
                {plainHandoffError(error, "move", {
                  source: sourceLabel,
                  destination: targetLabel,
                })}
              </p>
            )}
            {!copying && error && onRestart && (
              <Button variant="outline" onClick={onRestart}>
                Review the updated source
              </Button>
            )}
            {!copying && busy && (
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {phase === "checking"
                  ? "Checking both machines…"
                  : `Pushing commits and starting ${projectTitle} on ${targetLabel}…`}
              </p>
            )}
          </DialogPanel>
          <DialogFooter className={copying ? "shrink-0 flex-row flex-wrap items-end" : undefined}>
            {copying ? (
              <div
                ref={setCopyActionsTarget}
                className="min-w-0 flex-1"
                data-slot="copy-actions-outlet"
              />
            ) : complete ? (
              <Button
                className="h-auto min-h-9 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere py-2 sm:h-auto sm:min-h-8"
                onClick={onOpenDestination}
              >
                Open on {targetLabel}
              </Button>
            ) : reviewing ? (
              <>
                {onBack && (
                  <Button variant="ghost" className="sm:mr-auto" disabled={busy} onClick={onBack}>
                    Back
                  </Button>
                )}
                <Button
                  className="h-auto min-h-9 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere py-2 sm:h-auto sm:min-h-8"
                  disabled={busy || !consent || !target || !!target.unavailable}
                  onClick={onContinue}
                >
                  {busy ? "Moving…" : `Move to ${target?.label ?? "selected machine"}`}
                </Button>
              </>
            ) : (
              <>
                {!busy && !machineLabel && (
                  <span
                    className="min-w-0 self-center text-xs text-muted-foreground sm:mr-auto"
                    data-slot="handoff-setup-hint"
                  >
                    Choose a machine above.
                  </span>
                )}
                <Button variant="outline" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                {/* One primary, filled even while off: never two outline buttons side by side. */}
                <Button
                  className="min-w-0 max-w-full shrink"
                  disabled={busy || !target || !!target.unavailable}
                  onClick={onReview}
                >
                  {busy ? "Checking…" : machineLabel ? `Move to ${machineLabel}` : "Move"}
                </Button>
              </>
            )}
          </DialogFooter>
        </ProjectMoveDialog>
      </DialogPopup>
    </Dialog>
  );
}

/** Screen 1 when files travel through Git: the move always continues there. */
function GitWhere({
  sourceLabel,
  destinations,
  selected,
  onSelect,
  machines,
  machine,
  machineLabel,
  onMachineChange,
  onIntentChange,
  folderPicker,
  sourceChanges,
  busy,
  loading,
}: {
  readonly loading: boolean;
  readonly sourceLabel: string;
  readonly destinations: ReadonlyArray<HandoffDestination>;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  readonly machines: ReadonlyArray<MachineOption>;
  readonly machine: string | null;
  readonly machineLabel: string | null;
  readonly onMachineChange: ((machine: string) => void) | undefined;
  readonly onIntentChange: ((intent: MoveIntent) => void) | undefined;
  readonly folderPicker: ReactNode;
  readonly sourceChanges: HandoffSourceChanges | null;
  readonly busy: boolean;
}) {
  const saved = destinations.filter((item) => machine !== null && item.environmentId === machine);
  const current = saved.find((item) => item.key === selected) ?? null;
  // Browse… swaps the saved folder for the picker until a folder is saved or kept.
  const [changing, setChanging] = useState<string | null>(null);
  const picking = folderPicker != null && (saved.length === 0 || changing === selected);
  return (
    <div className="flex flex-col gap-4">
      <MoveIntentToggle
        value="move"
        canMove
        disabled={busy || !onIntentChange}
        onChange={(next) => onIntentChange?.(next)}
      />
      <SourceChangesNote changes={sourceChanges} sourceLabel={sourceLabel} busy={busy} />
      <fieldset disabled={busy} className="min-w-0">
        <legend className="mb-2 text-sm font-medium">Machine</legend>
        {machines.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">
            No other machine is connected. Pair one in Settings › Connections.
          </p>
        ) : (
          <MachineOptionRows
            aria-label="Machine"
            options={machines}
            value={machine}
            disabled={busy}
            loading={loading}
            onChange={(value) => onMachineChange?.(value)}
          />
        )}
      </fieldset>
      {machine && machineLabel ? (
        picking ? (
          <div className="space-y-2" data-slot="handoff-folder">
            {folderPicker}
            {saved.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setChanging(null)}>
                Keep the saved folder
              </Button>
            )}
          </div>
        ) : saved.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add this project on {machineLabel} first, then move it there.
          </p>
        ) : (
          <SavedFolderField
            machineLabel={machineLabel}
            saved={saved}
            current={current}
            onSelect={onSelect}
            busy={busy}
            onBrowse={folderPicker != null ? () => setChanging(selected) : undefined}
          />
        )
      ) : null}
      <MoreOptions defaultOpen disabled={busy}>
        <FilesTravelChoice />
      </MoreOptions>
    </div>
  );
}

function SavedFolderField({
  machineLabel,
  saved,
  current,
  onSelect,
  busy,
  onBrowse,
}: {
  readonly machineLabel: string;
  readonly saved: ReadonlyArray<HandoffDestination>;
  readonly current: HandoffDestination | null;
  readonly onSelect: (key: string) => void;
  readonly busy: boolean;
  readonly onBrowse: (() => void) | undefined;
}) {
  const reason = current?.unavailable ? (
    <p className="wrap-anywhere text-xs text-muted-foreground">{current.unavailable}</p>
  ) : null;
  if (saved.length === 1)
    return (
      <FolderField
        slot="handoff-folder"
        machineLabel={machineLabel}
        value={saved[0]!.folder}
        readOnly
        disabled={busy}
        onBrowse={onBrowse}
      >
        {reason}
      </FolderField>
    );
  return (
    <div className="space-y-1.5 text-sm" data-slot="handoff-folder">
      <span className="block font-medium">Folder on {machineLabel}</span>
      <div className="flex min-w-0 gap-2">
        <Select
          value={current?.key ?? null}
          disabled={busy}
          onValueChange={(value) => {
            if (typeof value === "string" && value) onSelect(value);
          }}
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label={`Folder on ${machineLabel}`}>
            <SelectValue placeholder="Choose a saved folder">
              {current ? <span className="truncate font-mono">{current.folder}</span> : null}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {saved.map((item) => (
              <SelectItem key={item.key} value={item.key} disabled={item.unavailable !== null}>
                <span className="font-mono">{item.folder}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {onBrowse && (
          <Button type="button" variant="outline" disabled={busy} onClick={onBrowse}>
            Browse…
          </Button>
        )}
      </div>
      {reason}
    </div>
  );
}

/** Screen 3 for Git: what moves, the commits behind Details, and one explicit consent. */
function GitReview({
  sourceLabel,
  targetLabel,
  projectTitle,
  preview,
  consent,
  onConsent,
  busy,
}: {
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly projectTitle: string;
  readonly preview: HandoffPreview;
  readonly consent: boolean;
  readonly onConsent: (value: boolean) => void;
  readonly busy: boolean;
}) {
  const repositories = preview.repositories.length;
  return (
    <div className="space-y-3 text-sm" data-slot="handoff-git-review">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 font-medium">
        <span className="min-w-0 wrap-anywhere">{sourceLabel}</span>
        <span className="flex h-5 items-center">
          <ArrowRightIcon className="size-4 shrink-0" aria-label="to" />
        </span>
        <span className="min-w-0 wrap-anywhere">{targetLabel}</span>
      </div>
      <p className="text-muted-foreground">
        {repositories} {repositories === 1 ? "repository" : "repositories"}, {preview.messageCount}{" "}
        {preview.messageCount === 1 ? "message" : "messages"}. Committed work only. Uncommitted
        files, sign-ins and running processes stay here.
      </p>
      <Collapsible data-slot="handoff-commits">
        <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Details
          <ChevronDownIcon
            className="size-3.5 transition-transform group-data-panel-open:rotate-180"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          <ul className="mt-2 space-y-2 rounded-lg border p-3">
            {preview.repositories.map((repository) => (
              <li
                key={repository.relativePath}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 break-all text-xs">
                  {repository.relativePath === "." ? projectTitle : repository.relativePath}
                </span>
                <code className="shrink-0 text-xs text-muted-foreground">
                  {repository.head.slice(0, 12)}
                </code>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
      <label className="flex cursor-pointer items-start gap-3 py-1">
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox checked={consent} disabled={busy} onCheckedChange={onConsent} />
        </span>
        <span className="min-w-0 wrap-anywhere leading-5">
          Push these commits to their remotes and continue the project on {targetLabel}.
        </span>
      </label>
    </div>
  );
}

function SourceChangesNote({
  changes,
  sourceLabel,
  busy,
}: {
  readonly changes: HandoffSourceChanges | null;
  readonly sourceLabel: string;
  readonly busy: boolean;
}) {
  if (!changes || changes.state === "unknown")
    return (
      <p className="text-sm text-muted-foreground" data-slot="handoff-source-changes">
        Only committed work moves through Git. Commit your changes first.
      </p>
    );
  if (changes.state === "clean")
    return (
      <p className="text-sm text-muted-foreground" data-slot="handoff-source-changes">
        No uncommitted changes on {sourceLabel}.
      </p>
    );
  return (
    <div
      className="space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm"
      data-slot="handoff-source-changes"
    >
      <p className="wrap-anywhere">
        {changes.fileCount === 1 ? "1 uncommitted file" : `${changes.fileCount} uncommitted files`}{" "}
        on {sourceLabel}. Only committed work moves through Git.
      </p>
      {changes.onCommit && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || changes.committing}
          onClick={changes.onCommit}
        >
          {changes.committing ? "Committing…" : "Commit for me"}
        </Button>
      )}
      {changes.error && (
        <p role="alert" className="wrap-anywhere text-destructive-foreground">
          {changes.error}
        </p>
      )}
    </div>
  );
}
