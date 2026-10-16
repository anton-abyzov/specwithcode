import { useState } from "react";
import { ProjectId, type EnvironmentId } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import {
  handoffMachineStatus,
  mirroredProjectFolder,
  type HandoffMachine,
} from "../../studio/handoffMachinePreference";
import { Button } from "../ui/button";

/** All paths and listings belong to the selected remote environment. */
export function HandoffFolderPicker({
  machines,
  machine,
  onMachineChange,
  defaultOpen = false,
  sourceFolder = null,
  title,
  onSaved,
  existingFolders = [],
}: {
  machines: readonly (HandoffMachine & { id: EnvironmentId })[];
  machine: EnvironmentId | null;
  onMachineChange: (machine: EnvironmentId | null) => void;
  defaultOpen?: boolean;
  /** This project's folder on the source machine, mirrored to find the same checkout. */
  sourceFolder?: string | null;
  title: string;
  existingFolders?: readonly {
    environmentId: EnvironmentId;
    id: ProjectId;
    workspaceRoot: string;
  }[];
  onSaved: (environmentId: EnvironmentId, projectId: ProjectId, path: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [path, setPath] = useState("~/Projects/");
  const [browsePath, setBrowsePath] = useState("~/Projects/");
  const [edited, setEdited] = useState(false);
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
  const mirrored = sourceFolder ? mirroredProjectFolder(sourceFolder) : null;
  const probe = useEnvironmentQuery(
    machine && access.canReadFiles && mirrored
      ? filesystemEnvironment.browse({ environmentId: machine, input: { partialPath: mirrored } })
      : null,
  );
  const mirroredName = mirrored?.split("/").pop() ?? null;
  const found = probe.data?.entries.find((entry) => entry.name === mirroredName) ?? null;
  // The found checkout fills the folder until the person changes it.
  const folder = edited ? path : (found?.fullPath ?? path);
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const selected = machines.find((m) => m.id === machine);
  async function save() {
    if (!machine || saving || selected?.unavailable || !access.canReadFiles) return;
    setSaving(true);
    setError(null);
    try {
      if (!isProjectFolder(folder))
        throw new Error("Choose your project folder, outside temporary handoff storage.");
      if (!folder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(folder))
        throw new Error("Browse to an existing folder or enter its full absolute path.");
      const existing = existingFolders.find(
        (existing) =>
          existing.environmentId === machine &&
          existing.workspaceRoot.replace(/[/\\]+$/, "") === folder.replace(/[/\\]+$/, ""),
      );
      if (existing) {
        onSaved(machine, existing.id, existing.workspaceRoot);
        onMachineChange(null);
        return;
      }
      const projectId = ProjectId.make(randomUUID());
      const result = await create({
        environmentId: machine,
        input: {
          projectId,
          title,
          workspaceRoot: folder,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onSaved(machine, projectId, folder);
      onMachineChange(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this folder.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <details
      className="mt-4 rounded-lg border p-3"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
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
            onChange={(event) => onMachineChange((event.target.value as EnvironmentId) || null)}
          >
            <option value="">Choose a machine</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id} disabled={!!m.unavailable}>
                {m.label} — {handoffMachineStatus(m)}
              </option>
            ))}
          </select>
        </label>
        {machine && (
          <>
            <p className="text-xs text-muted-foreground" data-slot="handoff-folder-status">
              {found
                ? `Found this project's folder on ${selected?.label}. Use it, or browse to another checkout.`
                : probe.isPending && mirrored
                  ? `Looking for this project's folder on ${selected?.label}…`
                  : `Browsing ${selected?.label}. Save an existing checkout of this project's umbrella repository.`}
            </p>
            <label className="block text-sm">
              Folder
              <input
                aria-label="Remote project folder"
                className="mt-1 block w-full rounded border bg-background p-2"
                value={folder}
                disabled={saving}
                onChange={(event) => {
                  setEdited(true);
                  setPath(event.target.value);
                }}
              />
            </label>
            {/* A found folder needs no listing until the person browses. */}
            {query.isPending && (!found || edited) && <p role="status">Loading folders…</p>}
            {query.data && (!found || edited) && (
              <div className="max-h-40 overflow-auto rounded border" aria-label="Remote folders">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const parent =
                      query.data!.parentPath.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]+$/, "") ||
                      "/";
                    setEdited(true);
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
                      setEdited(true);
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
              <p role="alert" className="text-sm text-destructive-foreground">
                {error ?? String(query.error ?? access.error)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={saving || !access.canReadFiles}
                onClick={() => {
                  setEdited(true);
                  setPath(folder);
                  setBrowsePath(folder.endsWith("/") ? folder : `${folder}/`);
                }}
              >
                Browse folder
              </Button>
              <Button
                size="sm"
                disabled={saving || !access.canReadFiles || !!selected?.unavailable}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Use this folder"}
              </Button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
