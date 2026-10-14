import { useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

/** Browses only the selected machine. Selecting a parent never creates anything. */
export function NewProjectFolderPicker({
  environmentId,
  selectedPath,
  disabled,
  onSelect,
}: {
  environmentId: EnvironmentId;
  selectedPath: string | null;
  disabled: boolean;
  onSelect: (path: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("~/");
  const [browsePath, setBrowsePath] = useState("~/");
  const access = useFilesystemReadAccess(environmentId);
  const query = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath },
        })
      : null,
  );
  const navigate = (path: string) => {
    setInput(path);
    setBrowsePath(/[\\/]$/.test(path) ? path : `${path}/`);
  };
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
          <p className="text-sm font-medium">Project location</p>
          <p className="break-all text-xs text-muted-foreground">
            {selectedPath ?? "Choose a parent folder on the selected machine"}
          </p>
        </div>
        {selectedPath && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Cancel" : "Change"}
          </Button>
        )}
      </div>
      {(!selectedPath || editing) && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input
              aria-label="Parent folder path"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
              value={input}
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
            <p role="alert" className="text-xs text-destructive">Folder access is unavailable on this machine.</p>
          )}
          {query.isPending && (
            <p role="status" className="text-xs">
              Loading folders…
            </p>
          )}
          {(query.error || access.error) && (
            <p role="alert" className="text-xs text-destructive">
              {String(query.error ?? access.error)}
            </p>
          )}
          {query.data && !query.isPending && !query.error && access.canReadFiles && (
            <>
              <p className="break-all text-xs text-muted-foreground">{query.data.parentPath}</p>
              <div aria-label="Folders" className="max-h-32 overflow-auto rounded border">
                <button
                  type="button"
                  className="block w-full px-2 py-1 text-left text-sm hover:bg-accent"
                  disabled={disabled}
                  onClick={() => navigate(`${query.data!.parentPath}/../`)}
                >
                  Up one folder
                </button>
                {query.data.entries.map((entry) => (
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
              </div>
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => {
                  onSelect(query.data!.parentPath);
                  setEditing(false);
                }}
              >
                Use this folder
              </Button>
              <p className="text-xs text-muted-foreground">
                Creates a new subfolder here. To use an existing project, choose Add existing
                project.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
