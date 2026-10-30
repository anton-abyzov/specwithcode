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
  repositoryGroupingKeyOf,
  type MachineHandoffPrepareResult,
  type MachineHandoffReceiveResult,
  type MachineHandoffBundle,
  type MachineHandoffBusyThreads,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
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
import type { MachineOption } from "../handoff/MachineOptionRows";
import { Tip } from "./shell/Tip";
import { HandoffFolderPicker } from "./HandoffFolderPicker";
import { HandoffFolderCopy, folderCopyStorageKey } from "./HandoffFolderCopy";
import {
  copyActivityKey,
  registerCopyOpener,
  unwatchCopy,
  watchCopy,
} from "../../studio/folderCopyActivity";
import { copyDestinationKey, type HandoffFolderMethod } from "../../studio/folderCopy";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { isArchivedMember } from "../../studio/projectListVisibility";
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
import { HandoffBusyThreads } from "./HandoffBusyThreads";
import { refusedBusyOf } from "./handoffCopySteps";

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

export function ProjectMachineHandoff({
  project,
  coordinatorId,
  onOpenChange,
  requestedTarget = null,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly onOpenChange?: (open: boolean) => void;
  readonly requestedTarget?: string | null;
}) {
  const { environments, isReady: catalogReady } = useEnvironments();
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
  // A safe copy of the folder is the default; Git-only handoff stays available.
  const [method, setMethod] = useState<HandoffFolderMethod>("copy");
  // Opening the dialog means moving the project; "Copy files only" is the other choice.
  const [intent, setIntent] = useState<MoveIntent>("move");
  // The copy flow's machine, so switching to Git keeps it.
  const [copyMachine, setCopyMachine] = useState<EnvironmentId | null>(null);
  const [copyDone, setCopyDone] = useState(false);
  const [copyBusy, setCopyBusyState] = useState(false);
  const [copyLocked, setCopyLocked] = useState(false);
  // Read when the dialog closes: a measure or copy still running is watched until it is ready.
  const copyRunning = useRef(false);
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
  const repositoryKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  // Sidebar grouping is presentation only. Shell projects omit deleted registrations;
  // transfers still require a known matching repository on another environment.
  const candidates = useMemo(
    () =>
      projects.filter(
        (item) =>
          item.environmentId !== project.environmentId &&
          !isArchivedMember(item) &&
          isProjectFolder(item.workspaceRoot, item.id) &&
          item.repositoryIdentity != null &&
          repositoryGroupingKeyOf(item.repositoryIdentity) === repositoryKey,
      ),
    [projects, project.environmentId, repositoryKey],
  );
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
  const destinationPlan = target
    ? {
        environmentId: target.environmentId,
        projectId: target.id,
        executionMode: "project-folder" as const,
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
      cause instanceof Error ? cause.message : "The handoff could not finish. Try it again.",
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
  const changeOpen = (value: boolean) => {
    // Closing cancels an unpublished review, so the next opening starts from the choices.
    if (!value && phase !== "complete" && discardPreview() === "none") setError(null);
    // The folder copy keeps running on the machines; say when it is ready.
    // The app-wide watcher follows it, whichever project is open next.
    const activityKey = copyActivityKey(project.environmentId, project.id);
    if (!value && open && copyRunning.current)
      watchCopy({
        environmentId: project.environmentId,
        projectId: project.id,
        machineLabel: (environmentId) =>
          environments.find((item) => item.environmentId === environmentId)?.label ??
          "the other machine",
        sourceLabel: source?.label ?? "this machine",
        projectName: logicalProjectTitle(project),
      });
    // An open dialog follows the copy itself.
    if (value) unwatchCopy(activityKey);
    setOpen(value);
    holdPage?.(value);
    onOpenChange?.(value);
  };
  // A background copy's toast opens this dialog while this project is on screen.
  const latestChangeOpen = useRef(changeOpen);
  latestChangeOpen.current = changeOpen;
  useEffect(
    () =>
      registerCopyOpener(copyActivityKey(project.environmentId, project.id), () =>
        latestChangeOpen.current(true),
      ),
    [project.environmentId, project.id],
  );
  useEffect(() => {
    if (!requestedTarget) return;
    // "Move coordinator to X": move, with X chosen whichever way the files travel.
    setIntent("move");
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
    if (running.current || !target || !sourceReady) return;
    running.current = true;
    setError(null);
    setCanRestart(false);
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
              destination: destinationPlan!,
            },
          });
        }
      }
      if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
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
      setSnapshot(prepared.value);
      setPreviewCheckout(checked.value.workspacePath);
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
          destination: snapshot.bundle.destination ?? destinationPlan!,
          expectedDigest: snapshot.bundle.digest,
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
        },
      });
      if (started._tag === "Failure") throw squashAtomCommandFailure(started);
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
  const suggestedMachine = pickHandoffMachine(machines, preference) as EnvironmentId | null;
  const requestedMachine =
    candidates.find((item) => `${item.environmentId}:${item.id}` === requestedTarget)
      ?.environmentId ?? null;
  // The Git move's machine: the saved folder's, or one chosen without a saved folder yet.
  const gitMachine = target?.environmentId ?? pickerMachine;
  const machineOptions = machines.map((item): MachineOption => ({
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
  }));
  /** Chooses a machine for the Git move: its usable saved folder, else the folder picker. */
  const chooseGitMachine = (environmentId: EnvironmentId | null) => {
    const saved =
      destinations.find((item) => item.environmentId === environmentId && !item.unavailable) ??
      destinations.find((item) => item.environmentId === environmentId);
    setSelected(saved?.key ?? "");
    setPickerMachine(saved ? null : environmentId);
  };

  return (
    <>
      <Tip label={blockedReason ?? "Hand off this project to another machine"}>
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
            onClick={() => {
              if (!sourceReady) return;
              changeOpen(true);
              if (!snapshot) {
                setIntent("move");
                try {
                  const pending = parsePendingMachineHandoff(localStorage.getItem(storageKey));
                  // An unfinished Git handoff resumes in the method that started it, an
                  // unfinished copy in the current one; otherwise every opening starts fresh.
                  if (pending) setMethod("folder");
                  else if (
                    localStorage.getItem(
                      folderCopyStorageKey(project.environmentId, project.id),
                    ) === null
                  )
                    setMethod("copy");
                  const saved = readHandoffMachinePreference(preferenceKey);
                  setPreference(saved);
                  const preferred = pickHandoffMachine(machines, saved);
                  const preferredFolder = destinations.find(
                    (item) => item.environmentId === preferred && !item.unavailable,
                  );
                  // The preferred machine wins; without a saved folder there, the picker opens on it.
                  const choice =
                    pending?.targetKey ??
                    preferredFolder?.key ??
                    (preferred === null
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
            }}
          />
        </span>
      </Tip>
      <MachineHandoffDialog
        open={open}
        onOpenChange={changeOpen}
        machinesLoading={machinesLoading}
        sourceLabel={source?.label ?? "This machine"}
        projectTitle={logicalProjectTitle(project)}
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
        onIntentChange={(next) => {
          // Git always continues the project there; copying files only uses the copy flow.
          if (next !== "copy" || discardPreview() === "failed") return;
          setIntent("copy");
          setMethod("copy");
        }}
        sourceChanges={sourceChanges}
        method={method}
        onMethodChange={(next) => {
          if (discardPreview() === "failed") return;
          if (next === "folder") {
            setIntent("move");
            if (method !== "folder" && copyMachine) chooseGitMachine(copyMachine);
          }
          setMethod(next);
        }}
        copyBusy={copyBusy}
        copyLocked={copyLocked}
        copyDoneOn={
          copyDone ? (machines.find((item) => item.id === copyMachine)?.label ?? null) : null
        }
        copyFlow={
          method === "folder" ? undefined : (
            <HandoffFolderCopy
              project={project}
              coordinatorId={coordinatorId}
              workspaceContext={workspaceContext}
              sourceLabel={source?.label ?? "This machine"}
              method={method}
              machines={machines.map((item) => ({
                id: item.id,
                label: item.label,
                unavailable: item.unavailable,
                worktreeStorage: destinationDefaultWorktreeStorage(
                  configs.get(item.id)?.environment,
                ),
              }))}
              savedFolder={(environmentId) =>
                candidates.find((item) => item.environmentId === environmentId)?.workspaceRoot ??
                null
              }
              preferredMachine={requestedMachine ?? gitMachine ?? suggestedMachine}
              machineRequested={requestedMachine !== null}
              defaultMode={intent === "move" ? "copy-and-move" : "copy-only"}
              onChoicesChange={({ mode, machine, done }) => {
                setIntent(mode === "copy-and-move" ? "move" : "copy");
                setCopyMachine(machine);
                setCopyDone(done);
                if (done && machine) rememberMachine(machine);
              }}
              savedProject={(environmentId, folder) =>
                projects.find(
                  (item) =>
                    copyDestinationKey(item.environmentId, item.workspaceRoot) ===
                    copyDestinationKey(environmentId, folder),
                ) ?? null
              }
              canMove={sourceReady}
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
                repositories: snapshot.bundle.manifest.repositories,
                messageCount: snapshot.messageCount,
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
