import { useEffect, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { savedCopyRoot, suggestedCopyFolder } from "../../studio/folderCopy";
import type { useCopyScope } from "./HandoffCopyScope";
import type { CopyMachine } from "./HandoffCopySetup";

/**
 * Screen 1's machine and folder: the preferred machine when it can take the copy (or, until
 * one is chosen, the first that becomes ready), and the saved
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
  const preferred =
    machines.find((machine) => machine.id === preferredMachine && !machine.unavailable)?.id ?? null;
  const firstMachine = preferred ?? machines.find((machine) => !machine.unavailable)?.id ?? null;
  // Until a machine is chosen, the first ready one is: machines that finish connecting after
  // the dialog opened are picked up instead of leaving the form without a machine. Once one is
  // ready it is pinned, so a machine that connects later (or this one briefly reconnecting)
  // never retargets the button label or a copy that has already started.
  const [chosen, setMachine] = useState<EnvironmentId | null>(preferred);
  useEffect(() => {
    if (chosen === null && firstMachine) setMachine(firstMachine);
  }, [chosen, firstMachine]);
  const machine = chosen ?? firstMachine;
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
