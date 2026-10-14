import { useState } from "react";
import { ProjectId, type EnvironmentId } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { Button } from "../ui/button";

/** All paths and listings belong to the selected remote environment. */
export function HandoffFolderPicker({
  machines,
  title,
  onSaved,
  existingFolders = [],
}: {
  machines: readonly { id: EnvironmentId; label: string; unavailable: string | null }[];
  title: string;
  existingFolders?: readonly {
    environmentId: EnvironmentId;
    id: ProjectId;
    workspaceRoot: string;
  }[];
  onSaved: (environmentId: EnvironmentId, projectId: ProjectId, path: string) => void;
}) {
  const [machine, setMachine] = useState<EnvironmentId | null>(null);
  const [path, setPath] = useState("~/Projects/");
  const [browsePath, setBrowsePath] = useState("~/Projects/");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = useFilesystemReadAccess(machine);
  const query = useEnvironmentQuery(
    machine && access.canReadFiles
      ? filesystemEnvironment.browse({
          environmentId: machine,
          input: { partialPath: browsePath },
        })
      : null,
  );
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const selected = machines.find((m) => m.id === machine);
  async function save() {
    if (!machine || saving || selected?.unavailable || !access.canReadFiles) return;
    setSaving(true);
    setError(null);
    try {
      if (!isProjectFolder(path))
        throw new Error("Choose your project folder, outside temporary handoff storage.");
      if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path))
        throw new Error("Browse to an existing folder or enter its full absolute path.");
      const existing = existingFolders.find(
        (folder) =>
          folder.environmentId === machine &&
          folder.workspaceRoot.replace(/[/\\]+$/, "") === path.replace(/[/\\]+$/, ""),
      );
      if (existing) {
        onSaved(machine, existing.id, existing.workspaceRoot);
        setMachine(null);
        return;
      }
      const projectId = ProjectId.make(randomUUID());
      const result = await create({
        environmentId: machine,
        input: {
          projectId,
          title,
          workspaceRoot: path,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onSaved(machine, projectId, path);
      setMachine(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this folder.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="mt-4 rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Choose another folder on a machine
      </summary>
      <div className="mt-3 space-y-2">
        <label className="block text-sm">
          Machine
          <select
            aria-label="Folder machine"
            className="mt-1 block w-full rounded border bg-background p-2"
            value={machine ?? ""}
            disabled={saving}
            onChange={(event) => {
              setMachine((event.target.value as EnvironmentId) || null);
              setPath("~/Projects/");
              setBrowsePath("~/Projects/");
              setError(null);
            }}
          >
            <option value="">Choose a machine</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id} disabled={!!m.unavailable}>
                {m.label}
                {m.unavailable ? ` — ${m.unavailable}` : ""}
              </option>
            ))}
          </select>
        </label>
        {machine && (
          <>
            <p className="text-xs text-muted-foreground">
              Browsing {selected?.label}. Save an existing checkout of this project's umbrella
              repository.
            </p>
            <label className="block text-sm">
              Folder
              <input
                aria-label="Remote project folder"
                className="mt-1 block w-full rounded border bg-background p-2"
                value={path}
                disabled={saving}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={saving || !access.canReadFiles}
              onClick={() => setBrowsePath(path.endsWith("/") ? path : `${path}/`)}
            >
              Browse folder
            </Button>
            {query.isPending && <p role="status">Loading folders…</p>}
            {query.data && (
              <div className="max-h-40 overflow-auto rounded border" aria-label="Remote folders">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const parent =
                      query.data!.parentPath.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]+$/, "") ||
                      "/";
                    setPath(parent);
                    setBrowsePath(parent.endsWith("/") ? parent : `${parent}/`);
                  }}
                >
                  Up one folder
                </Button>
                {query.data.entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.fullPath}
                    className="block w-full px-3 py-1 text-left text-sm hover:bg-accent"
                    disabled={saving}
                    onClick={() => {
                      setPath(entry.fullPath);
                      setBrowsePath(`${entry.fullPath}/`);
                    }}
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
            )}
            {(error || query.error || access.error) && (
              <p role="alert" className="text-sm text-destructive">
                {error ?? String(query.error ?? access.error)}
              </p>
            )}
            <Button
              size="sm"
              disabled={saving || !access.canReadFiles || !!selected?.unavailable}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Use this folder"}
            </Button>
          </>
        )}
      </div>
    </details>
  );
}
