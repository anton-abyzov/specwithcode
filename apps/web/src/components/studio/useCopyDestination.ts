import { useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { savedCopyRoot, suggestedCopyFolder } from "../../studio/folderCopy";
import type { useCopyScope } from "./HandoffCopyScope";
import type { CopyMachine } from "./HandoffCopySetup";

/**
 * Screen 1's machine and folder: the preferred machine when it can take the copy, and the saved
 * folder there, else the same layout under that machine's home. A typed path wins until the
 * machine or copy root changes.
 */
export function useCopyDestination({
  machines,
  preferredMachine,
  savedFolder,
  scope,
}: {
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly preferredMachine: EnvironmentId | null;
  readonly savedFolder: (environmentId: EnvironmentId) => string | null;
  readonly scope: ReturnType<typeof useCopyScope>;
}) {
  const firstMachine =
    machines.find((machine) => machine.id === preferredMachine && !machine.unavailable)?.id ??
    machines.find((machine) => !machine.unavailable)?.id ??
    null;
  const [machine, setMachine] = useState<EnvironmentId | null>(firstMachine);
  const [folderDraft, setFolderDraft] = useState<{
    machine: EnvironmentId;
    value: string;
    copyRoot?: string;
  } | null>(null);
  const access = useFilesystemReadAccess(machine);
  const home = useEnvironmentQuery(
    machine && access.canReadFiles
      ? filesystemEnvironment.browse({ environmentId: machine, input: { partialPath: "~/" } })
      : null,
  );
  // The query belongs to the selected machine. A late home response never replaces a typed path.
  const folder = machine
    ? folderDraft?.machine === machine &&
      (!folderDraft.copyRoot || folderDraft.copyRoot === scope.selected.copyRoot)
      ? folderDraft.value
      : (savedCopyRoot(savedFolder(machine), scope.selected.projectRelativePath) ??
        suggestedCopyFolder(scope.selected.copyRoot, home.data?.parentPath))
    : "";
  const setFolder = (value: string, environmentId = machine, copyRoot?: string) => {
    if (environmentId)
      setFolderDraft({ machine: environmentId, value, ...(copyRoot ? { copyRoot } : {}) });
  };
  return {
    machine,
    setMachine,
    folderDraft,
    setFolderDraft,
    folder,
    setFolder,
    findingHome: home.isPending,
  };
}
