import { useAtomValue } from "@effect/atom-react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthSettingsWriteScope,
  logicalProjectTitle,
  type MachineHandoffPrepareResult,
  type MachineHandoffReceiveResult,
  type MachineHandoffBundle,
  type MachineHandoffBusyThreads,
  type MachineHandoffUpdateSkipped,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useNamedEnvironments } from "../settings/useNamedEnvironments";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { acceptsRetention, retentionOf, RETENTION_UPDATE_MESSAGE } from "./handoffRetention";
import {
  machineHandoffStorageKey,
  parsePendingMachineHandoff,
} from "../../studio/machineHandoffPending";
import { projectWorkspaceSearch } from "../../studio/projectPaneThreads";
import { randomUUID } from "../../lib/utils";
import { derivePhysicalProjectKeyFromPath } from "../../logicalProject";
import {
  MachineHandoffButton,
  MachineHandoffDialog,
  type MoveIntent,
} from "./MachineHandoffDialog";
import { HandoffLeftBehind } from "./HandoffLeftBehind";
import type { MachineOption } from "../handoff/MachineOptionRows";
import { Tip } from "./shell/Tip";
import { HandoffFolderPicker } from "./HandoffFolderPicker";
import { toastManager } from "../ui/toast";
import { HandoffFolderCopy, folderCopyStorageKey } from "./HandoffFolderCopy";
import { useRetiredMachineRecords } from "../settings/useReplacedMachineRecords";
import { machineHoldings, otherProjectOf, pickedHolding } from "../../studio/sendToMachine";
import { addToMachineRoute } from "../../studio/addToMachine";
import { addableMachineIds, projectFoldersElsewhere } from "../../studio/addableMachines";
import { useTx } from "../../i18n";
import { moveRefusal } from "./ProjectMoveOptions";
import { closeCopyReviewToast } from "./folderCopyToasts";
import {
  copyActivityKey,
  registerCopyOpener,
  unwatchCopy,
  watchCopy,
} from "../../studio/folderCopyActivity";
import {
  copyDestinationKey,
  DEFAULT_COPY_METHOD,
  type HandoffFolderMethod,
} from "../../studio/folderCopy";
import { useStudioFleet } from "../../studio/fleet";
import {
  handoffMachinePreferenceKey,
  pickHandoffMachine,
  readHandoffMachinePreference,
  readMachinesSeen,
  recordMachinesSeen,
  writeHandoffMachinePreference,
  type HandoffMachine,
} from "../../studio/handoffMachinePreference";
import { environmentServerConfigsAtom } from "../../state/server";
import { destinationDefaultWorktreeStorage } from "./HandoffWorkspaceSummary";
import { useHandoffSourceChanges } from "./useHandoffSourceChanges";
import {
  machineConnecting,
  machinesSettling,
  machineUnavailable,
  moveBlockedReason,
  useMachinesSettling,
} from "../../studio/handoffMachineList";
import { MoveDialogHold } from "../../studio/moveDialogHold";
import { HandoffAccountMachines } from "./HandoffAccountMachines";
import { HandoffBusyThreads } from "./HandoffBusyThreads";
import { refusedBusyOf } from "./handoffCopySteps";
import { sameStaleReason } from "../../studio/staleCopyText";
import { readPendingCopy, type PendingCopy } from "./handoffFolderCopyPending";
import { AddHeldByCopy } from "./AddHeldByCopy";

function previewInput(projectId: ProjectId, bundle: MachineHandoffBundle) {
  return {
    projectId,
    operationId: bundle.manifest.operationId,
    mode: "preview" as const,
    manifest: bundle.manifest,
    sourceEnvironmentId: bundle.sourceEnvironmentId,
    sourceProjectId: bundle.sourceProjectId,
    sourceThreadId: bundle.sourceThreadId,
    digest: bundle.digest,
    ...(bundle.logicalProject ? { logicalProject: bundle.logicalProject } : {}),
    ...(bundle.coordinatorBinding ? { coordinatorBinding: bundle.coordinatorBinding } : {}),
    ...(bundle.destination ? { destination: bundle.destination } : {}),
  };
}

/** An interrupted request has nothing to tell a person beyond trying again. */
const isInterruptedMessage = (message: string) => message.includes("fibers interrupted");

/**
 * Which way the machine menu opens the dialog; `seq` makes each pick a new request.
 * "copy" opens the folder copy review directly, on `machine` when given: Run on's
 * Add to another machine… for a project with no Git remote, which has nothing to clone.
 * "add" offers only machines that do not have the project yet.
 */
export interface MachineHandoffOpenRequest {
  /** "sync": a copy-only review into `machine`'s existing folder; the coordinator stays here. */
  readonly mode: "add" | "move" | "copy" | "sync";
  readonly seq: number;
  readonly machine?: EnvironmentId;
  /** "sync": the copy chosen in the menu, `${environmentId}:${projectId}`. */
  readonly target?: string;
  /** How files travel, instead of the default: "copy" is the measured per-file compare. */
  readonly method?: HandoffFolderMethod;
}

export function ProjectMachineHandoff({
  project,
  coordinatorId,
  onOpenChange,
  requestedTarget = null,
  openRequest = null,
  onRequestHandled,
  showTrigger = true,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly onOpenChange?: (open: boolean) => void;
  readonly requestedTarget?: string | null;
  /** Set by the project's machine menu: Sync and Add. */
  readonly openRequest?: MachineHandoffOpenRequest | null;
  /**
   * Told once the request was acted on, so the parent drops it: this component is mounted
   * again when the window switches machine, and a request still held would open the dialog.
   */
  readonly onRequestHandled?: (request: MachineHandoffOpenRequest) => void;
  /** Off where the machine menu opens the dialog instead of its own button. */
  readonly showTrigger?: boolean;
}) {
  const tx = useTx();
  const { environments, isReady: catalogReady } = useNamedEnvironments();
  const projects = useProjects();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const sourceThread = useThreadShell(
    coordinatorId ? { environmentId: project.environmentId, threadId: coordinatorId } : null,
  );
  const workspaceContext = {
    projectFolder: project.workspaceRoot,
    repository: project.repositoryIdentity
      ? project.workspaceRoot
      : "No repository selected (project coordinator)",
    checkout: sourceThread ? (sourceThread.worktreePath ?? project.workspaceRoot) : null,
    branch: sourceThread?.branch,
    mode: sourceThread
      ? sourceThread.worktreePath
        ? ("worktree" as const)
        : ("local" as const)
      : null,
  };
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const canGit = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  const canWrite = useEnvironmentsWithScope(environments, AuthFilesystemWriteScope);
  const canConfigure = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const navigate = useNavigate();
  const prepare = useAtomCommand(machineHandoff.prepare, { reportFailure: false });
  const receive = useAtomCommand(machineHandoff.receive, { reportFailure: false });
  const capabilities = useAtomCommand(machineHandoff.copyCapabilities, { reportFailure: false });
  const release = useAtomCommand(machineHandoff.copyRelease, { reportFailure: false });
  const storageKey = machineHandoffStorageKey(project.environmentId, project.id);
  const [open, setOpen] = useState(false);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  // The page stays on this checkout while the dialog is open, even once the coordinator runs
  // on the other machine: a page switched away hides this dialog's page and freezes it.
  const holdPage = useContext(MoveDialogHold);
  useEffect(() => () => holdPage?.(false), [holdPage]);
  const [selected, setSelected] = useState("");
  const [pickerMachine, setPickerMachine] = useState<EnvironmentId | null>(null);
  const preferenceKey = handoffMachinePreferenceKey(project.environmentId, project.id);
  const [preference, setPreference] = useState(() => readHandoffMachinePreference(preferenceKey));
  const fleet = useStudioFleet(project.environmentId);
  const [snapshot, setSnapshotState] = useState<MachineHandoffPrepareResult | null>(null);
  // Handlers read the latest snapshot even before React commits it (a late folder save).
  const latestSnapshot = useRef<MachineHandoffPrepareResult | null>(null);
  const setSnapshot = (value: MachineHandoffPrepareResult | null) => {
    if (!value) setPreviewCheckout(null);
    latestSnapshot.current = value;
    setSnapshotState(value);
  };
  const [previewCheckout, setPreviewCheckout] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<MachineHandoffReceiveResult | null>(null);
  const [consent, setConsent] = useState(false);
  // A Git move into an existing copy that cannot fast-forward: why, and whether the person
  // chose to move anyway on its older commits. The move refuses until they do.
  // `published`: the refusal came after the source fenced, so Keep Main here must release it.
  const [staleCopy, setStaleCopy] = useState<{
    readonly skipped: MachineHandoffUpdateSkipped;
    readonly accepted: boolean;
    readonly published: boolean;
  } | null>(null);
  const [phase, setPhase] = useState<
    "choose" | "checking" | "review" | "transferring" | "complete"
  >("choose");
  const [error, setErrorText] = useState<string | null>(null);
  /** The threads a busy machine named with its refusal, and which machine they are on. */
  const [busyRefusal, setBusyRefusal] = useState<{
    readonly environmentId: EnvironmentId;
    readonly busy: MachineHandoffBusyThreads;
  } | null>(null);
  const setError = (value: string | null) => {
    setErrorText(value);
    setBusyRefusal(null);
  };
  const [canRestart, setCanRestart] = useState(false);
  // A machine that has the project updates through Git; a copy is for one that does not.
  const [method, setMethod] = useState<HandoffFolderMethod>(DEFAULT_COPY_METHOD);
  // Move: Main goes there (Git only, "Make X main", an unfinished move). Copy: files only.
  // The dialog never asks; how it was opened and how files travel decide.
  const [intent, setIntent] = useState<MoveIntent>("move");
  // Opened to move Main ("Make X main"): leaving Git only keeps the move.
  const [moveAsked, setMoveAsked] = useState(false);
  // A move asked for while a copy's done screen is up starts the copy flow afresh.
  const [copyFlowRun, setCopyFlowRun] = useState(0);
  // "Sync to X…": X already has this project, so only files travel, into its own folder.
  const [syncKey, setSyncKey] = useState<string | null>(null);
  // Opened by the menu's Add: only machines without the project are offered.
  const [addOnly, setAddOnly] = useState(false);
  /** An unfinished copy to another machine found when Add was opened: Add leaves it alone. */
  const [heldCopy, setHeldCopy] = useState<PendingCopy | null>(null);
  // The copy flow's machine, so switching to Git keeps it.
  const [copyMachine, setCopyMachine] = useState<EnvironmentId | null>(null);
  // The copy the person picked on a machine that holds several, by machine.
  const [pickedCopies, setPickedCopies] = useState<Readonly<Record<string, string>>>({});
  const [copyDone, setCopyDone] = useState(false);
  const [copyDoneAt, setCopyDoneAt] = useState<string | null>(null);
  const [copyDoneProject, setCopyDoneProject] = useState<string | null>(null);
  const [copyBusy, setCopyBusyState] = useState(false);
  const [copyLocked, setCopyLocked] = useState(false);
  // Sharing is what the dialog opens on; moving and copying files start from it.
  // Read when the dialog closes: a measure or copy still running is watched until it is ready.
  const copyRunning = useRef(false);
  // The copy flow waits at its review: closing hands it to the watcher to observe only.
  const copyAtReview = useRef(false);
  const setCopyBusy = useCallback((value: boolean) => {
    copyRunning.current = value;
    setCopyBusyState(value);
  }, []);
  // A synchronous gate catches double-clicks before React paints the disabled button.
  const running = useRef(false);
  // The operation this dialog prepared without publishing, until a transfer tries to publish it.
  // Only such an operation can be dropped: a publish attempt may already have fenced the source.
  const unpublished = useRef<string | null>(null);
  const [unpublishedOperation, setUnpublishedOperation] = useState<string | null>(null);
  const markUnpublished = (operationId: string | null) => {
    unpublished.current = operationId;
    setUnpublishedOperation(operationId);
  };
  // Sidebar grouping is presentation only. Shell projects omit deleted registrations;
  // transfers still require a known matching repository on another environment.
  // A linked copy of this project is a destination even when its repository reads differently
  // there (or not yet); the destination still verifies the repository before anything moves.
  const candidates = useMemo(() => projectFoldersElsewhere(project, projects), [projects, project]);
  const destinations = candidates.map((item) => {
    const environment = environments.find((entry) => entry.environmentId === item.environmentId);
    return {
      key: `${item.environmentId}:${item.id}`,
      environmentId: item.environmentId,
      label: environment?.label ?? "Machine",
      folder: item.workspaceRoot,
      unavailable:
        environment?.connection.phase !== "connected"
          ? "Connect this machine first."
          : !canOperate.has(item.environmentId) ||
              !canGit.has(item.environmentId) ||
              !canWrite.has(item.environmentId) ||
              !canConfigure.has(item.environmentId)
            ? "This connection needs permission to run work and transfer code."
            : null,
    };
  });
  const connectedIds = environments
    .filter((item) => item.connection.phase === "connected")
    .map((item) => item.environmentId)
    .toSorted()
    .join("\n");
  useEffect(() => {
    recordMachinesSeen(connectedIds ? connectedIds.split("\n") : []);
  }, [connectedIds]);
  const seen = useMemo(() => (open ? readMachinesSeen() : {}), [open]);
  const others = environments.filter((item) => item.environmentId !== project.environmentId);
  // Until the first status read settles, a machine still connecting is not "Connect first".
  const machinesLoading = useMachinesSettling(
    open,
    machinesSettling({
      catalogReady: catalogReady !== false,
      phases: others.map((item) => item.connection.phase),
    }),
  );
  const machines = others
    .filter((item) => !(machinesLoading && machineConnecting(item.connection.phase)))
    .map((item): HandoffMachine & { id: EnvironmentId } => {
      const online = item.connection.phase === "connected";
      const status = fleet.snapshot?.machines.find(
        (machine) => machine.environmentId === item.environmentId,
      )?.workers?.status;
      return {
        id: item.environmentId,
        label: item.label,
        online,
        unavailable: machineUnavailable(
          item.connection.phase,
          canOperate.has(item.environmentId) &&
            canGit.has(item.environmentId) &&
            canWrite.has(item.environmentId) &&
            canConfigure.has(item.environmentId),
        ),
        workersAllowed: status === "allowed" || status === "expiring",
        hasProjectFolder: candidates.some((entry) => entry.environmentId === item.environmentId),
        lastOnlineAt: seen[item.environmentId] ?? null,
      };
    });
  const source = environments.find((item) => item.environmentId === project.environmentId);
  // Said on the disabled button's tooltip: a disabled button alone never says why.
  const blockedReason = moveBlockedReason({
    connected: source?.connection.phase === "connected",
    coordinator: coordinatorId !== null,
    permitted:
      canOperate.has(project.environmentId) &&
      canGit.has(project.environmentId) &&
      canWrite.has(project.environmentId),
  });
  const sourceReady = blockedReason === null;
  const blockedReasonId = useId();
  const target = candidates.find((item) => `${item.environmentId}:${item.id}` === selected);
  // A destination that merges memory gets each note's versions, so its own edits survive.
  const noteVersionsInput =
    target && configs.get(target.environmentId)?.environment.capabilities?.memoryThreeWay === true
      ? { noteVersions: 1 as const }
      : {};
  const destinationPlan = target
    ? {
        environmentId: target.environmentId,
        projectId: target.id,
        executionMode: "project-folder" as const,
        // The folder is already there: it updates from origin, whatever either side has open.
        transport: "git-sync" as const,
        coordinatorThreadId:
          target.workspaceSettings?.coordinatorThreadId ??
          ThreadId.make(`project-coordinator:${target.id}`),
        ...(target.workspaceSettings?.logicalProject
          ? { logicalProjectId: target.workspaceSettings.logicalProject.id }
          : {}),
        ...(target.workspaceSettings?.logicalProject?.id !==
          project.workspaceSettings?.logicalProject?.id || !target.workspaceSettings?.logicalProject
          ? { joinExistingProject: true }
          : {}),
      }
    : undefined;
  /** `at` is the machine the failed call went to: a busy refusal's threads open there. */
  const showError = (cause: unknown, at?: EnvironmentId) => {
    setError(
      cause instanceof Error && !isInterruptedMessage(cause.message)
        ? cause.message
        : "The handoff could not finish. Try it again.",
    );
    const busy = at ? refusedBusyOf(cause) : null;
    if (busy && at) setBusyRefusal({ environmentId: at, busy });
  };
  const reviewed =
    snapshot?.publication === "unpublished" &&
    phase === "review" &&
    unpublishedOperation === snapshot.bundle.manifest.operationId;
  /**
   * Returns to the choices from an unpublished preview. Published checkpoints, and ones a
   * transfer tried to publish, stay until they finish or are recovered. Choices change only
   * when nothing reviewed remains.
   */
  function discardPreview(): "none" | "discarded" | "failed" {
    if (running.current) return "failed";
    const current = latestSnapshot.current;
    if (!current) {
      // A review that failed after preparing leaves an unpublished operation; start fresh.
      try {
        const pending = parsePendingMachineHandoff(localStorage.getItem(storageKey));
        if (pending && pending.operationId === unpublished.current) {
          localStorage.removeItem(storageKey);
          markUnpublished(null);
        }
      } catch {
        /* The retained pointer resumes the same unpublished operation, which is safe. */
      }
      return "none";
    }
    // Refs, not render state: a stale render must not discard a newer or attempted operation.
    if (
      current.publication !== "unpublished" ||
      unpublished.current !== current.bundle.manifest.operationId
    )
      return "failed";
    try {
      localStorage.removeItem(storageKey);
      markUnpublished(null);
    } catch (cause) {
      // A retained pointer would silently reuse this operation; keep the review visible.
      showError(cause);
      return "failed";
    }
    setSnapshot(null);
    setConsent(false);
    setCanRestart(false);
    setError(null);
    setPhase("choose");
    return "discarded";
  }
  // A folder save can finish after its picker is gone; it must see the current review.
  const latestDiscard = useRef(discardPreview);
  useLayoutEffect(() => {
    latestDiscard.current = discardPreview;
  });
  /** `keepWatch`: the dialog opens without the copy flow (Add held by a copy), which goes on being watched. */
  const changeOpen = (value: boolean, keepWatch = false) => {
    // Closing cancels an unpublished review, so the next opening starts from the choices.
    if (!value && phase !== "complete" && discardPreview() === "none") setError(null);
    // The folder copy keeps running on the machines; say when it is ready.
    // The app-wide watcher follows it, whichever project is open next.
    const activityKey = copyActivityKey(project.environmentId, project.id);
    // Closed at its review, a copy stays offered: the sidebar, banner, Needs you and one toast
    // show Review again. The watcher only observes it: nothing is approved.
    const atReview = !copyRunning.current && copyAtReview.current && copyAwaitsReview(project);
    // Add held by an unfinished copy never showed that copy: its own watch carries on.
    const heldOnly = addOnly && heldCopy !== null;
    if (!value && open && !heldOnly && (copyRunning.current || atReview))
      watchCopy({
        ...(atReview ? { reviewOnly: true } : {}),
        environmentId: project.environmentId,
        projectId: project.id,
        machineLabel: (environmentId) =>
          environments.find((item) => item.environmentId === environmentId)?.label ??
          "the other machine",
        sourceLabel: source?.label ?? "this machine",
        projectName: logicalProjectTitle(project),
      });
    // An open dialog follows the copy itself.
    if (value && !keepWatch) {
      unwatchCopy(activityKey);
      closeCopyReviewToast(activityKey);
    }
    setOpen(value);
    holdPage?.(value);
    onOpenChange?.(value);
  };
  // A background copy's toast opens this dialog while this project is on screen.
  const latestChangeOpen = useRef(changeOpen);
  latestChangeOpen.current = changeOpen;
  useEffect(
    () =>
      registerCopyOpener(copyActivityKey(project.environmentId, project.id), () => {
        // Details and Review open the running copy itself, however the dialog was last
        // opened: Add's fresh setup would hide it (1332 AC-04, AC-09).
        setAddOnly(false);
        setHeldCopy(null);
        latestChangeOpen.current(true);
      }),
    [project.environmentId, project.id],
  );
  // A request opens the dialog once. A page kept mounted but hidden runs its effects again
  // when it is shown, and must not replay a request the person already closed.
  const handledTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedTarget) {
      handledTarget.current = null;
      return;
    }
    if (handledTarget.current === requestedTarget) return;
    handledTarget.current = requestedTarget;
    // Every machine keeps its own coordinator: a named machine gets the files, nothing moves.
    setIntent("copy");
    setMoveAsked(false);
    setCopyFlowRun((run) => run + 1);
    setSyncKey(null);
    setAddOnly(false);
    setMethod(DEFAULT_COPY_METHOD);
    setSelected(requestedTarget);
    setPickerMachine(null);
    setSnapshot(null);
    setReceipt(null);
    setConsent(false);
    setPhase("choose");
    setError(null);
    changeOpen(true);
  }, [requestedTarget]);
  // Saved silently on success: the next move preselects this machine.
  const rememberMachine = (environmentId: string) =>
    setPreference(
      writeHandoffMachinePreference(preferenceKey, {
        remembered: environmentId,
        lastUsed: environmentId,
      }),
    );
  const forgetCompleted = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* A retained retry pointer safely resolves to the completed server receipt. */
    }
  };

  const complete = async (completed: MachineHandoffReceiveResult, bundle: MachineHandoffBundle) => {
    if (!target || !completed.coordinatorThreadId)
      throw new Error("The destination coordinator receipt is incomplete.");
    // The source remains fenced until it has durably acknowledged this exact destination.
    if (bundle.logicalProject) {
      const acknowledged = await prepare({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          sourceThreadId: coordinatorId!,
          operationId: bundle.manifest.operationId,
          publish: true,
          expectedDigest: bundle.digest,
          destination: bundle.destination ?? destinationPlan!,
          acknowledgment: {
            operationId: bundle.manifest.operationId,
            environmentId: target.environmentId,
            projectId: completed.projectId,
            coordinatorThreadId: completed.coordinatorThreadId,
            digest: bundle.digest,
          },
        },
      });
      if (acknowledged._tag === "Failure") throw squashAtomCommandFailure(acknowledged);
    }
    rememberMachine(target.environmentId);
    markUnpublished(null);
    setReceipt(completed);
    setPhase("complete");
    forgetCompleted();
    if (requestedTarget && completed.logicalProject) {
      await navigate({
        to: "/projects/$projectKey",
        params: { projectKey: `logical-project:${completed.logicalProject.id}` },
        search: projectWorkspaceSearch(null),
      });
      changeOpen(false);
    }
  };

  const review = async () => {
    // Never into the copy that is Main, nor into a project this copy is not linked to.
    if (running.current || !target || !sourceReady || moveRefusal(send)) return;
    running.current = true;
    setError(null);
    setCanRestart(false);
    setStaleCopy(null);
    setPhase("checking");
    let at: EnvironmentId = project.environmentId;
    try {
      const pending = parsePendingMachineHandoff(localStorage.getItem(storageKey));
      if (pending?.publishing && pending.targetKey !== selected)
        throw new Error(
          "An earlier handoff stopped while publishing. Pick its folder again to finish it.",
        );
      const operationId = pending?.targetKey === selected ? pending.operationId : randomUUID();
      // Persist before either RPC: an ambiguous response retries the same operation.
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          operationId,
          targetKey: selected,
          ...(pending?.targetKey === selected && pending.publishing ? { publishing: true } : {}),
        }),
      );
      let prepared = await prepare({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          sourceThreadId: coordinatorId!,
          operationId,
          publish: false,
          ...noteVersionsInput,
          ...(pending?.targetKey === selected ? {} : { destination: destinationPlan! }),
        },
      });
      if (prepared._tag === "Failure" && pending?.targetKey === selected) {
        const failure = squashAtomCommandFailure(prepared);
        if (
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          failure.code === "invalid"
        ) {
          // The pointer precedes the RPC; a disconnect may have left no source record.
          // Same operation, explicit target: the server refuses replacing any existing plan.
          prepared = await prepare({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              sourceThreadId: coordinatorId!,
              operationId,
              publish: false,
              ...noteVersionsInput,
              destination: destinationPlan!,
            },
          });
        }
      }
      if (prepared._tag === "Failure") {
        const failure = squashAtomCommandFailure(prepared);
        // A pointer naming an operation this project has since left behind: start a new one.
        if (
          pending &&
          !pending.publishing &&
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          failure.code === "conflict"
        )
          setCanRestart(true);
        throw failure;
      }
      // After a publish attempt, even before a reload, the source may already be fenced.
      markUnpublished(
        prepared.value.publication === "unpublished" &&
          !(pending?.targetKey === selected && pending.publishing)
          ? operationId
          : null,
      );
      if (prepared.value.bundle.destination?.executionMode !== "project-folder") {
        setCanRestart(prepared.value.publication === "unpublished" && !!pending);
        throw new Error(
          pending
            ? "This earlier handoff used a temporary folder. Start it again to use the saved folder, or finish the published handoff first."
            : "Update this machine to hand off projects into saved folders.",
        );
      }
      if (
        prepared.value.bundle.destination.environmentId !== target.environmentId ||
        prepared.value.bundle.destination.projectId !== target.id
      )
        throw new Error(
          "An earlier handoff went to a different folder. Finish that handoff first.",
        );
      at = target.environmentId;
      const checked = await receive({
        environmentId: target.environmentId,
        input: previewInput(target.id, prepared.value.bundle),
      });
      if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
      if (checked.value.executionMode !== "project-folder")
        throw new Error("Update the other machine to hand off projects into saved folders.");
      // A summarized coordinator handoff needs a destination that reads the summary.
      if (prepared.value.publication === "unpublished" && retentionOf(prepared.value.bundle)) {
        const supported = await capabilities({
          environmentId: target.environmentId,
          input: {},
        }).catch(() => null);
        if (supported?._tag !== "Success" || !acceptsRetention(supported.value))
          throw new Error(RETENTION_UPDATE_MESSAGE);
      }
      setSnapshot(prepared.value);
      setPreviewCheckout(checked.value.workspacePath);
      setStaleCopy(
        checked.value.updateSkipped
          ? {
              skipped: checked.value.updateSkipped,
              accepted: false,
              // A resumed operation may already be published: Keep Main must release it.
              published: prepared.value.publication === "published",
            }
          : null,
      );
      if (checked.value.phase === "started" && checked.value.coordinatorThreadId) {
        await complete(checked.value, prepared.value.bundle);
      } else setPhase("review");
    } catch (cause) {
      showError(cause, at);
      setPhase("choose");
    } finally {
      running.current = false;
    }
  };

  /** After a refusal past publishing: release the source's fence, so Main stays here. */
  const keepMainHere = async () => {
    const operationId = snapshot?.bundle.manifest.operationId;
    if (running.current || !operationId) return;
    running.current = true;
    try {
      const released = await release({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          operationId,
          reason: `The coordinator stays here: ${project.title} there could not fast-forward.`,
        },
      });
      if (released._tag === "Failure") throw squashAtomCommandFailure(released);
      // Forget only this operation's pointer; another window may have stored a newer one.
      const stored = localStorage.getItem(storageKey);
      if (stored?.includes(operationId)) localStorage.removeItem(storageKey);
      if (!released.value.released) {
        setSnapshot(null);
        setStaleCopy(null);
        setConsent(false);
        setPhase("choose");
        setError(
          "That hand off is no longer waiting on this machine. Check where the coordinator is now before trying again.",
        );
        return;
      }
      markUnpublished(null);
      setSnapshot(null);
      setStaleCopy(null);
      setConsent(false);
      setError(null);
      setPhase("choose");
    } catch (cause) {
      showError(cause, project.environmentId);
    } finally {
      running.current = false;
    }
  };

  const transfer = async () => {
    if (running.current || !snapshot || !target || !consent || !sourceReady) return;
    running.current = true;
    setError(null);
    setCanRestart(false);
    setPhase("transferring");
    let at: EnvironmentId = target.environmentId;
    try {
      const operationId = snapshot.bundle.manifest.operationId;
      // Recheck after the person reviewed the preview; access or local work may have changed.
      const checked = await receive({
        environmentId: target.environmentId,
        input: previewInput(target.id, snapshot.bundle),
      });
      if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
      if (checked.value.executionMode !== "project-folder")
        throw new Error("Update the other machine to hand off projects into saved folders.");
      if (checked.value.phase === "started" && checked.value.coordinatorThreadId) {
        await complete(checked.value, snapshot.bundle);
        return;
      }
      // The copy there may have changed since the review. An "anyway" covers only the reason
      // the person saw; any other one goes back to the review before anything is published.
      const fresh = checked.value.updateSkipped ?? null;
      const acceptStale = staleCopy?.accepted === true && sameStaleReason(staleCopy.skipped, fresh);
      if (fresh && !acceptStale) {
        setStaleCopy({
          skipped: fresh,
          accepted: false,
          published: staleCopy?.published === true,
        });
        setPhase("review");
        return;
      }
      if (!fresh && staleCopy) setStaleCopy(null);
      // Recorded before publishing so a reload never offers to drop this operation; a failed
      // write publishes nothing, so the review stays editable.
      localStorage.setItem(
        storageKey,
        JSON.stringify({ operationId, targetKey: selected, publishing: true }),
      );
      markUnpublished(null);
      at = project.environmentId;
      const published = await prepare({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          sourceThreadId: coordinatorId!,
          operationId,
          publish: true,
          ...noteVersionsInput,
          destination: snapshot.bundle.destination ?? destinationPlan!,
          expectedDigest: snapshot.bundle.digest,
          // The preview checked that the destination reads the summary.
          ...(retentionOf(snapshot.bundle) ? { contextRetention: 1 as const } : {}),
        },
      });
      if (published._tag === "Failure") {
        const failure = squashAtomCommandFailure(published);
        // This refusal happens before publication or destination execution.
        if (
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          failure.code === "source_changed"
        )
          setCanRestart(true);
        throw failure;
      }
      setSnapshot(published.value);
      at = target.environmentId;
      const started = await receive({
        environmentId: target.environmentId,
        input: {
          projectId: target.id,
          operationId,
          mode: "start",
          bundle: published.value.bundle,
          // Only fast-forward the copy there; stop with the reason unless the person chose
          // to move anyway on its older commits.
          ...(published.value.bundle.destination?.transport === "git-sync"
            ? { staleCopy: acceptStale ? ("accept" as const) : ("refuse" as const) }
            : {}),
        },
      });
      if (started._tag === "Failure") {
        const failure = squashAtomCommandFailure(started);
        // The copy changed since the check: show why on the review, not as a failure.
        if (
          failure &&
          typeof failure === "object" &&
          "updateSkipped" in failure &&
          failure.updateSkipped
        ) {
          setStaleCopy({
            skipped: failure.updateSkipped as MachineHandoffUpdateSkipped,
            accepted: false,
            published: true,
          });
          setPhase("review");
          return;
        }
        throw failure;
      }
      if (started.value.phase !== "started" || !started.value.coordinatorThreadId)
        throw new Error(
          "The files are saved, but the coordinator has not started. Try the handoff again.",
        );
      await complete(started.value, published.value.bundle);
    } catch (cause) {
      showError(cause, at);
      setPhase("review");
    } finally {
      running.current = false;
    }
  };

  const sourceChanges = useHandoffSourceChanges({
    environmentId: project.environmentId,
    workspaceRoot: project.workspaceRoot,
    enabled: open && phase === "choose",
    canCommit: canGit.has(project.environmentId),
  });
  const requestedMachine =
    candidates.find((item) => `${item.environmentId}:${item.id}` === requestedTarget)
      ?.environmentId ?? null;
  // The Git move's machine: the saved folder's, or one chosen without a saved folder yet.
  const gitMachine = target?.environmentId ?? pickerMachine;
  const optionOf = (item: (typeof machines)[number]): MachineOption => ({
    value: item.id,
    label: item.label,
    tone: item.unavailable ? "off" : "ready",
    reason:
      item.unavailable === "Connecting…"
        ? "Connecting…"
        : !item.online
          ? "Offline"
          : item.unavailable
            ? "Needs permission"
            : null,
    disabled: item.unavailable !== null,
  });
  /** Chooses a machine for the Git move: its usable saved folder, else the folder picker. */
  const chooseGitMachine = (environmentId: EnvironmentId | null) => {
    const saved =
      destinations.find((item) => item.environmentId === environmentId && !item.unavailable) ??
      destinations.find((item) => item.environmentId === environmentId);
    setSelected(saved?.key ?? "");
    setPickerMachine(saved ? null : environmentId);
  };
  // Sync names the machine's own folder, the one the copy fills in.
  // The copy chosen in the menu, never another copy on the same machine.
  const syncCopy = syncKey
    ? candidates.find((item) => `${item.environmentId}:${item.id}` === syncKey)
    : undefined;
  const syncLabel = machines.find((item) => item.id === syncCopy?.environmentId)?.label;
  // Choosing another machine in the copy form makes it an ordinary copy there.
  const syncTo =
    syncCopy && syncLabel && (copyMachine === null || copyMachine === syncCopy.environmentId)
      ? { machine: syncLabel, folder: syncCopy.workspaceRoot }
      : null;
  // What each machine already holds of this project: one detection rule and one role
  // derivation, with re-joined machines' old records left out as Settings does.
  const retired = useRetiredMachineRecords();
  const holdings = machineHoldings({
    source: project,
    machineIds: machines.map((item) => item.id),
    projects: [project, ...candidates],
    retired,
  });
  // Add offers machines without the project: no saved folder, no copy found there, and not a
  // member this window never opened. The machine the copy flow chose stays, so a finished Add
  // still names it.
  const addableIds = addableMachineIds({
    project,
    machineIds: machines.map((item) => item.id),
    projects,
    retired,
  });
  const addable = machines.filter((item) => addableIds.includes(item.id));
  const offered = addOnly
    ? machines.filter((item) => item.id === copyMachine || addable.includes(item))
    : machines;
  const machineOptions = offered.map(optionOf);
  const suggestedMachine = pickHandoffMachine(offered, preference) as EnvironmentId | null;
  // Add for a project with no Git remote: nothing can be downloaded, only the folder copied.
  const wholeFolderOnly = addOnly && addToMachineRoute(project) === "copy";
  // The machine the dialog sends to: the copy form's, or the Git move's.
  const sendMachine = method === "folder" ? gitMachine : copyMachine;
  const sendHolding = sendMachine ? holdings.byMachine.get(sendMachine) : undefined;
  // The Git move names its folder; among several copies that is the one it picked.
  const sendPicked =
    sendMachine === null
      ? null
      : method === "folder" && target?.environmentId === sendMachine
        ? target.id
        : (pickedCopies[sendMachine] ?? null);
  // Named from every saved machine, the source included; never guessed as the source.
  const machineLabelOf = (environmentId: string | null) =>
    environments.find((item) => item.environmentId === environmentId)?.label ?? null;
  const sendCopy = sendHolding ? pickedHolding(sendHolding, sendPicked) : null;
  // The destination copy belongs to a project this copy is not linked to: files only.
  const sendOther = otherProjectOf({
    source: project,
    copy: sendCopy?.kind === "copy" || sendCopy?.kind === "main" ? sendCopy.copy : null,
    projects,
    retired,
  });
  const send =
    sendMachine && sendHolding
      ? {
          otherProject: sendOther ? { main: machineLabelOf(sendOther.mainEnvironmentId) } : null,
          holding: sendHolding,
          picked: sendPicked,
          onPick: (id: string) => {
            setPickedCopies((current) => ({ ...current, [sendMachine]: id }));
            // In the Git move the picked copy is its destination folder.
            if (method === "folder") setSelected(`${sendMachine}:${id}`);
          },
          mainLabel: machineLabelOf(holdings.mainEnvironmentId),
          localFiles: sourceChanges?.state === "dirty" ? sourceChanges.fileCount : null,
        }
      : null;
  /** The folder the copy fills on a machine: its one copy, or the copy picked among several. */
  const copyFolderOn = (environmentId: EnvironmentId) => {
    const holding = holdings.byMachine.get(environmentId);
    if (!holding) return null;
    const picks = pickedHolding(holding, pickedCopies[environmentId] ?? null);
    return picks.kind === "main" || picks.kind === "copy" ? picks.copy.workspaceRoot : null;
  };

  /**
   * Opens the dialog. Every request but an unfinished Git handoff starts on the copy, with
   * Main kept where it is; "move" starts with it moving.
   */
  const openDialog = (
    mode: MachineHandoffOpenRequest["mode"],
    requestedMachineId?: EnvironmentId | undefined,
    syncTarget?: string | undefined,
    requestedMethod?: HandoffFolderMethod | undefined,
    fromMenu = false,
  ) => {
    if (!sourceReady) return;
    const syncCandidate =
      mode === "sync"
        ? candidates.find((item) => `${item.environmentId}:${item.id}` === syncTarget)
        : undefined;
    // A sync whose copy is gone has no folder to fill in; it never falls back to a guess.
    if (mode === "sync" && !syncCandidate) {
      toastManager.add({ type: "warning", title: "That machine no longer has this project." });
      return;
    }
    const machine = syncCandidate?.environmentId ?? requestedMachineId;
    // Only the menu's Add filters; the page's own button keeps every machine. Add is always
    // Add: it never turns into the move that was left unfinished, whose pointer stays.
    const adding = mode === "add" && fromMenu;
    // A move that completed is over: its result is put away and Add starts clean.
    const moved = adding && snapshot !== null && phase === "complete";
    if (adding && snapshot && !moved) {
      // A move this window already published is unfinished: the refusal opens it to finish.
      toastManager.add({
        type: "warning",
        title: tx(
          "A move to another machine is not finished. Finish or cancel it, then add a machine.",
        ),
        actionProps: { children: tx("Finish handoff"), onClick: () => changeOpen(true) },
      });
      return;
    }
    if (moved) {
      setSnapshot(null);
      setReceipt(null);
      setConsent(false);
      setPhase("choose");
      setError(null);
    }
    const kept = moved ? null : snapshot;
    // The project keeps one unfinished copy at a time: Add neither opens nor replaces it.
    const unfinished = adding
      ? readPendingCopy(folderCopyStorageKey(project.environmentId, project.id))
      : null;
    const held = unfinished && unfinished.doneSeen !== true ? unfinished : null;
    setHeldCopy(held);
    changeOpen(true, held !== null);
    setMoveAsked(false);
    setSyncKey(syncCandidate ? syncTarget! : null);
    if (syncCandidate) setCopyMachine(null);
    // An unfinished Git handoff wins over the menu's Copy: it may already be published.
    let gitPending = false;
    if (!kept) {
      try {
        // A Git handoff left unfinished before every machine kept its coordinator is not
        // resumed: publishing it would move the coordinator, which the server refuses.
        const pending = null as ReturnType<typeof parsePendingMachineHandoff>;
        // An unfinished Git handoff resumes in the method that started it, an
        // unfinished copy in the current one; otherwise every opening starts fresh.
        const copyPending =
          localStorage.getItem(folderCopyStorageKey(project.environmentId, project.id)) !== null;
        gitPending = pending !== null;
        setIntent(pending ? "move" : "copy");
        if (pending) setMethod("folder");
        else if (!copyPending) setMethod(DEFAULT_COPY_METHOD);
        const saved = readHandoffMachinePreference(preferenceKey);
        setPreference(saved);
        // Add never preselects a machine that has the project, nor one of its folders.
        const preferred = pickHandoffMachine(adding ? addable : machines, saved);
        const preferredFolder = adding
          ? undefined
          : destinations.find((item) => item.environmentId === preferred && !item.unavailable);
        // The preferred machine wins; without a saved folder there, the picker opens on it.
        const choice =
          pending?.targetKey ??
          preferredFolder?.key ??
          (preferred === null && !adding
            ? destinations.find((item) => !item.unavailable)?.key
            : undefined) ??
          "";
        setSelected(choice);
        setPickerMachine(choice ? null : (preferred as EnvironmentId | null));
        setError(null);
      } catch (cause) {
        setSelected("");
        showError(cause);
      }
    }
    setAddOnly(adding);
    if (adding) setCopyMachine(null);
    if ((mode === "copy" || mode === "sync") && !kept && !gitPending) {
      setIntent("copy");
      setMethod(requestedMethod ?? DEFAULT_COPY_METHOD);
      if (machine) {
        setSelected("");
        setPickerMachine(machine);
      }
    } else if (mode === "add" && !kept && !gitPending) {
      // With no Git remote nothing can be downloaded: the whole folder is copied.
      if (adding && addToMachineRoute(project) === "copy") setMethod("copy");
      else if (requestedMethod) setMethod(requestedMethod);
    }
  };
  const latestOpenDialog = useRef(openDialog);
  latestOpenDialog.current = openDialog;
  const latestBlockedReason = useRef(blockedReason);
  latestBlockedReason.current = blockedReason;
  const handledRequest = useRef<MachineHandoffOpenRequest | null>(null);
  const latestRequestHandled = useRef(onRequestHandled);
  latestRequestHandled.current = onRequestHandled;
  useEffect(() => {
    // Each menu pick is a new request object; the same one never opens the dialog twice.
    if (!openRequest || handledRequest.current === openRequest) return;
    handledRequest.current = openRequest;
    // The menu has no tooltip to explain a refusal, so it says why here.
    const reason = latestBlockedReason.current;
    if (reason) toastManager.add({ type: "warning", title: reason });
    else
      latestOpenDialog.current(
        openRequest.mode,
        openRequest.machine,
        openRequest.target,
        openRequest.method,
        true,
      );
    latestRequestHandled.current?.(openRequest);
  }, [openRequest]);

  return (
    <>
      {showTrigger ? (
        <Tip label={blockedReason ?? tx("Add this project to another machine")}>
          {/* Off, the button stays focusable (aria-disabled, not disabled), so it keeps its
            tooltip and screen readers read the reason it describes. */}
          <span className="inline-flex" data-slot="handoff-trigger-wrap">
            {blockedReason ? (
              <span id={blockedReasonId} className="sr-only">
                {blockedReason}
              </span>
            ) : null}
            <MachineHandoffButton
              aria-disabled={sourceReady ? undefined : true}
              aria-describedby={blockedReason ? blockedReasonId : undefined}
              onClick={() => openDialog("add")}
            />
          </span>
        </Tip>
      ) : null}
      <MachineHandoffDialog
        open={open}
        onOpenChange={(value: boolean) => changeOpen(value)}
        machinesLoading={machinesLoading}
        machinesExtra={
          open ? <HandoffAccountMachines sourceEnvironmentId={project.environmentId} /> : null
        }
        sourceLabel={source?.label ?? "This machine"}
        projectTitle={logicalProjectTitle(project)}
        sync={syncTo}
        wholeFolderOnly={wholeFolderOnly}
        workspaceContext={workspaceContext}
        destinationCheckout={receipt?.workspacePath ?? previewCheckout}
        destinationWorktreeStorage={destinationDefaultWorktreeStorage(
          target ? configs.get(target.environmentId)?.environment : null,
        )}
        destinations={destinations}
        selected={selected}
        onSelect={(key) => {
          if (discardPreview() === "failed") return;
          setSelected(key);
          setPickerMachine(null);
        }}
        machines={machineOptions}
        machine={gitMachine}
        onMachineChange={(environmentId) => {
          if (discardPreview() === "failed") return;
          chooseGitMachine(environmentId as EnvironmentId);
        }}
        intent={method === "folder" ? "move" : intent}
        sourceChanges={sourceChanges}
        leftBehind={
          open ? (
            <HandoffLeftBehind
              // Reads again once a commit changes what stays behind.
              key={`${sourceChanges?.state}:${sourceChanges?.state === "dirty" ? sourceChanges.fileCount : 0}`}
              environmentId={project.environmentId}
              projectId={project.id}
              sourceLabel={source?.label ?? "this machine"}
            />
          ) : null
        }
        method={method}
        onMethodChange={(next) => {
          if (discardPreview() === "failed") return;
          if (next === "folder") {
            // Git only always moves Main there.
            setIntent("move");
            if (method !== "folder" && copyMachine) chooseGitMachine(copyMachine);
          } else if (method === "folder") {
            // Back to a folder copy: Main stays, unless the dialog was opened to move it.
            setIntent(moveAsked ? "move" : "copy");
          }
          setMethod(next);
        }}
        copyBusy={copyBusy}
        copyLocked={copyLocked}
        copyDoneOn={
          copyDone ? (machines.find((item) => item.id === copyMachine)?.label ?? null) : null
        }
        copyDoneAt={copyDone ? copyDoneAt : null}
        copyTargetLabel={machines.find((item) => item.id === copyMachine)?.label ?? null}
        send={send}
        mainLabel={machineLabelOf(holdings.mainEnvironmentId)}
        copyFlow={
          method === "folder" ? undefined : addOnly && heldCopy ? (
            <AddHeldByCopy
              machine={machines.find((item) => item.id === heldCopy.environmentId)?.label ?? null}
              onOpen={() => openDialog("copy")}
            />
          ) : (
            <HandoffFolderCopy
              key={copyFlowRun}
              addOnly={addOnly}
              project={project}
              coordinatorId={coordinatorId}
              workspaceContext={workspaceContext}
              sourceLabel={source?.label ?? "This machine"}
              method={method}
              machines={offered.map((item) => ({
                id: item.id,
                label: item.label,
                unavailable: item.unavailable,
                worktreeStorage: destinationDefaultWorktreeStorage(
                  configs.get(item.id)?.environment,
                ),
                homeSecretFiles:
                  configs.get(item.id)?.environment.capabilities?.homeSecretFiles === true,
                memoryThreeWay:
                  configs.get(item.id)?.environment.capabilities?.memoryThreeWay === true,
              }))}
              savedFolder={(environmentId) =>
                syncCopy?.environmentId === environmentId
                  ? syncCopy.workspaceRoot
                  : copyFolderOn(environmentId)
              }
              // Several copies there: nothing starts until the person picks one.
              chooseCopyFirst={
                syncCopy === undefined &&
                copyMachine !== null &&
                holdings.byMachine.get(copyMachine)?.kind === "several" &&
                pickedCopies[copyMachine] === undefined
              }
              preferredMachine={
                requestedMachine ?? syncCopy?.environmentId ?? gitMachine ?? suggestedMachine
              }
              // Requested, so a saved draft or last copy cannot swap the machine or its folder.
              // Add starts a new copy: a finished one is not shown again.
              machineRequested={requestedMachine !== null || syncCopy !== undefined || addOnly}
              defaultMode="copy-only"
              onChoicesChange={({ mode, machine, done, review, doneAt, projectId }) => {
                copyAtReview.current = review === true;
                setIntent(mode === "copy-and-move" ? "move" : "copy");
                setCopyMachine(machine);
                setCopyDone(done);
                setCopyDoneAt(doneAt ?? null);
                setCopyDoneProject(done ? (projectId ?? null) : null);
                if (done && machine) rememberMachine(machine);
              }}
              savedProject={(environmentId, folder) =>
                projects.find(
                  (item) =>
                    copyDestinationKey(item.environmentId, item.workspaceRoot) ===
                    copyDestinationKey(environmentId, folder),
                ) ?? null
              }
              // A copy sends files; the coordinator on this machine stays (1390 AC-35).
              canMove={false}
              uncommittedFiles={sourceChanges?.state === "dirty" ? sourceChanges.fileCount : null}
              onBusyChange={setCopyBusy}
              onCloseLockChange={setCopyLocked}
              onOpenProject={({ environmentId, projectId, folder }) => {
                void navigate({
                  to: "/projects/$projectKey",
                  params: { projectKey: derivePhysicalProjectKeyFromPath(environmentId, folder) },
                  search: projectWorkspaceSearch(null, `${environmentId}:${projectId}`),
                })
                  .then(() => changeOpen(false))
                  .catch(showError);
              }}
            />
          )
        }
        folderPicker={
          phase === "choose" ? (
            <HandoffFolderPicker
              // Each opening, and each machine, starts from a fresh folder.
              key={`${open}:${gitMachine ?? ""}`}
              title={logicalProjectTitle(project)}
              existingFolders={projects}
              machines={machines}
              machine={gitMachine}
              sourceFolder={project.workspaceRoot}
              onSaved={(environmentId, projectId) => {
                // A save that lands during or after a review must not retarget that review.
                if (latestDiscard.current() === "failed") return;
                setSelected(`${environmentId}:${projectId}`);
                setPickerMachine(null);
                setError(null);
              }}
            />
          ) : undefined
        }
        preview={
          snapshot
            ? {
                gitSync: snapshot.bundle.destination?.transport === "git-sync",
                repositories: snapshot.bundle.manifest.repositories,
                messageCount: snapshot.messageCount,
                retention: retentionOf(snapshot.bundle),
              }
            : null
        }
        phase={phase}
        error={error}
        errorDetails={
          busyRefusal ? (
            <HandoffBusyThreads
              busy={busyRefusal.busy}
              environmentId={busyRefusal.environmentId}
              machineLabel={
                environments.find((item) => item.environmentId === busyRefusal.environmentId)
                  ?.label ??
                (busyRefusal.environmentId === project.environmentId
                  ? "This machine"
                  : "the other machine")
              }
              projectTitle={project.title}
            />
          ) : undefined
        }
        consent={consent}
        onConsent={setConsent}
        staleCopy={
          staleCopy
            ? {
                skipped: staleCopy.skipped,
                accepted: staleCopy.accepted,
                onAccept: (accepted: boolean) =>
                  setStaleCopy((current) => (current ? { ...current, accepted } : current)),
                ...(staleCopy.published ? { onKeepHere: () => void keepMainHere() } : {}),
              }
            : null
        }
        onReview={() => void review()}
        onContinue={() => void transfer()}
        onOpenDestination={() => {
          if (!receipt || !target) return;
          if (typeof receipt.workspacePath !== "string" || !receipt.workspacePath.trim()) {
            setError(
              "The other machine did not report where the project is. Try the handoff again.",
            );
            return;
          }
          void navigate({
            to: "/projects/$projectKey",
            params: {
              projectKey: receipt.logicalProject
                ? `logical-project:${receipt.logicalProject.id}`
                : derivePhysicalProjectKeyFromPath(target.environmentId, receipt.workspacePath),
            },
            search: projectWorkspaceSearch(
              null,
              receipt.logicalProject ? null : `${target.environmentId}:${receipt.projectId}`,
            ),
          })
            .then(() => changeOpen(false))
            .catch(showError);
        }}
        onBack={reviewed ? () => void discardPreview() : undefined}
        onRestart={
          canRestart
            ? () => {
                try {
                  localStorage.removeItem(storageKey);
                  markUnpublished(null);
                  setSnapshot(null);
                  setConsent(false);
                  setCanRestart(false);
                  setError(null);
                  setPhase("choose");
                } catch (cause) {
                  showError(cause);
                }
              }
            : undefined
        }
      />
    </>
  );
}

/** A folder copy saved for this project that nobody cancelled: it waits on the machines. */
function copyAwaitsReview(project: { readonly environmentId: string; readonly id: string }) {
  const saved = readPendingCopy(folderCopyStorageKey(project.environmentId, project.id));
  return saved !== null && !saved.cancelled;
}
