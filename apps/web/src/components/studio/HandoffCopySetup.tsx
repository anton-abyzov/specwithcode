import type { EnvironmentId, FolderCopyMode } from "@specweave-studio/contracts";
import { copiedProjectFolder } from "../../studio/folderCopy";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";

export interface CopyMachine {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly unavailable: string | null;
}

/** Where the copy goes, what happens after it, and whether to stop and choose what to copy. */
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
}) {
  return (
    <>
      <fieldset className="min-w-0 space-y-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">Copy to</legend>
        {machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect another machine in Settings &gt; Connections first.
          </p>
        ) : (
          <RadioGroup
            aria-label="Copy to"
            value={machine ?? ""}
            onValueChange={(value) => onMachineChange(value as EnvironmentId)}
          >
            {machines.map((entry) => (
              <label
                key={entry.id}
                data-slot="copy-machine"
                className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${machine === entry.id ? "border-primary bg-accent/40" : ""} ${entry.unavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <span className="flex h-5 items-center">
                  <Radio value={entry.id} disabled={entry.unavailable !== null} />
                </span>
                <span className="min-w-0 leading-5">
                  <span className="block font-medium">{entry.label}</span>
                  {entry.unavailable && (
                    <span className="block text-xs text-muted-foreground">{entry.unavailable}</span>
                  )}
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
      </fieldset>
      <label className="block space-y-1 text-sm" data-slot="copy-folder">
        <span className="font-medium">Folder on {targetLabel}</span>
        <Input
          value={folder}
          placeholder={
            findingHome
              ? "Finding the destination home folder…"
              : "Absolute path on the destination"
          }
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onFolderChange(event.currentTarget.value)}
          aria-label={`Folder on ${targetLabel}`}
        />
        {projectRelativePath !== "." && folder && (
          <span
            className="block text-xs text-muted-foreground"
            data-slot="copy-destination-project"
          >
            Project / coordinator folder:{" "}
            <span className="font-mono wrap-anywhere">
              {copiedProjectFolder(folder, projectRelativePath)}
            </span>
          </span>
        )}
        <span className="block text-xs text-muted-foreground">
          A new or empty folder gets an exact copy. In an existing folder, nothing is replaced
          without asking you first.
        </span>
      </label>
      <fieldset className="min-w-0 space-y-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">After the copy</legend>
        <RadioGroup
          aria-label="After the copy"
          value={mode}
          onValueChange={(value) => onModeChange(value as FolderCopyMode)}
        >
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <span className="flex h-5 items-center">
              <Radio value="copy-only" />
            </span>
            <span className="leading-5">
              Copy files only
              <span className="block text-xs text-muted-foreground">
                Keeps this coordinator on {sourceLabel}. {targetLabel} gets a separate checkout; you
                can start its own coordinator in Project settings.
              </span>
            </span>
          </label>
          <label
            className={`flex items-start gap-3 text-sm ${canMove ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
          >
            <span className="flex h-5 items-center">
              <Radio value="copy-and-move" disabled={!canMove} />
            </span>
            <span className="leading-5">
              Copy and transfer coordinator context
              <span className="block text-xs text-muted-foreground">
                Copies files first, then transfers this coordinator's context and responsibility to{" "}
                {targetLabel} if work on {sourceLabel} is idle; otherwise you retry once it is. Each
                machine keeps its own server; running workers and provider processes are not moved.
              </span>
            </span>
          </label>
        </RadioGroup>
      </fieldset>
      <label
        className="flex cursor-pointer items-start gap-3 text-sm"
        data-slot="copy-choose-first"
      >
        <span className="flex h-5 items-center">
          <Checkbox
            checked={chooseFirst}
            disabled={disabled}
            onCheckedChange={(checked) => onChooseFirstChange(checked === true)}
            aria-label="Choose what to copy"
          />
        </span>
        <span className="leading-5">
          Choose what to copy
          <span className="block text-xs text-muted-foreground">
            Stops after measuring so you can pick the kinds of files, then shows a preview before
            anything is written.
          </span>
        </span>
      </label>
    </>
  );
}
