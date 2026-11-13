import { useState, type ReactNode } from "react";
import type { EnvironmentId, FolderCopyMode } from "@specweave-studio/contracts";
import { copiedProjectFolder } from "../../studio/folderCopy";
import { MachineOptionRows, type MachineOption } from "../handoff/MachineOptionRows";
import { Checkbox } from "../ui/checkbox";
import { HandoffCopyScope, type useCopyScope } from "./HandoffCopyScope";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import {
  AlongLine,
  CoordinatorChoice,
  FilesTravelChoice,
  FolderField,
  MoreOptions,
  useProjectMoveDialog,
  WhatComesAlong,
} from "./ProjectMoveOptions";

/** What the setup screen lists as coming along, and the technical rows for Details. */
export interface CopyAlong {
  /** Uncommitted files in the source; null when the source has not reported them. */
  readonly uncommittedFiles: number | null;
  /** Secret files (.env, keys) travel unless this is off; on by default. */
  readonly includeSecrets: boolean;
  readonly onIncludeSecretsChange: (include: boolean) => void;
  /** The Workspace locations rows, shown under Details. */
  readonly details?: ReactNode;
}

const lastSegment = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

export interface CopyMachine {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly unavailable: string | null;
  readonly worktreeStorage?: string | null;
  /** The machine writes `~/` secret files (.NET user secrets) into its home folder. */
  readonly homeSecretFiles?: boolean;
  readonly memoryThreeWay?: boolean;
}

export const copyMachineOptions = (machines: ReadonlyArray<CopyMachine>): MachineOption[] =>
  machines.map((entry) => ({
    value: entry.id,
    label: entry.label,
    tone: entry.unavailable ? "off" : "ready",
    reason: entry.unavailable,
    disabled: entry.unavailable !== null,
  }));

/**
 * Screen 1 of the copy: the machine, the folder there, what comes along, where the
 * coordinator runs, and Details for the paths and the rare file methods.
 */
export function HandoffCopySetup({
  machines,
  machine,
  onMachineChange,
  targetLabel,
  sourceLabel,
  sourceRoot = "",
  folder,
  onFolderChange,
  findingHome,
  projectRelativePath,
  mode,
  onModeChange,
  canMove,
  chooseFirst,
  onChooseFirstChange,
  disabled,
  folderDisabled = disabled,
  scope,
  scopeDisabled = disabled,
  along,
}: {
  readonly along?: CopyAlong;
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly machine: EnvironmentId | null;
  readonly onMachineChange: (machine: EnvironmentId) => void;
  readonly targetLabel: string;
  readonly sourceLabel: string;
  /** The source project folder, named in What comes along when no copy root is known. */
  readonly sourceRoot?: string;
  readonly folder: string;
  readonly onFolderChange: (folder: string) => void;
  readonly findingHome: boolean;
  readonly projectRelativePath: string;
  readonly mode: FolderCopyMode;
  readonly onModeChange: (mode: FolderCopyMode) => void;
  readonly canMove: boolean;
  readonly chooseFirst: boolean;
  readonly onChooseFirstChange: (chooseFirst: boolean) => void;
  readonly disabled: boolean;
  /** Lets only the folder be edited, as when saving a new folder while choosing. */
  readonly folderDisabled?: boolean;
  /** What to copy from the source; shown under Details. */
  readonly scope?: ReturnType<typeof useCopyScope>;
  readonly scopeDisabled?: boolean;
}) {
  const dialog = useProjectMoveDialog();
  // Browsing belongs to one machine: picking another closes the list.
  const [browsing, setBrowsing] = useState<EnvironmentId | null>(null);
  const loading = dialog?.machinesLoading === true;
  const narrowed =
    scope !== undefined &&
    scope.selected.kind === "project" &&
    scope.scopes.some((entry) => entry.kind !== "project");
  return (
    <>
      <fieldset className="min-w-0" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">Machine</legend>
        {machines.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">
            No other machine is connected. Pair one in Settings › Machines.
          </p>
        ) : (
          <MachineOptionRows
            aria-label="Machine"
            options={copyMachineOptions(machines)}
            value={machine}
            disabled={disabled}
            loading={loading}
            onChange={(value) => onMachineChange(value as EnvironmentId)}
          />
        )}
        {dialog?.machinesExtra}
      </fieldset>
      {/* The folder belongs to a machine: none is asked for before one is picked. */}
      {machine && (
        <FolderField
          slot="copy-folder"
          machineLabel={targetLabel}
          value={folder}
          disabled={folderDisabled}
          placeholder={findingHome ? "Finding the home folder there…" : "Full path on that machine"}
          onChange={onFolderChange}
          onBrowse={
            machine ? () => setBrowsing((open) => (open === machine ? null : machine)) : undefined
          }
          browsing={browsing !== null && browsing === machine}
        >
          {projectRelativePath !== "." && folder && (
            <span
              className="block text-xs text-muted-foreground"
              data-slot="copy-destination-project"
            >
              The project lands in{" "}
              <span className="font-mono wrap-anywhere">
                {copiedProjectFolder(folder, projectRelativePath)}
              </span>
            </span>
          )}
        </FolderField>
      )}
      {machine && browsing === machine && (
        <RemoteFolderBrowser
          key={machine}
          machine={machine}
          start={folder || "~/"}
          disabled={folderDisabled}
          onPick={onFolderChange}
        />
      )}
      {along && (
        <WhatComesAlong>
          <AlongLine>
            All files in{" "}
            <span className="font-mono">{lastSegment(scope?.selected.copyRoot ?? sourceRoot)}</span>
            {along.uncommittedFiles
              ? `, including ${along.uncommittedFiles.toLocaleString("en-US")} uncommitted ${along.uncommittedFiles === 1 ? "file" : "files"}`
              : ", including uncommitted and ignored files"}
          </AlongLine>
          <li className="min-w-0" data-slot="copy-along-secrets">
            <label className="flex cursor-pointer items-start gap-2.5">
              <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                <Checkbox
                  checked={along.includeSecrets}
                  disabled={disabled}
                  onCheckedChange={(checked) => along.onIncludeSecretsChange(checked === true)}
                  aria-label="Include secrets (.env, keys)"
                />
              </span>
              <span className="min-w-0 leading-5">
                Secrets (.env, keys): {along.includeSecrets ? "included" : `left on ${sourceLabel}`}
                <span className="block text-xs text-muted-foreground">
                  {along.includeSecrets
                    ? `Sent only to ${targetLabel}, readable only by your user there.`
                    : `They stay on ${sourceLabel}.`}
                </span>
              </span>
            </label>
          </li>
          <AlongLine>Project goal, instructions and memory, shared with {targetLabel}</AlongLine>
          <AlongLine stays>
            Stays on {sourceLabel}: sign-ins to Claude, Codex and GitHub, and running processes
          </AlongLine>
        </WhatComesAlong>
      )}
      <CoordinatorChoice
        value={mode === "copy-and-move" ? "move" : "copy"}
        onChange={(intent) => onModeChange(intent === "move" ? "copy-and-move" : "copy-only")}
        canMove={canMove}
        sourceLabel={sourceLabel}
        targetLabel={machine ? targetLabel : null}
        disabled={disabled}
      />
      <MoreOptions
        defaultOpen={chooseFirst || narrowed || (dialog !== null && dialog.method !== "copy")}
      >
        {along?.details}
        <FilesTravelChoice />
        {scope && (
          <HandoffCopyScope scope={scope} sourceLabel={sourceLabel} disabled={scopeDisabled} />
        )}
        <label
          className="flex cursor-pointer items-start gap-3 text-sm"
          data-slot="copy-choose-first"
        >
          <span className="flex h-5 items-center">
            <Checkbox
              checked={chooseFirst}
              disabled={disabled}
              onCheckedChange={(checked) => onChooseFirstChange(checked === true)}
              aria-label="Let me choose file types first"
            />
          </span>
          <span className="leading-5">
            Let me choose file types first
            <span className="block text-xs text-muted-foreground">
              Stops after measuring so you can pick, then shows what would change before anything is
              written.
            </span>
          </span>
        </label>
      </MoreOptions>
    </>
  );
}
