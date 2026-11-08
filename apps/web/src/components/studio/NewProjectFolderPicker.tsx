import { useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

/** The folder above `path`, or null at a root. Avoids showing `…/Alpha/../`. */
export function parentFolderOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  if (cut === 0) return trimmed.length > 1 ? "/" : null;
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

const withSeparator = (path: string) => (/[\\/]$/.test(path) ? path : `${path}/`);

/** The error's own words; String() of an error object would prefix its class name. */
function browseErrorText(error: unknown): string {
  if (
    error instanceof Error ||
    (typeof error === "object" && error !== null && "message" in error)
  ) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

/** Browses only the selected machine. Selecting a parent never creates anything. */
export function NewProjectFolderPicker({
  environmentId,
  selectedPath,
  defaultPath = null,
  machineLabel = null,
  nativePickerLabel = null,
  disabled,
  onSelect,
  onPickNatively,
}: {
  environmentId: EnvironmentId;
  selectedPath: string | null;
  /** The machine's own folder for new projects, offered as a one-click choice. */
  defaultPath?: string | null;
  /** The machine whose folders are listed; null names no machine. */
  machineLabel?: string | null;
  /** Shown when this machine is the device in front of the person, e.g. "Choose in Finder…". */
  nativePickerLabel?: string | null;
  disabled: boolean;
  onSelect: (path: string) => void;
  onPickNatively?: (initialPath: string | null) => Promise<string | null>;
}) {
  const startPath = selectedPath ?? defaultPath ?? "~/";
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(startPath);
  const [browsePath, setBrowsePath] = useState(withSeparator(startPath));
  const [showHidden, setShowHidden] = useState(false);
  const [picking, setPicking] = useState(false);
  const access = useFilesystemReadAccess(environmentId);
  const open = !selectedPath || editing;
  const query = useEnvironmentQuery(
    access.canReadFiles && open
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath },
        })
      : null,
  );
  const navigate = (path: string) => {
    setInput(path);
    setBrowsePath(withSeparator(path));
  };
  const choose = (path: string) => {
    onSelect(path);
    setEditing(false);
  };
  const pickNatively = async () => {
    if (!onPickNatively || picking) return;
    setPicking(true);
    try {
      const picked = await onPickNatively(query.data?.parentPath ?? selectedPath ?? defaultPath);
      if (picked) {
        choose(picked);
        navigate(picked);
      }
    } finally {
      setPicking(false);
    }
  };
  const entries = query.data?.entries ?? [];
  const visibleEntries = showHidden
    ? entries
    : entries.filter((entry) => !entry.name.startsWith("."));
  const hiddenCount = entries.length - visibleEntries.length;
  const parentOfCurrent = query.data ? parentFolderOf(query.data.parentPath) : null;
  const onMachine = machineLabel ? ` on ${machineLabel}` : "";
  // The machine's own default folder may not exist until its first project; it is
  // still a valid choice, because creating there makes it.
  const browsingMissingDefault =
    query.error !== undefined &&
    query.error !== null &&
    defaultPath !== null &&
    withSeparator(defaultPath) === browsePath;
  const nativeButton =
    nativePickerLabel && onPickNatively ? (
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || picking}
        onClick={() => void pickNatively()}
      >
        {picking ? "Waiting for your choice…" : nativePickerLabel}
      </Button>
    ) : null;
  return (
    <section
      aria-label="Project location"
      className="mx-4 my-2 rounded-lg border p-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Project location{onMachine}</p>
          <p className="break-all text-xs text-muted-foreground">
            {selectedPath ?? "Choose the folder that will hold the new project"}
          </p>
        </div>
        {selectedPath && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              if (!editing) navigate(selectedPath);
              setEditing(!editing);
            }}
          >
            {editing ? "Done" : "Change"}
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {(nativeButton || (defaultPath && defaultPath !== selectedPath)) && (
            <div className="flex flex-wrap gap-2">
              {nativeButton}
              {defaultPath && defaultPath !== selectedPath && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  title={defaultPath}
                  onClick={() => {
                    choose(defaultPath);
                    navigate(defaultPath);
                  }}
                >
                  Use default folder
                </Button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <input
              aria-label="Parent folder path"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
              value={input}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={disabled || !access.canReadFiles}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  navigate(input);
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !access.canReadFiles || !input.trim()}
              onClick={() => navigate(input)}
            >
              Browse
            </Button>
          </div>
          {!access.canReadFiles && !access.isPending && !access.error && (
            <p role="alert" className="text-xs text-destructive-foreground">
              Folder access is unavailable on this machine.
            </p>
          )}
          {query.isPending && (
            <p role="status" className="text-xs">
              Loading folders…
            </p>
          )}
          {browsingMissingDefault ? (
            <div className="space-y-2">
              <p role="status" className="text-xs text-muted-foreground">
                The default projects folder{onMachine} does not exist yet. It is made when you
                create the project.
              </p>
              <Button size="sm" disabled={disabled} onClick={() => choose(defaultPath)}>
                Use this folder
              </Button>
            </div>
          ) : (
            (query.error || access.error) && (
              <p role="alert" className="text-xs text-destructive-foreground">
                {query.error && machineLabel
                  ? browseErrorText(query.error).replace("on this machine", `on ${machineLabel}`)
                  : browseErrorText(query.error ?? access.error)}
              </p>
            )
          )}
          {query.data && !query.isPending && !query.error && access.canReadFiles && (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 break-all text-xs text-muted-foreground">
                  {query.data.parentPath}
                  {onMachine}
                </p>
                {(hiddenCount > 0 || showHidden) && (
                  <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={showHidden}
                      disabled={disabled}
                      onChange={(event) => setShowHidden(event.target.checked)}
                    />
                    Show hidden folders
                  </label>
                )}
              </div>
              <div aria-label="Folders" className="max-h-40 overflow-auto rounded border">
                {parentOfCurrent && (
                  <button
                    type="button"
                    className="block w-full px-2 py-1 text-left text-sm hover:bg-accent"
                    disabled={disabled}
                    onClick={() => navigate(parentOfCurrent)}
                  >
                    Up one folder
                  </button>
                )}
                {visibleEntries.map((entry) => (
                  <button
                    type="button"
                    key={entry.fullPath}
                    className="block w-full px-2 py-1 text-left text-sm hover:bg-accent"
                    disabled={disabled}
                    onClick={() => navigate(entry.fullPath)}
                  >
                    {entry.name}
                  </button>
                ))}
                {visibleEntries.length === 0 && (
                  <p className="px-2 py-1 text-sm text-muted-foreground">
                    {hiddenCount > 0 ? "Only hidden folders here." : "No folders inside."}
                  </p>
                )}
              </div>
              <Button size="sm" disabled={disabled} onClick={() => choose(query.data!.parentPath)}>
                Use this folder
              </Button>
              <p className="text-xs text-muted-foreground">
                Creates a new subfolder here. If this folder is already a project (it has a Git
                repository or matches the name), it is used as-is.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
