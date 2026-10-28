import { useState } from "react";
import { ProjectId, type EnvironmentId } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { mirroredProjectFolder, type HandoffMachine } from "../../studio/handoffMachinePreference";
import { Button } from "../ui/button";
import { FolderField } from "./ProjectMoveOptions";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";

/**
 * Saves a folder on the chosen machine as this project, so the Git move can continue there.
 * All paths and listings belong to that machine.
 */
export function HandoffFolderPicker({
  machines,
  machine,
  sourceFolder = null,
  title,
  onSaved,
  existingFolders = [],
}: {
  machines: readonly (HandoffMachine & { id: EnvironmentId })[];
  /** The machine chosen in the machine list; nothing is read without one. */
  machine: EnvironmentId | null;
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
  const [path, setPath] = useState("~/Projects/");
  const [edited, setEdited] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = machines.find((m) => m.id === machine) ?? null;
  const readable = selected ? machine : null;
  const access = useFilesystemReadAccess(readable);
  const mirrored = sourceFolder ? mirroredProjectFolder(sourceFolder) : null;
  const probe = useEnvironmentQuery(
    readable && access.canReadFiles && mirrored
      ? filesystemEnvironment.browse({ environmentId: readable, input: { partialPath: mirrored } })
      : null,
  );
  const mirroredName = mirrored?.split("/").pop() ?? null;
  const found = probe.data?.entries.find((entry) => entry.name === mirroredName) ?? null;
  // The found checkout fills the folder until the person changes it.
  const folder = edited ? path : (found?.fullPath ?? path);
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  if (!readable || !selected) return null;
  const target = readable;
  async function save() {
    if (saving || selected?.unavailable || !access.canReadFiles) return;
    setSaving(true);
    setError(null);
    try {
      if (!isProjectFolder(folder))
        throw new Error("Choose your project folder, outside temporary handoff storage.");
      if (!folder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(folder))
        throw new Error("Browse to an existing folder or enter its full absolute path.");
      const existing = existingFolders.find(
        (existing) =>
          existing.environmentId === target &&
          existing.workspaceRoot.replace(/[/\\]+$/, "") === folder.replace(/[/\\]+$/, ""),
      );
      if (existing) {
        onSaved(target, existing.id, existing.workspaceRoot);
        return;
      }
      const projectId = ProjectId.make(randomUUID());
      const result = await create({
        environmentId: target,
        input: {
          projectId,
          title,
          workspaceRoot: folder,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onSaved(target, projectId, folder);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this folder.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-2" data-slot="handoff-folder-picker">
      <FolderField
        machineLabel={selected.label}
        value={folder}
        disabled={saving}
        onChange={(value) => {
          setEdited(true);
          setPath(value);
        }}
        onBrowse={() => setBrowsing((value) => !value)}
        browseDisabled={!access.canReadFiles}
        browsing={browsing}
      >
        <p className="text-xs text-muted-foreground" data-slot="handoff-folder-status">
          {found && !edited
            ? `Found this project on ${selected.label}.`
            : probe.isPending && mirrored
              ? `Looking for this project on ${selected.label}…`
              : `Pick a checkout of this project on ${selected.label}.`}
        </p>
      </FolderField>
      {browsing && (
        <RemoteFolderBrowser
          machine={target}
          start={folder}
          disabled={saving}
          onPick={(picked) => {
            setEdited(true);
            setPath(picked);
          }}
        />
      )}
      {(error || access.error) && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error ?? String(access.error)}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={saving || !access.canReadFiles || !!selected.unavailable}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Use this folder"}
      </Button>
    </div>
  );
}
