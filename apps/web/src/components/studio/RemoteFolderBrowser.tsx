import { useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

const trailingSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);

/** Lists folders on one machine. Choosing one opens it and reports its path. */
export function RemoteFolderBrowser({
  machine,
  start,
  onPick,
  disabled = false,
}: {
  readonly machine: EnvironmentId;
  /** The folder to list first. */
  readonly start: string;
  readonly onPick: (path: string) => void;
  readonly disabled?: boolean;
}) {
  const [browsePath, setBrowsePath] = useState(() => trailingSlash(start || "~/"));
  const access = useFilesystemReadAccess(machine);
  const query = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.browse({ environmentId: machine, input: { partialPath: browsePath } })
      : null,
  );
  const open = (path: string) => {
    onPick(path);
    setBrowsePath(trailingSlash(path));
  };
  return (
    <div className="space-y-1" data-slot="handoff-folder-browser">
      {query.isPending && access.canReadFiles && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading folders…
        </p>
      )}
      {query.data && (
        <div className="max-h-40 overflow-auto rounded-lg border" aria-label="Remote folders">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              open(
                query.data!.parentPath.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]+$/, "") || "/",
              )
            }
          >
            Up one folder
          </Button>
          {query.data.entries.map((entry) => (
            <button
              type="button"
              key={entry.fullPath}
              className="block w-full px-3 py-1 text-left text-sm hover:bg-accent"
              disabled={disabled}
              onClick={() => open(entry.fullPath)}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      {(query.error || access.error) && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {String(query.error ?? access.error)}
        </p>
      )}
    </div>
  );
}
