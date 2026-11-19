import { useEffect, useState, type RefObject } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, FolderCopyMode, ProjectId } from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { forgetLinkRefusal, rememberLinkRefusal } from "../../studio/linkRefusals";
import { linkCopyAsWorkers, projectLink, type CopyLinkOutcome } from "../../studio/projectLink";
import { randomUUID } from "../../lib/utils";
import type { PendingCopy } from "./handoffFolderCopyPending";
import type { CopyStage } from "./handoffCopySteps";
import { messageOf } from "./useCoordinatorTransfer";
import { useProjectMoveDialog } from "./ProjectMoveOptions";

export type CopyLinkState = CopyLinkOutcome | { readonly status: "linking" } | null;

/**
 * "Copy files only" ends with the copy linked as a member that runs workers; the
 * coordinator stays here. The link runs once the copy is done, and the pointer records it.
 * A copy that belongs to a project this one is not linked to is left alone: copying files
 * into it never relinks it, and the done screen says nothing was linked.
 */
export function useCopyLink({
  project,
  sourceLabel,
  targetLabel,
  machine,
  stage,
  mode,
  copyProjectId,
  latestPending,
  remember,
}: {
  readonly project: EnvironmentProject;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly machine: EnvironmentId | null;
  readonly stage: CopyStage;
  readonly mode: FolderCopyMode;
  readonly copyProjectId: ProjectId | null | undefined;
  readonly latestPending: RefObject<PendingCopy | null>;
  readonly remember: (value: PendingCopy) => void;
}) {
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const prepare = useAtomCommand(projectLink.prepare, { reportFailure: false });
  const accept = useAtomCommand(projectLink.accept, { reportFailure: false });
  const commit = useAtomCommand(projectLink.commit, { reportFailure: false });
  const [link, setLink] = useState<CopyLinkState>(null);
  const otherProject = useProjectMoveDialog()?.send?.otherProject ?? null;

  /** Records the link on the copy's pointer, so a reopen does not link it again. */
  const markLinked = (operationId: string | undefined) => {
    const saved = latestPending.current;
    if (saved && saved.operationId === operationId && !saved.linked)
      remember({ ...saved, linked: true });
  };

  const linkCopy = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    const operationId = latestPending.current?.operationId;
    // The menu says why the copy is not linked after this dialog is closed.
    const kept = `${project.environmentId}:${project.id}`;
    const joining = `${environmentId}:${projectId}`;
    setLink({ status: "linking" });
    try {
      const outcome = await linkCopyAsWorkers(
        { preview, prepare, accept, commit },
        {
          kept: { environmentId: project.environmentId, projectId: project.id },
          joining: { environmentId, projectId },
          keptLabel: sourceLabel,
          joiningLabel: targetLabel,
          newOperationId: randomUUID,
        },
      );
      setLink(outcome);
      if (outcome.status === "linked") {
        markLinked(operationId);
        forgetLinkRefusal(kept, joining);
      } else rememberLinkRefusal(kept, joining, outcome.words);
    } catch (cause) {
      // What a machine answered is said as it said it.
      const words = { text: messageOf(cause), verbatim: true };
      setLink({ status: "review", reason: words.text, words });
      rememberLinkRefusal(kept, joining, words);
    }
  };
  const linkTarget =
    stage === "done" && mode === "copy-only" && copyProjectId && !otherProject
      ? copyProjectId
      : null;
  useEffect(() => {
    if (linkTarget && machine && link === null) void linkCopy(machine, linkTarget);
  }, [linkTarget, machine]);

  return { link, setLink, markLinked };
}
