import { useEffect, useMemo, useRef, useState } from "react";
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
import { isProjectFolder } from "../../studio/projectMachineFolders";

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
  const changeOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<MachineHandoffPrepareResult | null>(null);
  const [receipt, setReceipt] = useState<MachineHandoffReceiveResult | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<
    "choose" | "checking" | "review" | "transferring" | "complete"
  >("choose");
  const [error, setError] = useState<string | null>(null);
  const [canRestart, setCanRestart] = useState(false);
  // A synchronous gate catches double-clicks before React paints the disabled button.
  const running = useRef(false);
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
          !item.workspaceSettings?.archived &&
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
  const source = environments.find((item) => item.environmentId === project.environmentId);
  const sourceReady =
    source?.connection.phase === "connected" &&
    coordinatorId !== null &&
    canOperate.has(project.environmentId) &&
    canGit.has(project.environmentId) &&
    canWrite.has(project.environmentId);
  useEffect(() => {
    if (!requestedTarget) return;
    setSelected(requestedTarget);
    setSnapshot(null);
    setReceipt(null);
    setConsent(false);
    setPhase("choose");
    setError(null);
    changeOpen(true);
  }, [requestedTarget]);
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
      const operationId = pending?.targetKey === selected ? pending.operationId : randomUUID();
      // Persist before either RPC: an ambiguous response retries the same operation.
      localStorage.setItem(storageKey, JSON.stringify({ operationId, targetKey: selected }));
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
                setSelected(
                  pending?.targetKey ?? destinations.find((item) => !item.unavailable)?.key ?? "",
                );
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
        onSelect={setSelected}
        folderPicker={
          phase === "choose" ? (
            <HandoffFolderPicker
              title={logicalProjectTitle(project)}
              existingFolders={projects}
              machines={environments
                .filter((e) => e.environmentId !== project.environmentId)
                .map((e) => ({
                  id: e.environmentId,
                  label: e.label,
                  unavailable:
                    e.connection.phase !== "connected"
                      ? "Connect first"
                      : !canOperate.has(e.environmentId) ||
                          !canGit.has(e.environmentId) ||
                          !canWrite.has(e.environmentId) ||
                          !canConfigure.has(e.environmentId)
                        ? "Permission required"
                        : null,
                }))}
              onSaved={(environmentId, projectId) => {
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
        onRestart={
          canRestart
            ? () => {
                try {
                  localStorage.removeItem(storageKey);
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
