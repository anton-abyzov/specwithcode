import { useRef, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { FolderBrowser, type FolderListing, type FolderPlace } from "./FolderBrowser";
import { displayPath, folderOutcome, type KnownProject } from "./folderBrowser.logic";

const NO_PLACES: readonly FolderPlace[] = [];
const NO_PROJECTS: readonly KnownProject[] = [];

export { parentFolderOf } from "./folderBrowser.logic";

/**
 * Where a new project goes on the selected machine. The folder being shown is
 * the choice: the project gets its own subfolder inside it, or the folder is
 * used as it is when it already is a project. Opening a folder never creates
 * anything.
 */
export function NewProjectFolderPicker({
  environmentId,
  selectedPath,
  defaultPath = null,
  machineLabel = null,
  nativePickerLabel = null,
  projectName,
  places = NO_PLACES,
  projects = NO_PROJECTS,
  canCreateFolder = false,
  disabled,
  onSelect,
  onPickNatively,
}: {
  environmentId: EnvironmentId;
  selectedPath: string | null;
  /** The machine's own folder for new projects, shown first when nothing was chosen before. */
  defaultPath?: string | null;
  /** The machine whose folders are listed; null names no machine. */
  machineLabel?: string | null;
  /** Shown when this machine is the device in front of the person, e.g. "Choose in Finder…". */
  nativePickerLabel?: string | null;
  /** The project's name, to say exactly which folder is made. Omit when no project is being named. */
  projectName?: string;
  places?: readonly FolderPlace[];
  projects?: readonly KnownProject[];
  canCreateFolder?: boolean;
  disabled: boolean;
  /** The folder shown, or null while there is none to choose (loading, or it cannot be read). */
  onSelect: (path: string | null) => void;
  onPickNatively?: (initialPath: string | null) => Promise<string | null>;
}) {
  // With no remembered or default folder the list starts at home, which is
  // only taken as the choice once the person opens a folder themselves.
  const [chosen, setChosen] = useState(selectedPath !== null || defaultPath !== null);
  const chosenByPerson = useRef(chosen);
  const markChosen = () => {
    chosenByPerson.current = true;
    setChosen(true);
  };
  const [start, setStart] = useState({ path: selectedPath ?? defaultPath ?? "~/", key: 0 });
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [picking, setPicking] = useState(false);
  const reported = useRef<string | null | undefined>(undefined);
  const onMachine = machineLabel ? ` on ${machineLabel}` : "";
  const report = (next: FolderListing | null) => {
    setListing(next);
    if (!chosenByPerson.current) return;
    const path = next?.path ?? null;
    if (reported.current === path) return;
    reported.current = path;
    onSelect(path);
  };
  const pickNatively = async () => {
    if (!onPickNatively || picking) return;
    setPicking(true);
    try {
      const picked = await onPickNatively(listing?.path ?? selectedPath ?? defaultPath);
      if (picked) {
        markChosen();
        setStart((previous) => ({ path: picked, key: previous.key + 1 }));
      }
    } finally {
      setPicking(false);
    }
  };
  const shown = listing === null ? null : displayPath(listing.path, listing.homePath);
  const outcome =
    listing === null || projectName === undefined
      ? null
      : folderOutcome({ folder: listing.path, name: projectName, entries: listing.entries });
  return (
    <section aria-label="Project location" className="mx-4 my-2">
      <p className="mb-1.5 text-sm font-medium">Project location{onMachine}</p>
      <FolderBrowser
        key={start.key}
        environmentId={environmentId}
        startPath={start.path}
        machineLabel={machineLabel}
        disabled={disabled}
        places={places}
        projects={projects}
        canCreateFolder={canCreateFolder}
        missingOkPath={defaultPath}
        onListing={report}
        onNavigate={markChosen}
        tools={
          nativePickerLabel && onPickNatively ? (
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={disabled || picking}
              onClick={() => void pickNatively()}
            >
              {picking ? "Waiting for your choice…" : nativePickerLabel}
            </button>
          ) : null
        }
        footer={
          <p
            role="status"
            data-slot="project-location-outcome"
            className="break-words text-xs text-muted-foreground"
          >
            {listing === null ? (
              "Open a folder to choose where the project goes."
            ) : !chosen ? (
              "Open a folder, or pick a place, to choose where the project goes."
            ) : projectName === undefined ? (
              <>
                Selected <span className="font-medium text-foreground">{shown}</span>
                {onMachine}.
              </>
            ) : outcome === null ? (
              <>
                The project gets a new folder inside{" "}
                <span className="font-medium text-foreground">{shown}</span>
                {onMachine}.
              </>
            ) : (
              <>
                {outcome.kind === "create" ? "Creates " : "Uses "}
                <span className="font-medium text-foreground">
                  {displayPath(outcome.path, listing.homePath)}
                </span>
                {outcome.kind === "use" ? " as the project" : ""}
                {onMachine}.{outcome.note ? ` ${outcome.note}` : ""}
              </>
            )}
          </p>
        }
      />
    </section>
  );
}
