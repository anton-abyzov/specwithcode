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
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import {
  copySettled,
  copyDestinationKey,
  copiedProjectFolder,
  DEFAULT_COPY_SELECTION,
  type HandoffFolderMethod,
} from "../../studio/folderCopy";
import { randomUUID } from "../../lib/utils";
import { useCopyScope } from "./HandoffCopyScope";
import { useCopyDestination } from "./useCopyDestination";
import { handoffErrorMarksStep } from "./handoffErrors";
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
import type { CopyMachine } from "./HandoffCopySetup";
import { copyHeld } from "./HandoffCopyDone";
import { messageOf } from "./useCoordinatorTransfer";
import { useCoordinatorMove } from "./useCoordinatorMove";
import {
  nextStepText,
  workingLine,
  recompareFor,
  stageForStatus,
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
} from "./handoffCopyAuto";
import { copyNoticeWarnings, copyProblem, groupCopyNotices } from "./handoffCopyNotices";
import { copyNeedsComparison, decideCopyClones } from "./handoffCopySnapshot";
import {
  CopyCheckingStep,
  CopyChoicesSummary,
  CopyResumeNote,
  CopyStepLine,
} from "./HandoffCopyGuide";
import { useCopyStepView } from "./useCopyStepView";
import { useCopyDraft } from "./useCopyDraft";
import {
  needsNewCopyComparison,
  refreshCopyScan,
  newCopyComparison,
} from "./handoffCopyScanRecovery";
import { HandoffCopyScanFreshness } from "./HandoffCopyScanFreshness";
import { HandoffCopyStepPanels } from "./HandoffCopyStepPanels";
import {
  absolute,
  APPLYING,
  insideSkipped,
  NOT_ABSOLUTE,
  openCopiedProject,
  POLL_MS,
  REPOSITORY_SETTLE_MS,
  useCopyReporting,
  type CopyChoices,
} from "./handoffFolderCopyRules";
import { useCopyLink } from "./useCopyLink";
import { HandoffCopyFooter } from "./HandoffCopyFooter";
import { HandoffWorkspaceSummary, type HandoffWorkspaceContext } from "./HandoffWorkspaceSummary";
import type { RepositoryChoices } from "./HandoffCopyPreview";

export { folderCopyStorageKey, isFolderCopyNotFound, readPendingCopy };
export type { CopyMachine };

type Stage = CopyStage;

/**
 * Copies the project folder to another machine: the destination pulls the files from
 * this machine, previews what changes, and applies only after approval.
 */

export function HandoffFolderCopy({
  project,
  coordinatorId,
  workspaceContext,
  sourceLabel,
  method,
  machines,
  savedFolder,
  savedProject,
  preferredMachine = null,
  machineRequested = false,
  defaultMode,
  onChoicesChange,
  canMove,
  onBusyChange,
  onCloseLockChange,
  onOpenProject,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly workspaceContext?: HandoffWorkspaceContext;
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
  /** True when the dialog was opened for that machine (Move coordinator to X): a draft keeps it. */
  readonly machineRequested?: boolean;
  /** Move or copy, as the dialog was opened; it wins over a draft, a resumed copy keeps its own. */
  readonly defaultMode?: FolderCopyMode;
  /** The live choices and stage, so the dialog can title itself and remember the machine. */
  readonly onChoicesChange?: (choices: {
    readonly mode: FolderCopyMode;
    readonly machine: EnvironmentId | null;
    readonly done: boolean;
  }) => void;
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

  const storageKey = folderCopyStorageKey(project.environmentId, project.id);
  const { machine, setMachine, folderDraft, setFolderDraft, folder, setFolder, findingHome } =
    useCopyDestination({ machines, preferredMachine, savedFolder, scope });
  const [mode, setMode] = useState<FolderCopyMode>(
    canMove ? (defaultMode ?? "copy-only") : "copy-only",
  );
  // Off: one click measures, compares and copies; on: stop after measuring to choose.
  const [chooseFirst, setChooseFirst] = useState(false);
  const [stage, setStage] = useState<Stage>("setup");
  const [offer, setOffer] = useState<FolderCopyOffer | null>(null);
  const [scanStatus, setScanStatus] = useState<FolderCopySourceStatus | null>(null);
  const legacyOperation = useRef<string | undefined>(undefined);
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
  // The source dropped an undone copy that the destination could not give back.
  const [sourceDropped, setSourceDropped] = useState(false);
  const [copyAgain, setCopyAgain] = useState(false);
  // Why the destination compares again; null for the first compare.
  const [recompare, setRecompare] = useState<CopyRecompare>(null);
  const [working, setWorking] = useState(false);
  // Clone and skip choices not yet in the destination's plan, and whether it is re-comparing.
  const [repositoryChoices, setRepositoryChoices] = useState<RepositoryChoices | null>(null);
  const [replanning, setReplanning] = useState(false);
  const repositoryDraft = useRef<RepositoryChoices | null>(null);
  const repositoryTimer = useRef<number | null>(null);
  const repositorySending = useRef(false);
  const [linkDialog, setLinkDialog] = useState(false);
  // The machine a copy was just cancelled for before Apply, said once on the setup form.
  const [cancelledFor, setCancelledFor] = useState<string | null>(null);
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
  const abort = useRef(new AbortController());
  // Aborted by the Cancel button while measuring; the dialog closing uses `abort`.
  const measureStop = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = abort.current;
    return () => {
      controller.abort();
      if (repositoryTimer.current !== null) window.clearTimeout(repositoryTimer.current);
    };
  }, []);

  const target = machines.find((entry) => entry.id === machine) ?? null;
  const targetLabel = target?.label ?? "the other machine";
  const { busy, closeLocked } = useCopyReporting({
    environmentId: project.environmentId,
    projectId: project.id,
    stage,
    working,
    mode,
    machine,
    copy,
    existingDestination: pending?.existingDestination,
    scanStatus,
    machineName: targetLabel,
    onBusyChange,
    onChoicesChange,
    onCloseLockChange,
  });

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
  const {
    transferNotice,
    contextTransferred,
    movedAnyway,
    transferRecovery,
    setTransferRecovery,
    sourceReview,
    leftOnSource,
    keptHere,
    moveCoordinator,
    ...move
  } = useCoordinatorMove({
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
  });
  const { link, setLink, markLinked } = useCopyLink({
    project,
    sourceLabel,
    targetLabel,
    machine,
    stage,
    mode,
    copyProjectId: copy?.projectId,
    latestPending,
    remember,
  });

  // A one-click copy runs straight through; a pointer from an earlier session keeps its own kind.
  const auto = pending ? pending.auto === true : !chooseFirst;
  const stepView = useCopyStepView({
    stage,
    mode,
    auto,
    contextTransferred,
    copy,
    held: stage === "failed" && copyHeld(copy),
    errored: error !== null && handoffErrorMarksStep(error, stage),
    working,
    pending,
    latestPending,
    remember,
    sourceLabel,
    // Only a linked copy: a link still running or needing review is tried again on reopen.
    doneReached:
      stage === "done" &&
      mode === "copy-only" &&
      copy?.committed === true &&
      copyProblem(copy, sourceLabel) === null &&
      link?.status === "linked",
  });
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
      setScanStatus(scanned);
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
        setCancelledFor(targetLabel);
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
  const abandonSource = async (
    saved: PendingCopy,
    reason: string,
    strict: boolean,
    retainPending = false,
  ) => {
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
    if (!retainPending) remember(null);
  };

  const show = (next: FolderCopyStatus) => setStage(stageForStatus(next));

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
      legacyOperation.current = measured.capturedAt === undefined ? saved.operationId : undefined;
      setScanStatus(measured);
      setSummary(measured.summary ?? null);
      if (measured.summary) {
        // A ticked file the source no longer lists is unticked, not sent and refused.
        const listed = new Set(measured.summary.secretFiles.map((file) => file.path));
        setSecretPaths((ticked) =>
          ticked.every((path) => listed.has(path))
            ? ticked
            : ticked.filter((path) => listed.has(path)),
        );
      }
      return measured.summary;
    } catch {
      legacyOperation.current = undefined;
      return null;
    }
  };

  const cloneDecide = (saved: PendingCopy, previewed: FolderCopyStatus) =>
    decideCopyClones(
      saved,
      previewed,
      method,
      async (clone) => {
        unwrap(
          await decide({
            environmentId: saved.environmentId as EnvironmentId,
            input: { operationId: saved.operationId, clone },
          }),
        );
      },
      () => pollCopy(saved.environmentId as EnvironmentId, saved.operationId),
      (next) => {
        if (latestPending.current?.operationId === saved.operationId) remember(next);
      },
    );

  /** Drops a pointer's pending Replace all once the person has to look at the plan again. */
  const withoutReplaceAll = (saved: PendingCopy): PendingCopy => {
    if (!saved.replaceAll) return saved;
    const { replaceAll: _dropped, replaceAllOutcome: _outcome, ...rest } = saved;
    if (latestPending.current?.operationId === saved.operationId) remember(rest);
    return rest;
  };

  /** Auto-approves only a current preview with no replacements or an explicit Replace all. */
  const settlePreview = async (next: FolderCopyStatus, saved: PendingCopy) => {
    if (next.state === "previewed" && !saved.needsComparison) {
      if (saved.replaceAll) {
        // The ticked secret files went to the source when Replace all was clicked.
        if (replaceAllReady(next)) {
          await applyNow(saved, true);
          return;
        }
        withoutReplaceAll(saved);
      } else if (
        saved.auto &&
        replacesNothing(next) &&
        next.capturedAt === undefined &&
        legacyOperation.current === saved.operationId
      ) {
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
    await readSummary(compared.saved);
    await settlePreview(compared.next, compared.saved);
  };

  // Resume a copy this browser started before a reload or a closed dialog.
  const resume = (saved: PendingCopy) => {
    stepView.armRestore(saved);
    // Secret files and worktrees shown must be this copy's, never an earlier copy's.
    if (latestPending.current?.operationId !== saved.operationId) {
      setSummary(null);
      setSecretPaths([]);
      setSecretsConfirmed(false);
    }
    latestPending.current = saved;
    setPending(saved);
    // A copy linked before the dialog closed is not linked again.
    if (saved.linked) setLink({ status: "linked" });
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
      }
    });
  };
  const draft = useCopyDraft({
    project,
    machines,
    canMove,
    explicit: { mode: defaultMode !== undefined, machine: machineRequested },
    form: { machine, folderDraft, mode, chooseFirst },
    latestPending,
    setForm: { machine: setMachine, folder: setFolder, mode: setMode, chooseFirst: setChooseFirst },
    onResume: resume,
  });

  /** A move registers the copied project under one id; a known folder keeps its own. */
  const destinationProjectId = (
    environmentId: EnvironmentId,
    mode: FolderCopyMode,
    projectFolder: string,
  ) =>
    mode === "copy-and-move"
      ? (knownProject(environmentId, projectFolder)?.id ??
        copiedProjects.current.get(copyDestinationKey(environmentId, projectFolder)) ??
        randomUUID())
      : null;

  /** Measures, then (one-click) compares and copies, with these choices. */
  const measureNow = async (choices: CopyChoices) => {
    const { machine, folder, mode, selection, copyRoot, projectRelativePath } = choices;
    if (machines.find((entry) => entry.id === machine)?.unavailable || scope.loading) return;
    if (!absolute(folder)) throw new Error(NOT_ABSOLUTE);
    // Every later step (poll, apply, cancel, move, open) reads this machine: pin it.
    setMachine(machine);
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
    const operationId = randomUUID();
    setSummary(null);
    setSecretPaths([]);
    setSecretsConfirmed(false);
    const projectFolder = copiedProjectFolder(folder, projectRelativePath);
    const projectId = destinationProjectId(machine, mode, projectFolder);
    const existing = mode === "copy-and-move" && knownProject(machine, projectFolder) !== null;
    setCancelledFor(null);
    // The pointer holds the choices from here; the draft was for an unsent form.
    draft.dropDraft();
    const saved: PendingCopy = {
      operationId,
      environmentId: machine,
      mode,
      targetFolder: folder,
      copyRoot,
      projectRelativePath,
      projectId,
      selection,
      method: choices.method,
      ...(choices.auto ? { auto: true } : {}),
      ...(existing ? { existingDestination: true } : {}),
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

  const refreshScan = () =>
    run(async () => {
      if (!pending) return;
      await refreshCopyScan(
        async () =>
          unwrap(
            await sourceStatus({
              environmentId: project.environmentId,
              input: { operationId: pending.operationId, refresh: true },
            }),
          ),
        setScanStatus,
        setSummary,
      );
    });

  const sourceChanged = copyNeedsComparison(scanStatus, pending, copy);
  const choose = (next: ReadonlyArray<FolderCopyFileClass>) => {
    setSelection(next);
    if (pending) remember({ ...pending, selection: next });
  };

  const plan = () =>
    run(async () => {
      if (!offer || !pending) return;
      if (sourceChanged)
        throw new Error("Measure and compare again before previewing this changed source.");
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

  /**
   * Clone and skip clicks show at once and wait briefly, so several clicks re-compare
   * once. The preview stays on screen while the destination compares; Copy waits for it.
   */
  const changeRepositories = (next: RepositoryChoices) => {
    repositoryDraft.current = next;
    setRepositoryChoices(next);
    // Secret files inside a repository left out stay here too.
    setSecretPaths((ticked) =>
      ticked.filter((path) => !insideSkipped(path, next.skip, copy?.rows ?? [])),
    );
    if (repositoryTimer.current !== null) window.clearTimeout(repositoryTimer.current);
    repositoryTimer.current = window.setTimeout(() => {
      repositoryTimer.current = null;
      void sendRepositories();
    }, REPOSITORY_SETTLE_MS);
    setReplanning(true);
  };
  const sendRepositories = async () => {
    if (repositorySending.current) return;
    repositorySending.current = true;
    try {
      for (;;) {
        const sent = repositoryDraft.current;
        const saved = latestPending.current;
        if (!sent || !saved) break;
        const environmentId = saved.environmentId as EnvironmentId;
        if (saved.replaceAll) withoutReplaceAll(saved);
        unwrap(
          await decide({
            environmentId,
            input: { operationId: saved.operationId, clone: sent.clone, skip: sent.skip },
          }),
        );
        const next = await pollCopy(environmentId, saved.operationId);
        // Clicks made while comparing go out in one more round.
        if (repositoryDraft.current !== sent) continue;
        repositoryDraft.current = null;
        setRepositoryChoices(null);
        if (next.state !== "previewed") show(next);
        break;
      }
    } catch (cause) {
      repositoryDraft.current = null;
      setRepositoryChoices(null);
      if (!isAbortError(cause)) setError(messageOf(cause));
    } finally {
      repositorySending.current = false;
      if (repositoryTimer.current === null) setReplanning(false);
    }
  };

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

  /** Approves, then checks a failed answer once in case the approval landed anyway. */
  const applyNow = async (saved: PendingCopy, secretsSent = false) => {
    const environmentId = saved.environmentId as EnvironmentId;
    const operationId = saved.operationId;
    if (sourceChanged)
      throw new Error("The source changed. Measure and compare again before copying.");
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
        const reviewed = withoutReplaceAll(saved);
        if (needsNewCopyComparison(cause))
          remember({ ...reviewed, needsComparison: true, planShown: true });
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
    if (failedBeforeApply) return copyAgainNow(true);
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

  /**
   * Cancels a copy that has not applied anything: the destination drops its compare, the
   * source its snapshot, and a move releases its fence. Machine, folder, mode and the
   * chosen classes stay in the form.
   */
  const cancelBeforeApply = async () => {
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
    setCancelledFor(targetLabel);
  };

  const stop = () => run(cancelBeforeApply);

  /** Puts a copy's machine, folder, mode and kind back in the setup form. */
  const fillSetup = (saved: PendingCopy) => {
    const environmentId = saved.environmentId as EnvironmentId;
    setMachine(environmentId);
    setFolder(saved.targetFolder, environmentId, saved.copyRoot);
    setMode(saved.mode);
    setChooseFirst(saved.auto !== true);
    setSelection(saved.selection ?? DEFAULT_COPY_SELECTION);
  };

  /** Cancels this copy and opens the setup form with its choices, ready to edit. */
  const changeWhere = () => {
    const saved = latestPending.current;
    if (saved) {
      fillSetup(saved);
      draft.keepDraftOf(saved);
    }
    // Measuring runs inside its own step; stopping it cancels the same way Cancel copy does.
    if (stage === "scanning") measureStop.current?.abort();
    else void run(cancelBeforeApply);
  };

  /** A new comparison requires a fresh operation; nothing was applied yet. */
  const rechoose = () => {
    const saved = latestPending.current;
    if (!saved) return;
    void run(async () => {
      await cancelBeforeApply();
      const next = newCopyComparison(saved, method, scope.selected);
      setChooseFirst(true);
      setSelection(next.selection);
      await measureNow(next);
    });
  };

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

  const endUndoSourceHold = () =>
    run(async () => {
      if (!pending || !copy?.undoIncomplete || copy.committed) return;
      await abandonSource(
        pending,
        "Ended the source hold; destination Undo recovery is retained.",
        true,
        true,
      );
      setSourceDropped(true);
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
    // A finished copy-only copy stays one click away as the last copy, with its Undo.
    const finished = latestPending.current;
    if (finished?.mode === "copy-only" && copy?.state === "applied" && copy.committed)
      draft.archive(finished);
    move.reset();
    remember(null);
    setOffer(null);
    setSummary(null);
    setCopy(null);
    setUndoPreview(null);
    setLink(null);
    setError(null);
    setSourceDropped(false);
    setCopyAgain(false);
    setRecompare(null);
    setCancelledFor(null);
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
  const copyAgainNow = (retried = false) =>
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
      if (failedBeforeApply)
        // The source may still hold the old operation and its snapshot if the destination
        // could not hand it back; drop it before the fresh copy loses its id.
        await sourceCancel({
          environmentId: project.environmentId,
          input: { operationId: last.operationId, reason: "Copying again after a failed copy." },
        }).catch(() => null);
      await startOver(true);
      if (retried) stepView.restarted();
      setChooseFirst(!again.auto);
      setSelection(again.selection);
      await measureNow(again);
    });

  const failedBeforeApply =
    copy?.state === "failed" && copy.failedStep !== "applying" && copy.failedStep !== "applied";
  const rootLabel =
    (pending?.projectRelativePath ?? scope.selected.projectRelativePath) !== "."
      ? "Umbrella root"
      : "Project root";
  const approveLabel = `${mode === "copy-and-move" ? "Hand off" : "Copy"} to ${targetLabel}`;
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
  const next = nextStepText({
    stage,
    auto,
    targetLabel,
    approveLabel,
    failedBeforeApply,
    held: stage === "failed" && copyHeld(copy),
    move: mode === "copy-and-move",
  });
  const notices = groupCopyNotices({
    captured: (copy?.capturedAt ?? scanStatus?.capturedAt) !== undefined,
    skipped: summary?.skipped,
    linksOutside: summary?.linksOutside,
    warnings: copyNoticeWarnings(summary, copy, scanStatus?.freshness?.summary !== undefined),
    rootLabel,
    mode,
    done: stage === "done",
    activeWork: stage === "select" || stage === "preview" ? mode : null,
  });
  // Transfer and Open act on the applied copy shown on Done; only Done renders them.
  const transfer =
    pending && machine && copy?.projectId
      ? () =>
          void run(() =>
            moveCoordinator(pending.operationId, machine, copy.projectId!, copy, movingAnyway),
          )
      : null;
  const openCopy = () => openCopiedProject(machine, copy, pending, onOpenProject);
  // The source listed what changed after copying: move without it, or keep the coordinator.
  const moveWithout = () =>
    void run(async () => {
      if (pending && machine && copy?.projectId)
        await move.moveWithout(pending.operationId, machine, copy.projectId, copy, movingAnyway);
    });
  const keepHere = () =>
    void run(async () => {
      if (pending) await move.keepHere(pending.operationId);
    });

  return (
    <div className="space-y-4" data-slot="handoff-folder-copy" data-stage={stage}>
      <HandoffWorkspaceSummary
        transferContext={(pending?.mode ?? mode) === "copy-and-move"}
        source={workspaceContext ?? { projectFolder: project.workspaceRoot }}
        copyRoot={pending?.copyRoot ?? scope.selected.copyRoot}
        destinationFolder={copiedProjectFolder(
          pending?.targetFolder ?? folder,
          pending?.projectRelativePath ?? scope.selected.projectRelativePath,
        )}
        destinationCheckout={copy?.projectFolder}
        destinationWorktreeStorage={target?.worktreeStorage}
      />
      <CopyStepLine steps={stepView.steps} />
      {stepView.note && <CopyResumeNote>{stepView.note}</CopyResumeNote>}
      {stepView.checking ? (
        <CopyCheckingStep
          checking={stepView.checking}
          folder={pending?.targetFolder ?? folder}
          targetLabel={targetLabel}
          error={error}
          onCheckAgain={() => pending && resume(pending)}
          onStartNew={
            pending?.reopened
              ? () => {
                  stepView.dropRestore();
                  draft.archive(pending);
                  fresh();
                }
              : undefined
          }
        />
      ) : (
        <>
          {stage === "setup" && cancelledFor && (
            <p role="status" className="text-sm" data-slot="copy-cancelled">
              Copy cancelled. Nothing on {cancelledFor} changed.
            </p>
          )}
          <HandoffCopyStepPanels
            stage={stage}
            project={project}
            scope={scope}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
            busy={busy}
            pending={pending}
            summary={summary}
            measured={measured}
            copy={copy}
            machines={machines}
            machine={machine}
            onMachineChange={(id) => {
              setMachine(id);
              setFolderDraft(null);
              draft.keepDraft({ machine: id });
            }}
            folder={folder}
            onFolderChange={(value) => {
              setFolder(value);
              draft.keepDraft({ folder: value });
            }}
            findingHome={findingHome}
            mode={mode}
            onModeChange={(next) => {
              setMode(next);
              draft.keepDraft({ mode: next });
            }}
            canMove={canMove}
            chooseFirst={chooseFirst}
            onChooseFirstChange={(next) => {
              setChooseFirst(next);
              draft.keepDraft({ chooseFirst: next });
            }}
            selection={selection}
            onChoose={choose}
            auto={auto}
            rootLabel={rootLabel}
            replaced={replaced}
            replaceLeft={replaceLeft}
            replacingFiles={replacingFiles}
            onChange={(input) => void change(input)}
            repositoryChoices={repositoryChoices}
            onRepositories={changeRepositories}
            replanning={replanning}
            secretPaths={secretPaths}
            secretsConfirmed={secretsConfirmed}
            onSecretPathsChange={setSecretPaths}
            onSecretsConfirmedChange={setSecretsConfirmed}
            failedBeforeApply={failedBeforeApply}
            undoPreview={undoPreview}
            contextTransferred={contextTransferred}
            movedRetention={move.movedRetention}
            transferNotice={transferNotice}
            transferBusy={move.transferBusy}
            movingAnyway={movingAnyway}
            copyAgain={offerCopyAgain}
            sourceReview={sourceReview}
            leftOnSource={leftOnSource}
            keptHere={keptHere}
            secretsNote={secretsNote}
            link={link}
            linkDialog={linkDialog}
            onLinkDialogClose={() => setLinkDialog(false)}
            onLinked={() => {
              setLink({ status: "linked" });
              markLinked(pending?.operationId);
            }}
            sourceDropped={sourceDropped}
            notices={notices}
            next={next}
            working={workingLine({ stage, targetLabel, measured, copy, recompare })}
            choices={
              // Not on Review (its footer has Change setup) or after Apply: nothing to change.
              pending &&
              stage !== "setup" &&
              stage !== "preview" &&
              stage !== "done" &&
              stage !== "undone" &&
              (stage !== "failed" || failedBeforeApply) ? (
                <CopyChoicesSummary
                  pending={pending}
                  copy={copy}
                  sourceRoot={offer?.copyRoot ?? project.workspaceRoot}
                  targetLabel={targetLabel}
                  method={pending.method ?? method}
                  // Before Apply only.
                  onChange={
                    (stage !== "copying" || !APPLYING.has(copy?.state ?? "")) && stage !== "moving"
                      ? changeWhere
                      : null
                  }
                  changeDisabled={closeLocked || (working && stage !== "scanning")}
                />
              ) : null
            }
            lastCopy={draft.lastCopy}
            onViewLast={draft.viewLastCopy}
          />
          {(stage === "select" || stage === "preview") && (
            <HandoffCopyScanFreshness
              capturedAt={copy?.capturedAt}
              status={scanStatus}
              sourceChanged={sourceChanged}
              busy={busy}
              onRefresh={() => void refreshScan()}
              onCompareAgain={rechoose}
            />
          )}
          <HandoffCopyFooter
            sourceChanged={sourceChanged}
            onCompareAgain={rechoose}
            stage={stage}
            error={error}
            busy={busy || replanning}
            working={working}
            pending={pending}
            copy={copy}
            machine={machine}
            mode={mode}
            targetLabel={targetLabel}
            sourceLabel={sourceLabel}
            auto={auto}
            chooseFirst={chooseFirst}
            selection={selection}
            setupBlocked={scope.loading || !machine || !!target?.unavailable || !folder.trim()}
            replaced={replaced}
            approveLabel={approveLabel}
            secretsUnconfirmed={secretsUnconfirmed}
            failedBeforeApply={failedBeforeApply}
            undoPreview={undoPreview}
            copyAgain={offerCopyAgain}
            contextTransferred={contextTransferred}
            link={link}
            transferRecovery={transferRecovery}
            sourceReview={offerCopyAgain ? sourceReview : null}
            onMoveWithout={moveWithout}
            onKeepHere={keepHere}
            onCancelMeasure={() => measureStop.current?.abort()}
            onResume={resume}
            onMeasure={() => void measure()}
            onPlan={() => void plan()}
            onStop={() => void stop()}
            onReplaceAll={() => void replaceAll()}
            onApply={() => void apply()}
            onCopyAgain={() => void copyAgainNow()}
            onRetry={() => void retryCopy()}
            onUndo={(force, previewOnly) => void undoCopy(force, previewOnly)}
            onEndSourceHold={() => void endUndoSourceHold()}
            sourceDropped={sourceDropped}
            onTransfer={transfer}
            onOpen={openCopy}
            onLink={() => setLinkDialog(true)}
            onStartNew={fresh}
            onChangeSetup={changeWhere}
          />
        </>
      )}
    </div>
  );
}
