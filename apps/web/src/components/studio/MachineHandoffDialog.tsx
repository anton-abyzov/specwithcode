import { ArrowRightIcon, CheckIcon, LaptopIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import type { HandoffFolderMethod } from "../../studio/folderCopy";
import { groupMachineFolders } from "../../studio/projectMachineFolders";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";
import { HandoffCopyActionsTarget } from "./HandoffCopyActions";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

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

export interface HandoffRememberMachine {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
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
      <span>Handoff</span>
    </Button>
  );
}

/** The transfer has one explicit destination and one commit point. */
export function MachineHandoffDialog({
  open,
  onOpenChange,
  sourceLabel,
  projectTitle,
  destinations,
  selected,
  onSelect,
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
  rememberMachine = null,
  method = "folder",
  onMethodChange,
  copyFlow,
  copyBusy = false,
}: {
  /** How the destination gets the files; the copy methods render `copyFlow` instead. */
  readonly method?: HandoffFolderMethod;
  readonly onMethodChange?: (method: HandoffFolderMethod) => void;
  readonly copyFlow?: ReactNode;
  readonly copyBusy?: boolean;
  readonly folderPicker?: ReactNode;
  readonly sourceChanges?: HandoffSourceChanges | null;
  readonly rememberMachine?: HandoffRememberMachine | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceLabel: string;
  readonly projectTitle: string;
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
  const complete = !copying && phase === "complete";
  // A reviewed preview stays editable until it is published: any change discards it.
  const frozen = busy || (preview !== null && !onBack);
  const chooser =
    onMethodChange && !complete ? (
      <HandoffMethodChooser
        sourceLabel={sourceLabel}
        method={method}
        onChange={onMethodChange}
        disabled={frozen}
      />
    ) : null;
  const [copyActionsTarget, setCopyActionsTarget] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{complete ? "Handoff ready" : "Continue on another machine"}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {complete
              ? `The coordinator on ${target?.label ?? "the destination"} has the code and context.`
              : `Move ${projectTitle} forward from ${sourceLabel}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {chooser}
          {copying ? (
            <HandoffCopyActionsTarget.Provider value={copyActionsTarget}>
              {copyFlow}
            </HandoffCopyActionsTarget.Provider>
          ) : complete ? (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm" role="status">
              <CheckIcon className="size-5 shrink-0" aria-hidden />
              <span>The new coordinator can continue in its own checkout.</span>
            </div>
          ) : (
            <>
              {!preview && (
                <SourceChangesNote changes={sourceChanges} sourceLabel={sourceLabel} busy={busy} />
              )}
              <fieldset disabled={frozen} className="min-w-0 space-y-2">
                <legend className="mb-2 text-sm font-medium">Continue on</legend>
                <RadioGroup
                  value={selected}
                  onValueChange={(value) => onSelect(String(value))}
                  disabled={frozen}
                  aria-label="Continue on"
                  className="gap-2"
                >
                  {destinations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {folderPicker
                        ? "No saved folder for this project on another machine yet. Choose one below."
                        : "Add this project on another connected machine to hand off work."}
                    </p>
                  ) : (
                    groupMachineFolders(destinations).map((machine) => (
                      <div key={machine.key} className="space-y-2" data-slot="handoff-machine">
                        <div className="mt-2 flex items-center gap-2 text-sm font-medium">
                          <LaptopIcon className="size-4" aria-hidden />
                          {machine.label}
                        </div>
                        {machine.folders.map((destination) => (
                          <label
                            key={destination.key}
                            data-slot="handoff-destination"
                            className={`grid min-w-0 grid-cols-[1.125rem_1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background ${
                              selected === destination.key
                                ? "border-primary bg-accent/40"
                                : "border-border"
                            } ${destination.unavailable ? "cursor-not-allowed opacity-60" : frozen ? "cursor-default" : "cursor-pointer hover:bg-accent/40"}`}
                          >
                            <span className="flex h-5 items-center justify-center">
                              <Radio
                                value={destination.key}
                                disabled={destination.unavailable !== null}
                              />
                            </span>
                            <span
                              data-slot="handoff-destination-icon"
                              className="flex h-5 items-center justify-center"
                            >
                              <LaptopIcon className="size-4 shrink-0" aria-hidden />
                            </span>
                            <span className="min-w-0 text-sm leading-5">
                              <span
                                data-slot="handoff-destination-label"
                                className="block wrap-anywhere font-medium"
                              >
                                {machine.folders.length > 1
                                  ? "Project folder"
                                  : "Saved project folder"}
                              </span>
                              <span className="block break-all text-xs text-muted-foreground">
                                {destination.folder}
                              </span>
                              {destination.unavailable && (
                                <span className="mt-1 block wrap-anywhere text-xs">
                                  {destination.unavailable}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    ))
                  )}
                </RadioGroup>
              </fieldset>
              {folderPicker}
              {rememberMachine && !preview && (
                <label
                  className="flex cursor-pointer items-start gap-3 py-1 text-sm"
                  data-slot="handoff-remember-machine"
                >
                  <span className="flex h-5 shrink-0 items-center">
                    <Checkbox
                      checked={rememberMachine.checked}
                      disabled={busy}
                      onCheckedChange={(value) => rememberMachine.onChange(value === true)}
                    />
                  </span>
                  <span className="min-w-0 wrap-anywhere leading-5">
                    Remember this machine
                    <span className="block text-xs text-muted-foreground">
                      Preselect {rememberMachine.label} for this project’s handoffs.
                    </span>
                  </span>
                </label>
              )}
              {preview ? (
                <div className="space-y-3 text-sm">
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 font-medium">
                    <span className="min-w-0 wrap-anywhere">{sourceLabel}</span>
                    <span className="flex h-5 items-center">
                      <ArrowRightIcon className="size-4 shrink-0" aria-hidden />
                    </span>
                    <span className="min-w-0 wrap-anywhere">{target?.label}</span>
                  </div>
                  <p className="text-muted-foreground">
                    {preview.repositories.length}{" "}
                    {preview.repositories.length === 1 ? "repository" : "repositories"},{" "}
                    {preview.messageCount} retained messages. Code advances in the selected project
                    folder. The coordinator continues there with this project’s context and retained
                    history.
                  </p>
                  <p className="text-muted-foreground">
                    Retained messages, project context and committed Git state continue. Native
                    provider sessions, live processes, credentials and uncommitted files are not
                    moved. Offline machines may have newer history that is unavailable.
                  </p>
                  <details className="rounded-lg border p-3">
                    <summary className="cursor-pointer font-medium">Code checkpoint</summary>
                    <ul className="mt-3 space-y-2">
                      {preview.repositories.map((repository) => (
                        <li
                          key={repository.relativePath}
                          className="flex items-baseline justify-between gap-3"
                        >
                          <span className="min-w-0 break-all text-xs">
                            {repository.relativePath === "."
                              ? projectTitle
                              : repository.relativePath}
                          </span>
                          <code className="shrink-0 text-xs text-muted-foreground">
                            {repository.head.slice(0, 12)}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <label className="flex cursor-pointer items-start gap-3 py-1">
                    <span className="flex h-5 shrink-0 items-center">
                      <Checkbox checked={consent} disabled={busy} onCheckedChange={onConsent} />
                    </span>
                    <span className="min-w-0 wrap-anywhere leading-5">
                      Publish these commits to their configured Git remotes and send the project
                      context to {target?.label}. Join the selected destination to this project,
                      retaining its history and replacing its coordinator with this continuation.
                    </span>
                  </label>
                </div>
              ) : null}
            </>
          )}
          {!copying && error && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
              {error}
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
                ? "Checking code and machine access…"
                : "Transferring code and context…"}
            </p>
          )}
        </DialogPanel>
        <DialogFooter className={copying ? "shrink-0 flex-row flex-wrap items-end" : undefined}>
          {copying ? (
            <>
              <div
                ref={setCopyActionsTarget}
                className="min-w-0 flex-1"
                data-slot="copy-actions-outlet"
              />
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </>
          ) : complete ? (
            <Button
              className="h-auto min-h-9 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere py-2 sm:h-auto sm:min-h-8"
              onClick={onOpenDestination}
            >
              Open coordinator on {target?.label}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {preview && onBack && (
                <Button variant="outline" disabled={busy} onClick={onBack}>
                  Back
                </Button>
              )}
              {preview ? (
                <Button
                  className="h-auto min-h-9 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere py-2 sm:h-auto sm:min-h-8"
                  disabled={busy || !consent || !target || !!target.unavailable}
                  onClick={onContinue}
                >
                  {busy ? "Transferring…" : `Continue on ${target?.label ?? "selected machine"}`}
                </Button>
              ) : (
                <Button disabled={busy || !target || !!target.unavailable} onClick={onReview}>
                  {busy ? "Checking…" : "Review handoff"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const METHODS: ReadonlyArray<{
  readonly value: HandoffFolderMethod;
  readonly label: (source: string) => string;
  readonly detail: string;
}> = [
  {
    value: "copy",
    label: (source) => `Copy from ${source}`,
    detail:
      "Copies the folder as it is, with uncommitted and ignored files. Secret-like files stay behind.",
  },
  {
    value: "folder",
    label: () => "Use the folder as it is",
    detail: "Publishes committed work to Git remotes and advances an existing checkout.",
  },
  {
    value: "clone",
    label: () => "Clone from origin per repository",
    detail: "Copies the folder, but clones clean repositories from their remotes instead.",
  },
];

function HandoffMethodChooser({
  sourceLabel,
  method,
  onChange,
  disabled,
}: {
  readonly sourceLabel: string;
  readonly method: HandoffFolderMethod;
  readonly onChange: (method: HandoffFolderMethod) => void;
  readonly disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2" data-slot="handoff-method">
      <legend className="mb-2 text-sm font-medium">Files</legend>
      <RadioGroup
        value={method}
        onValueChange={(value) => onChange(value as HandoffFolderMethod)}
        disabled={disabled}
        aria-label="Files"
        className="gap-2"
      >
        {METHODS.map((item) => (
          <label
            key={item.value}
            className={`grid min-w-0 grid-cols-[1.125rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg border p-3 text-sm ${
              method === item.value ? "border-primary bg-accent/40" : "border-border"
            } ${disabled ? "cursor-default" : "cursor-pointer hover:bg-accent/40"}`}
          >
            <span className="flex h-5 items-center justify-center">
              <Radio value={item.value} />
            </span>
            <span className="min-w-0 leading-5">
              <span className="block wrap-anywhere font-medium">{item.label(sourceLabel)}</span>
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
        Save and commit your changes first. We’ll check both checkouts before transferring code and
        context.
      </p>
    );
  if (changes.state === "clean")
    return (
      <p className="text-sm text-muted-foreground" data-slot="handoff-source-changes">
        No uncommitted changes on {sourceLabel}. We’ll check both checkouts before transferring code
        and context.
      </p>
    );
  return (
    <div
      className="space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm"
      data-slot="handoff-source-changes"
    >
      <p className="wrap-anywhere">
        {changes.fileCount === 1 ? "1 uncommitted file" : `${changes.fileCount} uncommitted files`}{" "}
        on {sourceLabel}. Only committed work moves; commit before handing off.
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
