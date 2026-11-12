import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { type EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import {
  type MachineHandoffOpenRequest,
  ProjectMachineHandoff,
} from "../studio/ProjectMachineHandoff";

/**
 * Run on → Add to another machine… for a project with no Git remote. There is
 * nothing to clone, so it opens the folder copy review the project menu opens
 * (Review files to transfer), on the machine picked in the menu.
 */
export function DraftFolderCopy({
  project,
  machine,
  seq,
  onClose,
}: {
  readonly project: EnvironmentProject;
  readonly machine: EnvironmentId;
  /** A new pick of the same machine opens the review again. */
  readonly seq: number;
  readonly onClose: () => void;
}) {
  const request = useMemo<MachineHandoffOpenRequest>(
    () => ({ mode: "copy", seq, machine }),
    [seq, machine],
  );
  return (
    <ProjectMachineHandoff
      project={project}
      coordinatorId={
        project.workspaceSettings?.coordinatorThreadId ??
        ThreadId.make(`project-coordinator:${project.id}`)
      }
      openRequest={request}
      showTrigger={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}
