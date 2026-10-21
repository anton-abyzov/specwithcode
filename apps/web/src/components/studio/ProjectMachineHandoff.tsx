import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
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
import { MachineHandoffButton, MachineHandoffDialog } from "./MachineHandoffDialog";
import { Tip } from "./shell/Tip";
import { HandoffFolderPicker } from "./HandoffFolderPicker";
import { HandoffFolderCopy, folderCopyStorageKey } from "./HandoffFolderCopy";
import type { HandoffFolderMethod } from "../../studio/folderCopy";
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
import { useHandoffSourceChanges } from "./useHandoffSourceChanges";

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
  const { environments } = useEnvironments();
  const projects = useProjects();
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
  const [selected, setSelected] = useState("");
  const [pickerMachine, setPickerMachine] = useState<EnvironmentId | null>(null);
  const preferenceKey = handoffMachinePreferenceKey(project.environmentId, project.id);
  const [preference, setPreference] = useState(() => readHandoffMachinePreference(preferenceKey));
  const fleet = useStudioFleet(project.environmentId);
  const [snapshot, setSnapshotState] = useState<MachineHandoffPrepareResult | null>(null);
  // Handlers read the latest snapshot even before React commits it (a late folder save).
  const latestSnapshot = useRef<MachineHandoffPrepareResult | null>(null);
  const setSnapshot = (value: MachineHandoffPrepareResult | null) => {
    latestSnapshot.current = value;
    setSnapshotState(value);
  };
  const [receipt, setReceipt] = useState<MachineHandoffReceiveResult | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<
    "choose" | "checking" | "review" | "transferring" | "complete"
  >("choose");
  const [error, setError] = useState<string | null>(null);
  const [canRestart, setCanRestart] = useState(false);
  // A safe copy of the folder is the default; Git-only handoff stays available.
  const [method, setMethod] = useState<HandoffFolderMethod>("copy");
  const [copyBusy, setCopyBusy] = useState(false);
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
  const machines = environments
    .filter((item) => item.environmentId !== project.environmentId)
    .map((item): HandoffMachine & { id: EnvironmentId } => {
      const online = item.connection.phase === "connected";
      const status = fleet.snapshot?.machines.find(
        (machine) => machine.environmentId === item.environmentId,
      )?.workers?.status;
      return {
        id: item.environmentId,
        label: item.label,
        online,
        unavailable: !online
          ? "Connect first"
          : !canOperate.has(item.environmentId) ||
              !canGit.has(item.environmentId) ||
              !canWrite.has(item.environmentId) ||
              !canConfigure.has(item.environmentId)
            ? "Permission required"
            : null,
        workersAllowed: status === "allowed" || status === "expiring",
        hasProjectFolder: candidates.some((entry) => entry.environmentId === item.environmentId),
        lastOnlineAt: seen[item.environmentId] ?? null,
      };
    });
  const source = environments.find((item) => item.environmentId === project.environmentId);
  const sourceReady =
    source?.connection.phase === "connected" &&
    coordinatorId !== null &&
    canOperate.has(project.environmentId) &&
    canGit.has(project.environmentId) &&
    canWrite.has(project.environmentId);
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
  const showError = (cause: unknown) =>
    setError(
      cause instanceof Error ? cause.message : "The handoff could not finish. Retry this handoff.",
    );
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
    setOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (!requestedTarget) return;
    setSelected(requestedTarget);
    setPickerMachine(null);
    setSnapshot(null);
    setReceipt(null);
    setConsent(false);
    setPhase("choose");
    setError(null);
    changeOpen(true);
  }, [requestedTarget]);
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
    setPreference(writeHandoffMachinePreference(preferenceKey, { lastUsed: target.environmentId }));
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
    try {
      const pending = parsePendingMachineHandoff(localStorage.getItem(storageKey));
      if (pending?.publishing && pending.targetKey !== selected)
        throw new Error(
          "An earlier handoff stopped while publishing. Select its folder again to finish it.",
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
            ? "This earlier handoff uses a temporary checkout. Restart an unpublished preview to use the saved folder; recover a published handoff from its retained transfer."
            : "Update the source machine to support handoff into saved project folders.",
        );
      }
      if (
        prepared.value.bundle.destination.environmentId !== target.environmentId ||
        prepared.value.bundle.destination.projectId !== target.id
      )
        throw new Error(
          "The retained handoff targets a different folder. Recover that transfer first.",
        );
      const checked = await receive({
        environmentId: target.environmentId,
        input: previewInput(target.id, prepared.value.bundle),
      });
      if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
      if (checked.value.executionMode !== "project-folder")
        throw new Error(
          "Update the destination machine to support handoff into saved project folders.",
        );
      setSnapshot(prepared.value);
      if (checked.value.phase === "started" && checked.value.coordinatorThreadId) {
        await complete(checked.value, prepared.value.bundle);
      } else setPhase("review");
    } catch (cause) {
      showError(cause);
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
    try {
      const operationId = snapshot.bundle.manifest.operationId;
      // Recheck after the person reviewed the preview; access or local work may have changed.
      const checked = await receive({
        environmentId: target.environmentId,
        input: previewInput(target.id, snapshot.bundle),
      });
      if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
      if (checked.value.executionMode !== "project-folder")
        throw new Error(
          "Update the destination machine to support handoff into saved project folders.",
        );
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
          "The checkpoint is retained, but the coordinator has not started. Retry this handoff.",
        );
      await complete(started.value, published.value.bundle);
    } catch (cause) {
      showError(cause);
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
  const rememberedId = target?.environmentId ?? pickerMachine;
  const suggestedMachine = pickHandoffMachine(machines, preference) as EnvironmentId | null;
  const rememberedCandidate = machines.find((machine) => machine.id === rememberedId) ?? null;

  return (
    <>
      <Tip
        label={
          sourceReady
            ? "Continue this project on another machine"
            : "Connect this machine and open its coordinator to hand off work"
        }
      >
        <MachineHandoffButton
          disabled={!sourceReady}
          onClick={() => {
            changeOpen(true);
            if (!snapshot) {
              try {
                const pending = parsePendingMachineHandoff(localStorage.getItem(storageKey));
                // An unfinished Git handoff resumes in the method that started it, an
                // unfinished copy in the current one; otherwise every opening starts fresh.
                if (pending) setMethod("folder");
                else if (
                  localStorage.getItem(folderCopyStorageKey(project.environmentId, project.id)) ===
                  null
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
      </Tip>
      <MachineHandoffDialog
        open={open}
        onOpenChange={changeOpen}
        sourceLabel={source?.label ?? "This machine"}
        projectTitle={logicalProjectTitle(project)}
        destinations={destinations}
        selected={selected}
        onSelect={(key) => {
          if (discardPreview() === "failed") return;
          setSelected(key);
          setPickerMachine(null);
        }}
        sourceChanges={sourceChanges}
        method={method}
        onMethodChange={(next) => {
          if (discardPreview() === "failed") return;
          setMethod(next);
        }}
        copyBusy={copyBusy}
        copyFlow={
          method === "folder" ? undefined : (
            <HandoffFolderCopy
              project={project}
              coordinatorId={coordinatorId}
              sourceLabel={source?.label ?? "This machine"}
              method={method}
              machines={machines.map((item) => ({
                id: item.id,
                label: item.label,
                unavailable: item.unavailable,
              }))}
              savedFolder={(environmentId) =>
                candidates.find((item) => item.environmentId === environmentId)?.workspaceRoot ??
                null
              }
              preferredMachine={suggestedMachine}
              canMove={sourceReady}
              onBusyChange={setCopyBusy}
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
        rememberMachine={
          rememberedCandidate
            ? {
                label: rememberedCandidate.label,
                checked: preference.remembered === rememberedCandidate.id,
                onChange: (checked) =>
                  setPreference(
                    writeHandoffMachinePreference(preferenceKey, {
                      remembered: checked ? rememberedCandidate.id : null,
                    }),
                  ),
              }
            : null
        }
        folderPicker={
          phase === "choose" ? (
            <HandoffFolderPicker
              // Each opening, and each machine, starts from a fresh folder.
              key={`${open}:${pickerMachine ?? ""}`}
              title={logicalProjectTitle(project)}
              existingFolders={projects}
              machines={machines}
              machine={pickerMachine}
              suggestedMachine={suggestedMachine}
              onMachineChange={(machine) => {
                setPickerMachine(machine);
                if (machine) setSelected("");
              }}
              defaultOpen={
                pickerMachine !== null || !destinations.some((item) => !item.unavailable)
              }
              sourceFolder={project.workspaceRoot}
              onSaved={(environmentId, projectId) => {
                // A save that lands during or after a review must not retarget that review.
                if (latestDiscard.current() === "failed") return;
                setSelected(`${environmentId}:${projectId}`);
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
        consent={consent}
        onConsent={setConsent}
        onReview={() => void review()}
        onContinue={() => void transfer()}
        onOpenDestination={() => {
          if (!receipt || !target) return;
          if (typeof receipt.workspacePath !== "string" || !receipt.workspacePath.trim()) {
            setError(
              "The destination workspace is missing from the handoff receipt. Retry this handoff.",
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
