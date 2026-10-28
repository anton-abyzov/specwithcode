import { useState } from "react";
import type { EnvironmentId, FolderCopyMode } from "@specweave-studio/contracts";
import { copiedProjectFolder } from "../../studio/folderCopy";
import { MachineOptionRows, type MachineOption } from "../handoff/MachineOptionRows";
import { Checkbox } from "../ui/checkbox";
import { HandoffCopyScope, type useCopyScope } from "./HandoffCopyScope";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import {
  FilesTravelChoice,
  FolderField,
  MoreOptions,
  MoveIntentToggle,
  useProjectMoveDialog,
} from "./ProjectMoveOptions";

export interface CopyMachine {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly unavailable: string | null;
}

export const copyMachineOptions = (machines: ReadonlyArray<CopyMachine>): MachineOption[] =>
  machines.map((entry) => ({
    value: entry.id,
    label: entry.label,
    tone: entry.unavailable ? "off" : "ready",
    reason: entry.unavailable,
    disabled: entry.unavailable !== null,
  }));

/** Screen 1 of the copy: move or copy, the machine, the folder there, and More options. */
export function HandoffCopySetup({
  machines,
  machine,
  onMachineChange,
  targetLabel,
  sourceLabel,
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
}: {
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly machine: EnvironmentId | null;
  readonly onMachineChange: (machine: EnvironmentId) => void;
  readonly targetLabel: string;
  readonly sourceLabel: string;
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
  /** What to copy from the source; shown under More options. */
  readonly scope?: ReturnType<typeof useCopyScope>;
  readonly scopeDisabled?: boolean;
}) {
  const dialog = useProjectMoveDialog();
  // Browsing belongs to one machine: picking another closes the list.
  const [browsing, setBrowsing] = useState<EnvironmentId | null>(null);
  const narrowed =
    scope !== undefined &&
    scope.selected.kind === "project" &&
    scope.scopes.some((entry) => entry.kind !== "project");
  return (
    <>
      <MoveIntentToggle
        value={mode === "copy-and-move" ? "move" : "copy"}
        onChange={(intent) => onModeChange(intent === "move" ? "copy-and-move" : "copy-only")}
        canMove={canMove}
        disabled={disabled}
      />
      <fieldset className="min-w-0" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">Machine</legend>
        {machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other machine is connected. Pair one in Settings › Connections.
          </p>
        ) : (
          <MachineOptionRows
            aria-label="Machine"
            options={copyMachineOptions(machines)}
            value={machine}
            disabled={disabled}
            onChange={(value) => onMachineChange(value as EnvironmentId)}
          />
        )}
      </fieldset>
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
      {machine && browsing === machine && (
        <RemoteFolderBrowser
          key={machine}
          machine={machine}
          start={folder || "~/"}
          disabled={folderDisabled}
          onPick={onFolderChange}
        />
      )}
      <MoreOptions
        defaultOpen={chooseFirst || narrowed || (dialog !== null && dialog.method !== "copy")}
      >
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
