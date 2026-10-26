import { useEffect, useRef, useState } from "react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  type EnvironmentId,
  type FolderCopyChoice,
  type FolderCopyFileClass,
  type FolderCopyMode,
  type FolderCopyOffer,
  type FolderCopySourceStatus,
  type FolderCopySourceSummary,
  type FolderCopyStatus,
  type FolderCopyUndoResult,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { linkCopyAsWorkers, projectLink, type CopyLinkOutcome } from "../../studio/projectLink";
import {
  cloneableRows,
  copySettled,
  copyDestinationKey,
  copiedProjectFolder,
  savedCopyRoot,
  suggestedCopyFolder,
  DEFAULT_COPY_SELECTION,
  formatBytes,
  type HandoffFolderMethod,
} from "../../studio/folderCopy";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { HandoffSecretsStep } from "./HandoffSecretsStep";
import { CopyClassPicker, CopyPlanPreview, CopyProgress } from "./HandoffCopyPreview";
import { HandoffCopyActions } from "./HandoffCopyActions";
import { HandoffCopyScope, CopyScopeMapping, useCopyScope } from "./HandoffCopyScope";
import {
  abortError,
  APPROVED,
  CANCELLED_WHILE_MEASURING,
  cancelledPointer,
  folderCopyStorageKey,
  isAbortError,
  isFolderCopyNotFound,
  readPendingCopy,
  sleep,
  SOURCE_FINISHED,
  sourceNotDropped,
  unwrap,
  withReleaseFailure,
  type PendingCopy,
} from "./handoffFolderCopyPending";
import { HandoffCopySetup, type CopyMachine } from "./HandoffCopySetup";
import {
  copyHeld,
  HandoffCopyDone,
  HandoffCopyDoneActions,
  HandoffCopyFailed,
  HandoffCopyFailedActions,
  HandoffCopyUndone,
} from "./HandoffCopyDone";
import { messageOf, useCoordinatorTransfer } from "./useCoordinatorTransfer";
import {
  copySteps,
  currentCopyStep,
  nextStepText,
  recompareFor,
  sourceProgressText,
  transferRefusal,
  type CopyRecompare,
  type CopyStage,
} from "./handoffCopySteps";
import {
  copyStartInput,
  replaceAllDecisions,
  replaceAllLeftText,
  replaceAllOutcome,
  replaceAllReady,
  replacementText,
  replacesNothing,
  replacingCount,
  secretsLeft,
  secretsLeftText,
  undecidedCloneRows,
} from "./handoffCopyAuto";
import { copyProblem, groupCopyNotices } from "./handoffCopyNotices";
import {
  CloseOrCancelHint,
  CopyNextStep,
  CopyNoticesBlock,
  CopyStepLine,
} from "./HandoffCopyGuide";

export { folderCopyStorageKey, isFolderCopyNotFound, readPendingCopy };
export type { CopyMachine };

type Stage = CopyStage;

/** What a copy is started with; Copy again reuses the last copy's. */
interface CopyChoices {
  readonly machine: EnvironmentId;
  readonly folder: string;
  readonly mode: FolderCopyMode;
  readonly selection: ReadonlyArray<FolderCopyFileClass>;
  readonly auto: boolean;
  readonly method: "copy" | "clone";
  readonly copyRoot: string;
  readonly projectRelativePath: string;
}

const POLL_MS = 1000;
/** Closing the dialog leaves these running on the machines; reopening resumes them. */
const CLOSABLE_WHILE_WORKING: ReadonlySet<Stage> = new Set([
  "setup",
  "scanning",
  "planning",
  "copying",
]);
/**
 * Copies the project folder to another machine: the destination pulls the files from
 * this machine, previews what changes, and applies only after approval.
 */
export function HandoffFolderCopy({
  project,
  coordinatorId,
  sourceLabel,
  method,
  machines,
  savedFolder,
  savedProject,
  preferredMachine = null,
  canMove,
  onBusyChange,
  onCloseLockChange,
  onOpenProject,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly sourceLabel: string;
  readonly method: Exclude<HandoffFolderMethod, "folder">;
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly savedFolder: (environmentId: EnvironmentId) => string | null;
  readonly savedProject?: (
    environmentId: EnvironmentId,
    folder: string,
  ) => EnvironmentProject | null;
  /** The remembered or last-used machine, preselected when it can take the copy. */
  readonly preferredMachine?: EnvironmentId | null;
  readonly canMove: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  /** True only while closing the dialog would interrupt a step that must finish here. */
  readonly onCloseLockChange?: (locked: boolean) => void;
  readonly onOpenProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly folder: string;
  }) => void;
}) {
  const scope = useCopyScope(project);
  const capabilities = useAtomCommand(machineHandoff.copyCapabilities, { reportFailure: false });
  const offerCopy = useAtomCommand(machineHandoff.copyOffer, { reportFailure: false });
  const sourceStatus = useAtomCommand(machineHandoff.copySourceStatus, { reportFailure: false });
  const sourceCancel = useAtomCommand(machineHandoff.copySourceCancel, { reportFailure: false });
  const release = useAtomCommand(machineHandoff.copyRelease, { reportFailure: false });
  const start = useAtomCommand(machineHandoff.copyStart, { reportFailure: false });
  const status = useAtomCommand(machineHandoff.copyStatus, { reportFailure: false });
  const decide = useAtomCommand(machineHandoff.copyDecide, { reportFailure: false });
  const approve = useAtomCommand(machineHandoff.copyApprove, { reportFailure: false });
  const retry = useAtomCommand(machineHandoff.copyRetry, { reportFailure: false });
  const cancel = useAtomCommand(machineHandoff.copyCancel, { reportFailure: false });
  const undo = useAtomCommand(machineHandoff.copyUndo, { reportFailure: false });
  const sendSecrets = useAtomCommand(machineHandoff.copySecrets, { reportFailure: false });
  const linkPreview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const linkPrepare = useAtomCommand(projectLink.prepare, { reportFailure: false });
  const linkAccept = useAtomCommand(projectLink.accept, { reportFailure: false });
  const linkCommit = useAtomCommand(projectLink.commit, { reportFailure: false });

  const storageKey = folderCopyStorageKey(project.environmentId, project.id);
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
  const [mode, setMode] = useState<FolderCopyMode>("copy-only");
  // Off: one click measures, compares and copies; on: stop after measuring to choose.
  const [chooseFirst, setChooseFirst] = useState(false);
  const [stage, setStage] = useState<Stage>("setup");
  const [offer, setOffer] = useState<FolderCopyOffer | null>(null);
  const [summary, setSummary] = useState<FolderCopySourceSummary | null>(null);
  // The source's progress: measuring, then building the copy while the destination compares.
  const [measured, setMeasured] = useState<FolderCopySourceStatus["progress"]>(null);
  const [selection, setSelection] =
    useState<ReadonlyArray<FolderCopyFileClass>>(DEFAULT_COPY_SELECTION);
  const [copy, setCopy] = useState<FolderCopyStatus | null>(null);
  const [secretPaths, setSecretPaths] = useState<ReadonlyArray<string>>([]);
  const [secretsConfirmed, setSecretsConfirmed] = useState(false);
  const [pending, setPending] = useState<PendingCopy | null>(null);
  const [undoPreview, setUndoPreview] = useState<FolderCopyUndoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const [contextTransferred, setContextTransferred] = useState(false);
  // Move anyway transferred context: the pointer is gone, the wording stays.
  const [movedAnyway, setMovedAnyway] = useState(false);
  // The source dropped an undone copy that the destination could not give back.
  const [sourceDropped, setSourceDropped] = useState(false);
  const [copyAgain, setCopyAgain] = useState(false);
  // Why the destination compares again; null for the first compare.
  const [recompare, setRecompare] = useState<CopyRecompare>(null);
  const [transferRecovery, setTransferRecovery] = useState(false);
  const [working, setWorking] = useState(false);
  const [link, setLink] = useState<CopyLinkOutcome | { readonly status: "linking" } | null>(null);
  const [linkDialog, setLinkDialog] = useState(false);
  const running = useRef(false);
  // Long runs read the pointer they wrote, not the state of the render that started them.
  const latestPending = useRef<PendingCopy | null>(null);
  const copiedProjects = useRef(new Map<string, ProjectId>());
  // Applying files can register or update a project while an async command is in flight.
  const latestSavedProject = useRef(savedProject);
  latestSavedProject.current = savedProject;
  const knownProject = (environmentId: EnvironmentId, targetFolder: string) => {
    const known = latestSavedProject.current?.(environmentId, targetFolder);
    return known &&
      copyDestinationKey(known.environmentId, known.workspaceRoot) ===
        copyDestinationKey(environmentId, targetFolder)
      ? known
      : null;
  };
  const { contextPublished, continueThere } = useCoordinatorTransfer({
    project,
    coordinatorId,
    knownProject,
  });
  const abort = useRef(new AbortController());
  // Aborted by the Cancel button while measuring; the dialog closing uses `abort`.
  const measureStop = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = abort.current;
    return () => controller.abort();
  }, []);

  const busy =
    working ||
    stage === "scanning" ||
    stage === "planning" ||
    stage === "copying" ||
    stage === "moving";
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  // Measuring, comparing and copying run on the machines; only the short context
  // transfer and the steps that release a fence keep the dialog open.
  const closeLocked = stage === "moving" || (working && !CLOSABLE_WHILE_WORKING.has(stage));
  useEffect(() => onCloseLockChange?.(closeLocked), [closeLocked, onCloseLockChange]);
  // Unmounting ends this view of the copy; the parent must not keep a stale busy or lock.
  // The parent reads its running flag when the dialog closes, before this runs.
  const reporters = useRef({ onBusyChange, onCloseLockChange });
  reporters.current = { onBusyChange, onCloseLockChange };
  useEffect(
    () => () => {
      reporters.current.onBusyChange(false);
      reporters.current.onCloseLockChange?.(false);
    },
    [],
  );

  const target = machines.find((entry) => entry.id === machine) ?? null;
  const targetLabel = target?.label ?? "the other machine";

  const remember = (value: PendingCopy | null) => {
    latestPending.current = value;
    setPending(value);
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      /* The copy still runs; only resuming after a reload needs the pointer. */
    }
  };

  const run = async (step: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setWorking(true);
    setError(null);
    try {
      await step();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(messageOf(cause));
    } finally {
      running.current = false;
      setWorking(false);
    }
  };

  const pollCopy = async (
    environmentId: EnvironmentId,
    operationId: string,
    onRunning?: (next: FolderCopyStatus) => void,
  ) => {
    for (;;) {
      const next = unwrap(
        await status({
          environmentId,
          input: { operationId: operationId },
        }),
      );
      setCopy(next);
      if (copySettled(next)) return next;
      onRunning?.(next);
      await sleep(POLL_MS, abort.current.signal);
    }
  };

  /**
   * Follows the source measuring the folder, with live counts. Cancel abandons the
   * operation; closing the dialog only stops watching, and reopening resumes here.
   * Returns the measured offer, or null when the person cancelled.
   */
  const followMeasure = async (
    saved: PendingCopy,
    offerStep: () => Promise<FolderCopyOffer>,
  ): Promise<{ offer: FolderCopyOffer; summary: FolderCopySourceSummary } | null> => {
    const stopper = new AbortController();
    measureStop.current = stopper;
    setMeasured(null);
    setStage("scanning");
    try {
      const offered = await offerStep();
      if (stopper.signal.aborted) throw abortError();
      setOffer(offered);
      let scanned: FolderCopySourceStatus = offered.status;
      setMeasured(scanned.progress ?? null);
      while (scanned.state === "scanning") {
        await sleep(POLL_MS, abort.current.signal, stopper.signal);
        scanned = unwrap(
          await sourceStatus({
            environmentId: project.environmentId,
            input: { operationId: saved.operationId },
          }),
        );
        if (stopper.signal.aborted) throw abortError();
        setMeasured(scanned.progress ?? null);
      }
      if (!scanned.summary) throw new Error(scanned.error ?? "The folder could not be read.");
      setSummary(scanned.summary);
      // One-click goes straight on to comparing; otherwise the person chooses what to copy.
      if (!saved.auto) setStage("select");
      return { offer: offered, summary: scanned.summary };
    } catch (cause) {
      if (stopper.signal.aborted) {
        // The person cancelled: until the source confirms, a reopen only tells it again.
        const cancelled = cancelledPointer(saved);
        if (latestPending.current?.operationId === saved.operationId) remember(cancelled);
        try {
          await abandonSource(cancelled, CANCELLED_WHILE_MEASURING, true);
        } finally {
          setStage("setup");
        }
        setOffer(null);
        setSummary(null);
        return null;
      }
      // The dialog closed: measuring keeps going on the source and the pointer stays.
      if (isAbortError(cause)) throw cause;
      remember(null);
      setStage("setup");
      throw cause;
    } finally {
      if (measureStop.current === stopper) measureStop.current = null;
      setMeasured(null);
    }
  };

  /**
   * Tells the source to drop an operation and, for a move, to release any fence. A strict
   * call keeps the pointer and says so when the source did not; gone counts as dropped.
   */
  const abandonSource = async (saved: PendingCopy, reason: string, strict: boolean) => {
    const operationId = saved.operationId;
    const cancelled = await sourceCancel({
      environmentId: project.environmentId,
      input: { operationId, reason },
    });
    const notDropped = strict ? sourceNotDropped(cancelled, sourceLabel) : null;
    if (saved.mode === "copy-and-move") {
      const released = await release({
        environmentId: project.environmentId,
        input: { projectId: project.id, operationId, reason },
      });
      if (strict && released._tag === "Failure") {
        // An unreachable source fails both: say it has not dropped the copy, then why.
        const releaseCause = squashAtomCommandFailure(released);
        throw notDropped ? withReleaseFailure(notDropped, releaseCause) : releaseCause;
      }
    }
    if (notDropped) throw notDropped;
    remember(null);
  };

  const show = (next: FolderCopyStatus) => {
    if (next.state === "previewed") setStage("preview");
    else if (next.state === "failed") setStage("failed");
    else if (next.state === "undone" || next.state === "cancelled") setStage("undone");
    else if (next.state === "applied" && next.committed && next.projectId) setStage("done");
    else setStage("copying");
  };

  /**
   * The source's measured summary, so a reopened copy shows its secrets step, skipped
   * worktrees and the secret files that stayed behind.
   */
  const readSummary = async (saved: PendingCopy) => {
    try {
      const measured = unwrap(
        await sourceStatus({
          environmentId: project.environmentId,
          input: { operationId: saved.operationId },
        }),
      );
      if (measured.summary) setSummary(measured.summary);
      return measured.summary;
    } catch {
      return null;
    }
  };

  /**
   * The clone method answers every cloneable repository once, before the person sees
   * the preview. The pointer records it so a reopened preview keeps later edits.
   */
  const cloneDecide = async (saved: PendingCopy, previewed: FolderCopyStatus) => {
    const environmentId = saved.environmentId as EnvironmentId;
    if (
      (saved.method ?? method) !== "clone" ||
      saved.cloneDecided ||
      previewed.state !== "previewed"
    )
      return { saved, next: previewed };
    let next = previewed;
    if (undecidedCloneRows(previewed.rows).length > 0) {
      unwrap(
        await decide({
          environmentId,
          input: { operationId: saved.operationId, clone: cloneableRows(previewed.rows) },
        }),
      );
      next = await pollCopy(environmentId, saved.operationId);
    }
    const decided: PendingCopy = { ...saved, cloneDecided: true };
    if (latestPending.current?.operationId === saved.operationId) remember(decided);
    return { saved: decided, next };
  };

  /** Drops a pointer's pending Replace all once the person has to look at the plan again. */
  const withoutReplaceAll = (saved: PendingCopy): PendingCopy => {
    if (!saved.replaceAll) return saved;
    const { replaceAll: _dropped, replaceAllOutcome: _outcome, ...rest } = saved;
    if (latestPending.current?.operationId === saved.operationId) remember(rest);
    return rest;
  };

  /**
   * Shows the compared plan. A one-click copy that replaces nothing is approved here, as
   * is a plan the person answered with Replace all once nothing is left open; anything
   * else waits for the person. Secret-like files never stop it: they stay on the source.
   */
  const settlePreview = async (next: FolderCopyStatus, saved: PendingCopy) => {
    if (next.state === "previewed") {
      if (saved.replaceAll) {
        // The ticked secret files went to the source when Replace all was clicked.
        if (replaceAllReady(next)) {
          await applyNow(saved, true);
          return;
        }
        withoutReplaceAll(saved);
      } else if (saved.auto && replacesNothing(next)) {
        await applyNow(saved);
        return;
      }
    }
    show(next);
  };

  /** While the destination compares, the source builds the copy; show what it is doing. */
  const watchSource = async (operationId: string) => {
    const read = await sourceStatus({
      environmentId: project.environmentId,
      input: { operationId },
    });
    if (read._tag === "Success") setMeasured(read.value.progress ?? null);
  };

  /** Starts the destination comparing with the chosen classes, then settles its preview. */
  const planNow = async (
    offered: FolderCopyOffer,
    saved: PendingCopy,
    chosen: ReadonlyArray<FolderCopyFileClass>,
  ) => {
    const environmentId = saved.environmentId as EnvironmentId;
    setRecompare(null);
    setStage("planning");
    let compared: { saved: PendingCopy; next: FolderCopyStatus };
    try {
      unwrap(await start({ environmentId, input: copyStartInput(offered, saved, chosen) }));
      compared = await cloneDecide(
        saved,
        await pollCopy(
          environmentId,
          offered.operationId,
          () => void watchSource(saved.operationId),
        ),
      );
    } catch (cause) {
      setStage("select");
      throw cause;
    } finally {
      setMeasured(null);
    }
    await settlePreview(compared.next, compared.saved);
  };

  // Resume a copy this browser started before a reload or a closed dialog.
  const resume = (saved: PendingCopy) => {
    latestPending.current = saved;
    setPending(saved);
    setMachine(saved.environmentId as EnvironmentId);
    setFolder(saved.targetFolder, saved.environmentId as EnvironmentId);
    setMode(saved.mode);
    setSelection(saved.selection ?? DEFAULT_COPY_SELECTION);
    void run(async () => {
      // Cancelled while measuring but the source missed it: only tell it again.
      if (saved.cancelled) return abandonSource(saved, CANCELLED_WHILE_MEASURING, true);
      const environmentId = saved.environmentId as EnvironmentId;
      // Read for every state: skipped worktrees and secret counts must survive a reopen.
      const summaryRead = readSummary(saved);
      let next: FolderCopyStatus;
      try {
        next = await pollCopy(environmentId, saved.operationId, (running) => {
          const comparing = running.state === "planned" || running.state === "scanning";
          if (comparing && saved.replaceAll) setRecompare(recompareFor(saved.replaceAllOutcome));
          setStage(comparing ? "planning" : "copying");
          if (comparing) void watchSource(saved.operationId);
        });
        setMeasured(null);
      } catch (cause) {
        // An unreachable destination keeps the pointer; only a copy it never started is dropped.
        if (!isFolderCopyNotFound(cause)) throw cause;
        // The destination has not started it yet: the source may still be measuring,
        // or have measured and be waiting for the choice of what to copy.
        let measuring: FolderCopySourceStatus | null = null;
        try {
          measuring = unwrap(
            await sourceStatus({
              environmentId: project.environmentId,
              input: { operationId: saved.operationId },
            }),
          );
        } catch (sourceCause) {
          if (!isFolderCopyNotFound(sourceCause)) throw sourceCause;
        }
        if (measuring && !SOURCE_FINISHED.has(measuring.state)) {
          // Offering the same operation again returns its record with a fresh token.
          const measured = await followMeasure(saved, async () =>
            unwrap(
              await offerCopy({
                environmentId: project.environmentId,
                input: {
                  projectId: project.id,
                  operationId: saved.operationId,
                  mode: saved.mode,
                  destinationEnvironmentId: environmentId,
                  ...(saved.copyRoot &&
                  saved.projectRelativePath &&
                  saved.projectRelativePath !== "."
                    ? { copyRoot: saved.copyRoot }
                    : {}),
                },
              }),
            ),
          );
          // A one-click copy closed while measuring goes on to compare and copy.
          if (measured && saved.auto)
            await planNow(measured.offer, saved, saved.selection ?? DEFAULT_COPY_SELECTION);
          return;
        }
        await abandonSource(saved, "The copy was not started.", false);
        setStage("setup");
        if (measuring?.state === "failed" && measuring.error) throw new Error(measuring.error);
        return;
      }
      await summaryRead;
      // Closed while comparing: the clone method's choice, one-click approval and a
      // pending Replace all still apply.
      const compared = await cloneDecide(saved, next);
      await settlePreview(compared.next, compared.saved);
      // An undo or cancel that did not reach the source left this pointer: tell it again.
      if (next.state === "undone" || next.state === "cancelled") {
        if (next.committed) remember(null);
        else {
          await abandonSource(saved, `The copy was ${next.state}.`, true);
          setSourceDropped(true);
        }
        return;
      }
      // Files that changed while copying or a failed check point only at Copy again.
      const problem = copyProblem(next, sourceLabel) !== null;
      if (
        saved.mode === "copy-and-move" &&
        next.state === "applied" &&
        next.projectId &&
        (!problem || saved.moveAnyway)
      ) {
        // A prior request may already have fenced the source. Keep its recovery pointer.
        setTransferRecovery(true);
        setTransferNotice("The files are copied. Transfer coordinator context when you are ready.");
      }
    });
  };
  useEffect(() => {
    const saved = readPendingCopy(storageKey);
    if (saved) resume(saved);
  }, [storageKey]);

  // "Copy files only" ends with the copy linked as a member that runs workers; the coordinator stays here.
  const linkCopy = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    setLink({ status: "linking" });
    try {
      setLink(
        await linkCopyAsWorkers(
          {
            preview: linkPreview,
            prepare: linkPrepare,
            accept: linkAccept,
            commit: linkCommit,
          },
          {
            kept: { environmentId: project.environmentId, projectId: project.id },
            joining: { environmentId, projectId },
            keptLabel: sourceLabel,
            joiningLabel: targetLabel,
            newOperationId: randomUUID,
          },
        ),
      );
    } catch (cause) {
      setLink({ status: "review", reason: messageOf(cause) });
    }
  };
  const linkTarget =
    stage === "done" && mode === "copy-only" && copy?.projectId ? copy.projectId : null;
  useEffect(() => {
    if (linkTarget && machine && link === null) void linkCopy(machine, linkTarget);
  }, [linkTarget, machine]);

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
      setTransferNotice(
        "The files are copied with changes or checks still unresolved. Copy again before transferring coordinator context.",
      );
      setStage("done");
      return;
    }
    setStage("moving");
    setTransferRecovery(true);
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
      );
    } catch (cause) {
      const refused = transferRefusal(cause, contextPublished.current, targetLabel, sourceLabel);
      if (refused.copyAgain !== null) setCopyAgain(refused.copyAgain);
      if (!refused.recovery) setTransferRecovery(false);
      const saved = latestPending.current;
      // Copy again is the answer now; a reopen must not offer the transfer instead.
      if (refused.copyAgain && saved?.moveAnyway) {
        const { moveAnyway: _dropped, ...rest } = saved;
        remember(rest);
      }
      setTransferNotice(refused.notice);
      setStage("done");
      return;
    }
    setTransferRecovery(false);
    setContextTransferred(true);
    if (anyway) setMovedAnyway(true);
    setTransferNotice(null);
    // Undo is for copies only; a finished move has nothing left to resume.
    remember(null);
    setStage("done");
  };

  /** Measures, then (one-click) compares and copies, with these choices. */
  const measureNow = async (choices: CopyChoices) => {
    const { machine, folder, mode, selection, copyRoot, projectRelativePath } = choices;
    if (machines.find((entry) => entry.id === machine)?.unavailable || scope.loading) return;
    if (!folder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(folder))
      throw new Error("Enter the full absolute path of the folder on the destination machine.");
    if (projectRelativePath !== ".") {
      try {
        const supported = unwrap(await capabilities({ environmentId: machine, input: {} }));
        if (supported.scopeVersion !== 1) throw new Error("unsupported");
      } catch {
        throw new Error(
          `Update or reconnect ${targetLabel} before copying an umbrella. You can still select this project folder only.`,
        );
      }
    }
    const projectFolder = copiedProjectFolder(folder, projectRelativePath);
    const operationId = randomUUID();
    const destinationProjectId =
      mode === "copy-and-move"
        ? (knownProject(machine, projectFolder)?.id ??
          copiedProjects.current.get(copyDestinationKey(machine, projectFolder)) ??
          randomUUID())
        : null;
    const saved: PendingCopy = {
      operationId,
      environmentId: machine,
      mode,
      targetFolder: folder,
      copyRoot,
      projectRelativePath,
      projectId: destinationProjectId,
      selection,
      method: choices.method,
      ...(choices.auto ? { auto: true } : {}),
    };
    remember(saved);
    const measured = await followMeasure(saved, async () =>
      unwrap(
        await offerCopy({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            operationId: operationId,
            mode,
            destinationEnvironmentId: machine,
            ...(projectRelativePath !== "." ? { copyRoot } : {}),
          },
        }),
      ),
    );
    if (measured && saved.auto) await planNow(measured.offer, saved, selection);
  };

  const measure = () =>
    run(async () => {
      if (!machine) return;
      await measureNow({
        machine,
        folder,
        mode,
        selection,
        auto: !chooseFirst,
        method,
        copyRoot: scope.selected.copyRoot,
        projectRelativePath: scope.selected.projectRelativePath,
      });
    });

  const choose = (next: ReadonlyArray<FolderCopyFileClass>) => {
    setSelection(next);
    if (pending) remember({ ...pending, selection: next });
  };

  const plan = () =>
    run(async () => {
      if (!offer || !pending) return;
      await planNow(offer, pending, selection);
    });

  const change = (input: {
    readonly decisions?: Readonly<Record<string, FolderCopyChoice>>;
    readonly clone?: ReadonlyArray<string>;
  }) =>
    run(async () => {
      if (!machine || !pending) return;
      if (latestPending.current?.replaceAll) withoutReplaceAll(latestPending.current);
      setRecompare("choices");
      setStage("planning");
      unwrap(
        await decide({
          environmentId: machine,
          input: { operationId: pending.operationId, ...input },
        }),
      );
      show(await pollCopy(machine, pending.operationId));
    });

  const secretsTicked = secretPaths.length > 0 && secretsConfirmed;
  /** The ticked and confirmed secret files go to the source for this destination only. */
  const sendTickedSecrets = async (operationId: string) => {
    unwrap(
      await sendSecrets({
        environmentId: project.environmentId,
        input: { operationId, paths: secretPaths, destinationLabel: targetLabel },
      }),
    );
  };

  /**
   * Approves the previewed plan (after sending any confirmed secret files) and follows it.
   * A failed answer is checked once: an approval that landed anyway carries on.
   */
  const applyNow = async (saved: PendingCopy, secretsSent = false) => {
    const environmentId = saved.environmentId as EnvironmentId;
    const operationId = saved.operationId;
    if (!secretsSent && secretsTicked) await sendTickedSecrets(operationId);
    setStage("copying");
    try {
      setCopy(unwrap(await approve({ environmentId, input: { operationId } })));
    } catch (cause) {
      let current: FolderCopyStatus | null = null;
      try {
        current = unwrap(await status({ environmentId, input: { operationId } }));
      } catch {
        current = null;
      }
      if (!current || !APPROVED.has(current.state)) {
        // A refusal (disk space, a changed preview) happens before anything is copied.
        if (current && !copySettled(current)) current = await pollCopy(environmentId, operationId);
        if (current) {
          setCopy(current);
          show(current);
        } else setStage("preview");
        // The person decides again; a later reopen must not approve on the old click.
        withoutReplaceAll(saved);
        throw cause;
      }
      setCopy(current);
    }
    const next = await pollCopy(environmentId, operationId);
    show(next);
    if (next.state === "failed") return;
    if (saved.mode === "copy-and-move" && next.projectId)
      await moveCoordinator(operationId, environmentId, next.projectId, next);
  };

  const apply = () =>
    run(async () => {
      if (!machine || !pending) return;
      await applyNow(pending);
    });

  /**
   * Takes the source version of everything still open, then copies. The pointer records
   * the click, so closing the dialog while the destination re-compares still approves.
   */
  const replaceAll = () =>
    run(async () => {
      if (!pending || !copy) return;
      const environmentId = pending.environmentId as EnvironmentId;
      // Ticked secret files go first: an approval after the dialog closed cannot send them.
      if (secretsTicked) await sendTickedSecrets(pending.operationId);
      const outcome = replaceAllOutcome(copy.rows);
      const saved: PendingCopy = { ...pending, replaceAll: true, replaceAllOutcome: outcome };
      remember(saved);
      setRecompare(recompareFor(outcome));
      setStage("planning");
      let next: FolderCopyStatus;
      try {
        unwrap(
          await decide({
            environmentId,
            input: { operationId: pending.operationId, decisions: replaceAllDecisions(copy.rows) },
          }),
        );
        next = await pollCopy(environmentId, pending.operationId);
      } catch (cause) {
        // Closing the dialog keeps the pending Replace all; a refusal drops it.
        if (!isAbortError(cause)) {
          withoutReplaceAll(saved);
          setStage("preview");
        }
        throw cause;
      }
      await settlePreview(next, saved);
      // A full destination says so in its own alert; only open choices need this one.
      if (next.state === "previewed" && (next.totals?.decisionsNeeded ?? 0) > 0)
        throw new Error("Some items still need a choice below before copying.");
    });

  const retryCopy = () => {
    // Before Apply the source has let the copy go and this machine is unchanged: the
    // destination cannot resume it, so Retry runs the same copy again.
    if (failedBeforeApply) return copyAgainNow();
    return run(async () => {
      if (!machine || !pending) return;
      const operationId = pending.operationId;
      // Retrying a held move is Move anyway: it commits and transfers despite the differences.
      // The pointer keeps the choice for a transfer retried later or after a reopen.
      const anyway = copyHeld(copy) || pending.moveAnyway === true;
      if (anyway && !pending.moveAnyway) remember({ ...pending, moveAnyway: true });
      if (copy?.state === "applied" && copy.projectId && pending.mode === "copy-and-move") {
        await moveCoordinator(operationId, machine, copy.projectId, copy, anyway);
        return;
      }
      setStage("copying");
      try {
        setCopy(unwrap(await retry({ environmentId: machine, input: { operationId } })));
      } catch (cause) {
        // A refused Retry leaves the copy where it was, with its buttons.
        setStage("failed");
        throw cause;
      }
      const next = await pollCopy(machine, operationId);
      show(next);
      if (next.state !== "failed" && pending.mode === "copy-and-move" && next.projectId)
        await moveCoordinator(operationId, machine, next.projectId, next, anyway);
    });
  };

  const stop = () =>
    run(async () => {
      if (!pending) {
        setStage("setup");
        return;
      }
      const operationId = pending.operationId;
      const reason = "The copy was cancelled before Apply.";
      if (machine && copy)
        await cancel({ environmentId: machine, input: { operationId, reason } }).catch(() => null);
      await sourceCancel({ environmentId: project.environmentId, input: { operationId, reason } });
      if (pending.mode === "copy-and-move")
        unwrap(
          await release({
            environmentId: project.environmentId,
            input: { projectId: project.id, operationId, reason },
          }),
        );
      remember(null);
      setOffer(null);
      setSummary(null);
      setCopy(null);
      setStage("setup");
    });

  const undoCopy = (force: boolean, previewOnly: boolean) =>
    run(async () => {
      if (!machine || !pending) return;
      const result = unwrap(
        await undo({
          environmentId: machine,
          input: {
            operationId: pending.operationId,
            preview: previewOnly,
            force,
          },
        }),
      );
      setCopy(result.status);
      if (previewOnly) {
        setUndoPreview(result);
        return;
      }
      setUndoPreview(null);
      if (!result.undone) throw new Error(result.problems.join(" ") || "Undo did not finish.");
      setStage("undone");
      // An uncommitted copy still holds the source's grant, snapshot and any fence.
      if (copy?.committed !== true) {
        await abandonSource(pending, "The copy was undone.", true);
        setSourceDropped(true);
      }
      remember(null);
    });

  /**
   * Clears this copy so another can start. Copy again keeps the file classes and the
   * ticked secret files; a new copy starts from the defaults.
   */
  const startOver = async (keepChoices = false) => {
    // A reload may have lost the publish result. The source must confirm that
    // abandoning this operation cannot orphan a fenced coordinator.
    if (pending?.mode === "copy-and-move") {
      unwrap(
        await release({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            operationId: pending.operationId,
            reason: "Starting a fresh copy before transferring coordinator context.",
          },
        }),
      );
    }
    if (copy?.state === "applied" && copy.committed && copy.projectId && machine) {
      // Keep the server's canonical folder and registration across a fresh copy.
      // Creating a second id for that same folder would fail only after Apply.
      const destinationEnvironment =
        (pending?.environmentId as EnvironmentId | undefined) ?? machine;
      copiedProjects.current.set(
        copyDestinationKey(
          destinationEnvironment,
          copy.projectFolder ??
            copiedProjectFolder(
              copy.targetFolder,
              copy.projectRelativePath ?? pending?.projectRelativePath,
            ),
        ),
        copy.projectId,
      );
      setFolder(
        copy.targetFolder,
        destinationEnvironment,
        copy.copyRoot ?? pending?.copyRoot ?? scope.selected.copyRoot,
      );
    }
    setTransferRecovery(false);
    contextPublished.current = false;
    remember(null);
    setOffer(null);
    setSummary(null);
    setCopy(null);
    setUndoPreview(null);
    setLink(null);
    setError(null);
    setTransferNotice(null);
    setContextTransferred(false);
    setMovedAnyway(false);
    setSourceDropped(false);
    setCopyAgain(false);
    setRecompare(null);
    if (!keepChoices) {
      setSelection(DEFAULT_COPY_SELECTION);
      setSecretPaths([]);
      setSecretsConfirmed(false);
    }
    setStage("setup");
  };

  const fresh = () => run(() => startOver());

  /**
   * Starts a fresh copy of the same folder to the same machine with the same choices. The
   * destination compares with what the last copy left there, so only changed files move.
   */
  const copyAgainNow = () =>
    run(async () => {
      const last = latestPending.current;
      if (!last || !copy) return;
      const again: CopyChoices = {
        machine: last.environmentId as EnvironmentId,
        folder: copy.targetFolder || last.targetFolder,
        mode: last.mode,
        selection: last.selection ?? selection,
        auto: last.auto === true,
        method: last.method ?? method,
        copyRoot: copy.copyRoot ?? last.copyRoot ?? scope.selected.copyRoot,
        projectRelativePath:
          copy.projectRelativePath ??
          last.projectRelativePath ??
          scope.selected.projectRelativePath,
      };
      await startOver(true);
      setChooseFirst(!again.auto);
      setSelection(again.selection);
      await measureNow(again);
    });

  const failedBeforeApply =
    copy?.state === "failed" && copy.failedStep !== "applying" && copy.failedStep !== "applied";
  // A one-click copy runs straight through; a pointer from an earlier session keeps its own kind.
  const auto = pending ? pending.auto === true : !chooseFirst;
  const rootLabel =
    (pending?.projectRelativePath ?? scope.selected.projectRelativePath) !== "."
      ? "Umbrella root"
      : "Project root";
  const approveLabel =
    mode === "copy-and-move"
      ? `Copy and transfer context to ${targetLabel}`
      : `Copy to ${targetLabel}`;
  const replaced = stage === "preview" && copy ? replacementText(copy.rows) : null;
  const replaceLeft = stage === "preview" && copy ? replaceAllLeftText(copy.rows, rootLabel) : null;
  // Files changed on the source while copying, or a failed check: copying again fixes it.
  const copyProblems = stage === "done" && copy !== null && copyProblem(copy, sourceLabel) !== null;
  // Copy again starts from this copy's pointer; a finished move has none left.
  const movingAnyway = pending?.moveAnyway === true || movedAnyway;
  const offerCopyAgain = (copyAgain || (copyProblems && !movingAnyway)) && pending !== null;
  // Newer destinations count the files the plan replaces or moves to the backup.
  const replacingFiles = stage === "preview" && copy ? replacingCount(copy) : null;
  const secretsNote =
    stage === "done"
      ? secretsLeftText(secretsLeft(summary?.secretFiles, copy?.secrets), sourceLabel)
      : null;
  const secretsUnconfirmed = secretPaths.length > 0 && !secretsConfirmed;
  const stepInput = { stage, auto, mode, contextTransferred };
  const next = nextStepText({
    ...stepInput,
    targetLabel,
    sourceLabel,
    unfinished: pending !== null && pending.cancelled !== true,
    cancelledPending: pending?.cancelled === true,
    bytes: copy?.progress?.bytesTotal || copy?.totals?.bytesToMove || null,
    replaced,
    approveLabel,
    failedBeforeApply,
    held: stage === "failed" && copyHeld(copy),
    copyAgain: offerCopyAgain,
    secretFiles: summary?.secretFiles.length ?? 0,
    replaceLeft,
    recompare,
  });
  const notices = groupCopyNotices({
    skipped: summary?.skipped,
    linksOutside: summary?.linksOutside,
    warnings: [...(summary?.warnings ?? []), ...(copy?.warnings ?? [])],
    rootLabel,
  });
  const cancelShown =
    stage === "scanning" ||
    (stage === "copying" && copy !== null && copy.state !== "applying" && copy.state !== "applied");

  return (
    <div className="space-y-4" data-slot="handoff-folder-copy" data-stage={stage}>
      <CopyStepLine steps={copySteps(stepInput)} current={currentCopyStep(stepInput)} />
      {(stage === "setup" || stage === "scanning") && (
        <>
          <HandoffCopyScope
            scope={scope}
            sourceLabel={sourceLabel}
            disabled={busy || pending !== null}
          />
          <HandoffCopySetup
            machines={machines}
            machine={machine}
            onMachineChange={(id) => {
              setMachine(id);
              setFolderDraft(null);
            }}
            targetLabel={targetLabel}
            sourceLabel={sourceLabel}
            folder={folder}
            onFolderChange={(value) => setFolder(value)}
            findingHome={home.isPending}
            projectRelativePath={scope.selected.projectRelativePath}
            mode={mode}
            onModeChange={setMode}
            canMove={canMove}
            chooseFirst={
              pending && pending.cancelled !== true ? pending.auto !== true : chooseFirst
            }
            onChooseFirstChange={setChooseFirst}
            disabled={busy || pending !== null}
          />
          {stage === "setup" && pending && (
            <p className="text-sm">
              {pending.cancelled
                ? `The copy to ${pending.targetFolder} on ${targetLabel} was cancelled, but ${sourceLabel} has not confirmed dropping it. Check again once ${sourceLabel} is reachable.`
                : `A copy to ${pending.targetFolder} on ${targetLabel} is unfinished. Check it again once ${targetLabel} is reachable.`}
            </p>
          )}
        </>
      )}

      {stage !== "setup" && stage !== "scanning" && pending && (
        <CopyScopeMapping
          source={copy?.copyRoot ?? offer?.copyRoot ?? pending.copyRoot ?? project.workspaceRoot}
          target={copy?.targetFolder ?? pending.targetFolder}
          projectFolder={
            copy?.projectFolder ??
            copiedProjectFolder(
              copy?.targetFolder ?? pending.targetFolder,
              copy?.projectRelativePath ?? pending.projectRelativePath,
            )
          }
        />
      )}

      {stage === "select" && summary && (
        <CopyClassPicker
          summary={summary}
          selection={selection}
          onChange={choose}
          disabled={busy}
          hideNotes
        />
      )}

      {stage === "scanning" && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
          data-slot="copy-measuring"
        >
          {measured ? sourceProgressText(measured, sourceLabel) : "Measuring the folder…"}
        </p>
      )}

      {stage === "planning" && (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Comparing with {pending?.targetFolder ?? "the folder"} on {targetLabel}…
          {measured?.step && measured.step !== "listing" && (
            <span className="block text-xs" data-slot="copy-source-step">
              {sourceProgressText(measured, sourceLabel)}
            </span>
          )}
        </p>
      )}

      {stage === "preview" && copy && (
        <>
          <p className="text-sm font-medium" data-slot="copy-preview-headline">
            {replacingFiles !== null && replacingFiles > 0
              ? `${replacingFiles.toLocaleString()} ${replacingFiles === 1 ? "file" : "files"} on ${targetLabel} would be replaced. Old versions are kept so you can undo.`
              : replaced
                ? `${replaced} on ${targetLabel} would be replaced. Old versions are kept so you can undo.`
                : replacesNothing(copy)
                  ? `Nothing on ${targetLabel} would be replaced.`
                  : replacingFiles === 0
                    ? `Nothing on ${targetLabel} would be replaced. Check the changes below before copying.`
                    : `${targetLabel} already has some of these folders. Check the changes below before copying.`}
            {replaceLeft && <span className="block font-normal">{replaceLeft}</span>}
          </p>
          <CopyPlanPreview
            status={copy}
            disabled={busy}
            machines={{ here: targetLabel, source: sourceLabel }}
            rootLabel={rootLabel}
            onlyChanges={auto}
            hideWarnings
            onDecide={(decisions) => void change({ decisions })}
            onClone={(rowId, on) =>
              void change({
                clone: on
                  ? [...copy.rows.filter((row) => row.clone).map((row) => row.id), rowId]
                  : copy.rows.filter((row) => row.clone && row.id !== rowId).map((row) => row.id),
              })
            }
          />
          {copy.disk && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {targetLabel} needs {formatBytes(copy.disk.needed)} free for this copy and has{" "}
              {formatBytes(copy.disk.free)}.
            </p>
          )}
          {summary && (
            <HandoffSecretsStep
              files={summary.secretFiles}
              selected={secretPaths}
              confirmed={secretsConfirmed}
              targetLabel={targetLabel}
              disabled={busy}
              onSelectedChange={setSecretPaths}
              onConfirmedChange={setSecretsConfirmed}
            />
          )}
        </>
      )}

      {(stage === "copying" || stage === "moving") && copy && (
        <>
          {stage === "moving" ? (
            <p role="status" aria-live="polite" className="text-sm">
              Files are in place. Starting the coordinator on {targetLabel}…
            </p>
          ) : (
            <CopyProgress status={copy} />
          )}
        </>
      )}

      {stage === "failed" && copy && (
        <HandoffCopyFailed
          copy={copy}
          sourceLabel={sourceLabel}
          failedBeforeApply={failedBeforeApply}
          undoPreview={undoPreview}
        />
      )}

      {stage === "done" && copy && copy.projectId && machine && (
        <HandoffCopyDone
          project={project}
          copy={copy}
          projectId={copy.projectId}
          machine={machine}
          mode={mode}
          contextTransferred={contextTransferred}
          targetLabel={targetLabel}
          sourceLabel={sourceLabel}
          transferNotice={transferNotice}
          movingAnyway={movingAnyway}
          copyAgain={offerCopyAgain}
          secretsNote={secretsNote}
          link={link}
          undoPreview={undoPreview}
          linkDialog={linkDialog}
          onLinkDialogClose={() => setLinkDialog(false)}
          onLinked={() => setLink({ status: "linked" })}
        />
      )}

      {stage === "undone" && (
        <HandoffCopyUndone copy={copy} sourceLabel={sourceLabel} sourceDropped={sourceDropped} />
      )}

      {/* A held move's notices name the files it restored as they were when copying started. */}
      {(stage === "select" ||
        stage === "preview" ||
        stage === "copying" ||
        stage === "failed" ||
        stage === "done") && <CopyNoticesBlock notices={notices} targetLabel={targetLabel} />}

      {next && <CopyNextStep>{next}</CopyNextStep>}

      <HandoffCopyActions>
        {error && (
          <p
            role="alert"
            className="max-h-24 basis-full overflow-y-auto wrap-anywhere text-sm text-destructive-foreground"
          >
            {error}
          </p>
        )}
        {cancelShown && <CloseOrCancelHint />}
        {stage === "scanning" && (
          <Button variant="outline" onClick={() => measureStop.current?.abort()}>
            Cancel copy
          </Button>
        )}
        {stage === "setup" &&
          (pending ? (
            <Button disabled={busy} onClick={() => resume(pending)}>
              Check the copy again
            </Button>
          ) : (
            <Button
              disabled={
                busy || scope.loading || !machine || !!target?.unavailable || !folder.trim()
              }
              onClick={() => void measure()}
            >
              {chooseFirst ? "Measure the folder" : `Copy to ${targetLabel}`}
            </Button>
          ))}
        {(stage === "select" || stage === "planning") && (
          <>
            <Button disabled={busy || selection.length === 0} onClick={() => void plan()}>
              {stage === "planning"
                ? "Comparing folders…"
                : auto
                  ? `Copy to ${targetLabel}`
                  : `Preview on ${targetLabel}`}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void stop()}>
              Cancel copy
            </Button>
          </>
        )}
        {stage === "preview" && copy && (
          <>
            {replaced ? (
              <>
                <Button
                  disabled={busy || !!copy.disk || secretsUnconfirmed}
                  onClick={() => void replaceAll()}
                >
                  Replace all
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !!copy.disk ||
                    (copy.totals?.decisionsNeeded ?? 1) > 0 ||
                    secretsUnconfirmed
                  }
                  onClick={() => void apply()}
                >
                  Copy with these choices
                </Button>
              </>
            ) : (
              <Button
                disabled={busy || (copy.totals?.decisionsNeeded ?? 1) > 0 || secretsUnconfirmed}
                onClick={() => void apply()}
              >
                {approveLabel}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => void stop()}>
              Cancel copy
            </Button>
          </>
        )}
        {(stage === "copying" || stage === "moving") && (
          <>
            <Button disabled>
              {stage === "moving"
                ? "Transferring context…"
                : copy?.state === "applying"
                  ? "Applying files…"
                  : "Copying files…"}
            </Button>
            {stage === "copying" &&
              copy &&
              copy.state !== "applying" &&
              copy.state !== "applied" && (
                <Button variant="outline" disabled={working} onClick={() => void stop()}>
                  Cancel copy
                </Button>
              )}
          </>
        )}
        {stage === "failed" && copy && (
          <HandoffCopyFailedActions
            copy={copy}
            busy={busy}
            failedBeforeApply={failedBeforeApply}
            undoPreview={undoPreview}
            onCopyAgain={() => void copyAgainNow()}
            onRetry={() => void retryCopy()}
            onCancel={() => void stop()}
            onUndo={(force, previewOnly) => void undoCopy(force, previewOnly)}
          />
        )}
        {stage === "done" && copy && copy.projectId && machine && (
          <HandoffCopyDoneActions
            copy={copy}
            mode={mode}
            busy={busy}
            targetLabel={targetLabel}
            copyAgain={offerCopyAgain}
            canTransfer={mode === "copy-and-move" && !contextTransferred}
            canUndo={mode === "copy-only" && pending !== null}
            undoPreview={undoPreview}
            linkReview={mode === "copy-only" && link?.status === "review"}
            startNewLocked={transferRecovery}
            onCopyAgain={() => void copyAgainNow()}
            onTransfer={
              pending &&
              (() =>
                void run(() =>
                  moveCoordinator(
                    pending.operationId,
                    machine,
                    copy.projectId!,
                    copy,
                    movingAnyway,
                  ),
                ))
            }
            onOpen={() =>
              onOpenProject({
                environmentId: machine,
                projectId: copy.projectId!,
                folder:
                  copy.projectFolder ??
                  copiedProjectFolder(
                    copy.targetFolder,
                    copy.projectRelativePath ?? pending?.projectRelativePath,
                  ),
              })
            }
            onUndo={(force, previewOnly) => void undoCopy(force, previewOnly)}
            onLink={() => setLinkDialog(true)}
            onStartNew={fresh}
          />
        )}
        {stage === "undone" && (
          <Button variant="outline" onClick={fresh}>
            Start a new copy
          </Button>
        )}
      </HandoffCopyActions>
    </div>
  );
}
