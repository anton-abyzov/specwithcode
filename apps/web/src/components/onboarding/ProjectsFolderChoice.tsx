import type { EnvironmentId } from "@specweave-studio/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readRecentFolders } from "../../hooks/useProjectFolderChoice";
import { useTx } from "../../i18n";
import { droppedFolder, folderDropRefusal } from "../../lib/folderDrop";
import { currentPlatform, systemDialogLabel } from "../../lib/platformConventions";
import { readLocalApi } from "../../localApi";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { resolveProjectPickerTarget } from "../../wslPaths";
import {
  projectPlaces,
  sameFolder,
  withSeparator,
  type KnownProject,
} from "../studio/folderBrowser.logic";
import { NewProjectFolderPicker } from "../studio/NewProjectFolderPicker";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/**
 * A folder on this machine as a project, beside the projects setup found: an
 * address bar over a folder list, the system folder dialog in the desktop app,
 * and a dropped folder. The folder shown is the choice once the person opens
 * one; nothing is created until the step's main button is pressed.
 */
export function ProjectsFolderChoice({
  environmentId,
  machineLabel,
  projectsFolder,
  projects,
  defaultOpen,
  disabled,
  folder,
  onFolderChange,
  onOtherWays,
  specweaveSetUp = false,
  onStartWithSpecweave,
}: {
  /** This machine. */
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string | null;
  /** The machine's own folder for projects, offered as a place. */
  readonly projectsFolder: string | null;
  /** Projects already on the machine, marked in the folder list. */
  readonly projects: readonly KnownProject[];
  /** Open from the start: setup found nothing to import. */
  readonly defaultOpen: boolean;
  readonly disabled: boolean;
  readonly folder: string | null;
  /** The folder to add, or null when there is none (closed, loading or unreadable). */
  readonly onFolderChange: (folder: string | null) => void;
  /** Leaves setup for Add project, where a new empty project or a clone starts. */
  readonly onOtherWays: () => void;
  /** This machine's server can set SpecWeave up when it makes a project (1396 AC-22). */
  readonly specweaveSetUp?: boolean;
  /**
   * The empty folder's box as it stands, undefined while no box shows, or
   * null while the server has not yet said whether the folder is empty.
   */
  readonly onStartWithSpecweave?: (startWith: boolean | null | undefined) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(defaultOpen);
  // An empty folder becomes a new project, so it gets one box: start with
  // SpecWeave. The server says whether it is empty, by the create's own rules
  // (the folder's own name as the project's); a folder with files gets none.
  // Unticking holds for that folder only; another folder starts ticked again.
  const [untickedFor, setUntickedFor] = useState<string | null>(null);
  const folderName =
    folder
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || null;
  const folderCheck = useEnvironmentQuery(
    specweaveSetUp && folder !== null && folderName !== null
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: withSeparator(folder), projectName: folderName },
        })
      : null,
  );
  const emptyFolder =
    specweaveSetUp &&
    folder !== null &&
    folderCheck.data?.outcome?.kind === "uses" &&
    folderCheck.data.outcome.because === "empty_named_like_project" &&
    sameFolder(folderCheck.data.parentPath, folder);
  const startWithSpecweave =
    folder === null || untickedFor === null || !sameFolder(untickedFor, folder);
  // A press before the answer lands would drop the default, so the step waits.
  const checking =
    specweaveSetUp &&
    folder !== null &&
    folderName !== null &&
    folderCheck.error === null &&
    !(folderCheck.data !== null && sameFolder(folderCheck.data.parentPath, folder));
  const boxState = checking ? null : emptyFolder ? startWithSpecweave : undefined;
  useEffect(() => {
    onStartWithSpecweave?.(boxState);
  }, [boxState, onStartWithSpecweave]);
  // A drop or the system dialog restarts the list at the folder it gave.
  const [start, setStart] = useState<{ readonly path: string | null; readonly key: number }>({
    path: folder,
    key: 0,
  });
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inDesktopApp = typeof window !== "undefined" && window.desktopBridge !== undefined;
  const places = useMemo(
    () =>
      projectPlaces({
        projectsFolder,
        projectRoots: projects.map((project) => project.workspaceRoot),
        recent: readRecentFolders(environmentId),
      }),
    [environmentId, projects, projectsFolder],
  );
  // A WSL-only machine keeps its folders inside WSL: the system dialog is
  // routed there, as Add project routes it, and hands back a Linux path.
  const wslTarget = async () => {
    const wsl =
      currentPlatform() === "windows"
        ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
        : null;
    return resolveProjectPickerTarget({
      browseEnvironmentId: environmentId,
      primaryEnvironmentId: environmentId,
      desktopInstanceId: null,
      wslConfiguration: wsl,
    });
  };
  const drop = async (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (disabled) return;
    const refusal = folderDropRefusal({ inDesktopApp, targetIsThisDevice: true, machineLabel });
    if (refusal !== null) {
      setDropNote(refusal);
      return;
    }
    // The drop is only readable now, before anything is awaited.
    const items = [...event.dataTransfer.items];
    const dropped = droppedFolder({
      files: [...event.dataTransfer.files],
      isDirectory: (index) => items[index]?.webkitGetAsEntry?.()?.isDirectory ?? null,
      getPathForFile: window.desktopBridge?.getPathForFile,
    });
    if (dropped === null) {
      setDropNote(tx("That drop held no folder. Type or paste the path instead."));
      return;
    }
    // A dropped folder is a Windows path, which means nothing inside WSL.
    if ((await wslTarget()) !== null) {
      setDropNote(tx("This machine keeps its folders inside WSL. Type or paste the path instead."));
      return;
    }
    setDropNote(dropped.fromFile ? tx("Used the folder that holds the dropped file.") : null);
    setOpen(true);
    onFolderChange(dropped.path);
    setStart((previous) => ({ path: dropped.path, key: previous.key + 1 }));
  };
  return (
    <div
      data-slot="projects-folder-choice"
      data-dragging={dragging ? "" : undefined}
      className="mt-4 rounded-lg border border-border bg-background data-dragging:bg-primary/5"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        void drop(event);
      }}
    >
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A closed list adds nothing.
          if (!next) onFolderChange(null);
        }}
      >
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 px-3 py-2.5 text-left">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <span className="truncate text-sm font-medium">{tx("Add a folder on this machine")}</span>
          <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {tx("Type a path, browse or drop a folder")}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="-mx-1 pb-1">
            <NewProjectFolderPicker
              key={start.key}
              environmentId={environmentId}
              selectedPath={start.path}
              machineLabel={machineLabel}
              nativePickerLabel={inDesktopApp ? systemDialogLabel(currentPlatform()) : null}
              places={places}
              projects={projects}
              disabled={disabled}
              onSelect={onFolderChange}
              {...(inDesktopApp
                ? {
                    onPickNatively: async (initialPath: string | null) => {
                      const target = await wslTarget();
                      return (
                        (await readLocalApi()?.dialogs.pickFolder({
                          ...(initialPath ? { initialPath } : {}),
                          ...(target ? { targetEnvironmentId: target } : {}),
                        })) ?? null
                      );
                    },
                  }
                : {})}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
      {emptyFolder ? (
        <StartWithSpecweaveBox
          checked={startWithSpecweave}
          disabled={disabled}
          onCheckedChange={(checked) => setUntickedFor(checked ? null : folder)}
        />
      ) : null}
      {dropNote ? (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {dropNote}
        </p>
      ) : null}
      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {tx("Starting from nothing?")}{" "}
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0 text-xs font-normal underline"
          disabled={disabled}
          onClick={onOtherWays}
        >
          {tx("New empty project or clone a repository")}
        </Button>
      </p>
    </div>
  );
}

/** The one box an empty folder shows in first-run setup (1396 AC-22). */
export function StartWithSpecweaveBox({
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const tx = useTx();
  return (
    <label
      data-slot="start-with-specweave"
      className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2.5 text-sm"
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="min-w-0">{tx("Start with SpecWeave, for plans and a board")}</span>
    </label>
  );
}
