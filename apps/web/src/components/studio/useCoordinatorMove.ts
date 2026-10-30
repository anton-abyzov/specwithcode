import { useRef, useState, type MutableRefObject } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  FolderCopyStatus,
  MachineHandoffSourceChanges,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { copiedProjectFolder } from "../../studio/folderCopy";
import { unwrap, type PendingCopy } from "./handoffFolderCopyPending";
import { copyProblem } from "./handoffCopyNotices";
import { transferRefusal, type CopyStage, type TransferBusy } from "./handoffCopySteps";
import { changeKey, type LeftOnSource } from "./HandoffSourceChanges";
import { useCoordinatorTransfer } from "./useCoordinatorTransfer";

/**
 * Moving the coordinator once a copy-and-move applied its files: the transfer itself, a
 * refusal that lists what changed on the source, and the person's answer to that list.
 */
export function useCoordinatorMove({
  project,
  coordinatorId,
  knownProject,
  sourceLabel,
  targetLabel,
  copy,
  folder,
  latestPending,
  remember,
  setStage,
  setCopyAgain,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly knownProject: (
    environmentId: EnvironmentId,
    targetFolder: string,
  ) => EnvironmentProject | null;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly copy: FolderCopyStatus | null;
  readonly folder: string;
  readonly latestPending: MutableRefObject<PendingCopy | null>;
  readonly remember: (value: PendingCopy | null) => void;
  readonly setStage: (stage: CopyStage) => void;
  readonly setCopyAgain: (value: boolean) => void;
}) {
  const { contextPublished, continueThere } = useCoordinatorTransfer({
    project,
    coordinatorId,
    knownProject,
  });
  const copyDrift = useAtomCommand(machineHandoff.copyDrift, { reportFailure: false });
  const release = useAtomCommand(machineHandoff.copyRelease, { reportFailure: false });
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  // The threads a busy machine named: the done screen links each one.
  const [transferBusy, setTransferBusy] = useState<TransferBusy | null>(null);
  const [contextTransferred, setContextTransferred] = useState(false);
  // Move anyway transferred context: the pointer is gone, the wording stays.
  const [movedAnyway, setMovedAnyway] = useState(false);
  const [transferRecovery, setTransferRecovery] = useState(false);
  // The source's list of paths that changed after copying, while the person decides.
  const [sourceReview, setSourceReview] = useState<MachineHandoffSourceChanges | null>(null);
  // What the finished move left only on the source.
  const [leftOnSource, setLeftOnSource] = useState<LeftOnSource | null>(null);
  // The person kept the coordinator on the source; the copied files stay.
  const [keptHere, setKeptHere] = useState(false);
  // The list the person moved without, so the done screen can say which paths were chosen.
  const acceptedList = useRef<MachineHandoffSourceChanges | null>(null);
  // Bumped by every move and reset: a late read for an earlier move never lands.
  const generation = useRef(0);

  /** One read after the move: anything still only on the source, said on the done screen. */
  const readLeftOnSource = async (operationId: string, readFor: number) => {
    const read = await copyDrift({
      environmentId: project.environmentId,
      input: { projectId: project.id, operationId },
    }).catch(() => null);
    if (generation.current !== readFor) return;
    // Older sources have no drift read; the move itself succeeded either way.
    const drift = read?._tag === "Success" ? read.value?.drift : undefined;
    if (!drift || !(drift.total > 0) || !Array.isArray(drift.rows)) {
      setLeftOnSource(null);
      return;
    }
    const accepted = acceptedList.current;
    setLeftOnSource({
      total: drift.total,
      rows: drift.rows,
      truncated: drift.truncated === true,
      chosen: accepted && !accepted.truncated ? new Set(accepted.rows.map(changeKey)) : null,
    });
  };

  /**
   * After the files are applied, the coordinator continues on the destination. Differences
   * stop it unless the person chose Move anyway on a held copy.
   */
  const moveCoordinator = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    applied: FolderCopyStatus | null = copy,
    anyway = false,
  ) => {
    if (!anyway && applied && copyProblem(applied, sourceLabel) !== null) {
      setCopyAgain(true);
      setTransferNotice("Copy again before handing off the coordinator.");
      setTransferBusy(null);
      setStage("done");
      return;
    }
    setStage("moving");
    setTransferRecovery(true);
    setTransferBusy(null);
    const attempt = ++generation.current;
    setLeftOnSource(null);
    const pointer = latestPending.current;
    const accepted =
      pointer?.operationId === operationId ? pointer.acceptedSourceChanges?.digest : undefined;
    try {
      await continueThere(
        operationId,
        environmentId,
        projectId,
        applied?.projectFolder ??
          copiedProjectFolder(
            applied?.targetFolder ?? folder,
            applied?.projectRelativePath ?? latestPending.current?.projectRelativePath,
          ),
        accepted,
      );
    } catch (cause) {
      const refused = transferRefusal(cause, contextPublished.current, targetLabel, sourceLabel);
      if (refused.copyAgain !== null) setCopyAgain(refused.copyAgain);
      if (!refused.recovery) setTransferRecovery(false);
      // Busy or not ready (no Copy again answer either way): a list shown before stays,
      // with its choices, for the next try.
      if (refused.copyAgain !== null || refused.changes) setSourceReview(refused.changes ?? null);
      const saved = latestPending.current;
      // Copy again is the answer now; a reopen must not offer the transfer instead. A list
      // the person can move without keeps Move anyway for that move. An accepted list is
      // stale once the source refuses again.
      if (refused.copyAgain && saved) {
        acceptedList.current = null;
        const keepAnyway = saved.moveAnyway === true && refused.changes?.acceptable === true;
        const { moveAnyway: _dropped, acceptedSourceChanges: _stale, ...rest } = saved;
        if (saved.moveAnyway || saved.acceptedSourceChanges)
          remember(keepAnyway ? { ...rest, moveAnyway: true } : rest);
      }
      setTransferNotice(refused.notice);
      setTransferBusy(refused.busy ?? null);
      setStage("done");
      return;
    }
    setTransferRecovery(false);
    setContextTransferred(true);
    setSourceReview(null);
    // A reviewed list asked for Copy again; the move went ahead without it.
    setCopyAgain(false);
    if (anyway) setMovedAnyway(true);
    setTransferNotice(null);
    // Undo is for copies only; a finished move has nothing left to resume.
    remember(null);
    setStage("done");
    // Only words on the done screen depend on it; a failed read never reaches the page.
    void readLeftOnSource(operationId, attempt).catch(() => {});
  };

  /** Move without these paths: the source checks the list is still the one shown. */
  const moveWithout = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    applied: FolderCopyStatus | null,
    anyway: boolean,
  ) => {
    const review = sourceReview;
    const saved = latestPending.current;
    if (!review?.acceptable || saved?.operationId !== operationId) return;
    acceptedList.current = review;
    // The pointer keeps the choice, so a retried or reopened move still sends it.
    remember({ ...saved, acceptedSourceChanges: { digest: review.digest, total: review.total } });
    await moveCoordinator(operationId, environmentId, projectId, applied, anyway);
  };

  /** Keeps the coordinator on the source: it releases the move, and the copied files stay. */
  const keepHere = async (operationId: string) => {
    unwrap(
      await release({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          operationId,
          reason: `The coordinator stays on ${sourceLabel}; the copied files remain.`.slice(0, 400),
        },
      }),
    );
    setSourceReview(null);
    setKeptHere(true);
    setCopyAgain(false);
    setTransferNotice(null);
    setTransferBusy(null);
    setTransferRecovery(false);
    remember(null);
  };

  /** Forgets this move's outcome, for a fresh copy. */
  const reset = () => {
    generation.current++;
    setTransferRecovery(false);
    contextPublished.current = false;
    acceptedList.current = null;
    setTransferNotice(null);
    setTransferBusy(null);
    setContextTransferred(false);
    setMovedAnyway(false);
    setSourceReview(null);
    setLeftOnSource(null);
    setKeptHere(false);
  };

  return {
    contextPublished,
    transferNotice,
    transferBusy,
    contextTransferred,
    movedAnyway,
    transferRecovery,
    setTransferRecovery,
    sourceReview,
    leftOnSource,
    keptHere,
    moveCoordinator,
    moveWithout,
    keepHere,
    reset,
  };
}
