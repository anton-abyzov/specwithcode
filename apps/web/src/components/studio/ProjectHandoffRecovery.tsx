import { useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
} from "@specweave-studio/contracts";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import {
  machineHandoffStorageKey,
  parsePendingMachineHandoff,
} from "../../studio/machineHandoffPending";
import type { ProjectExecutionScope } from "../../studio/projectDomain";

/** Source recovery belongs to the logical project, even after its active surface moves. */
export function ProjectHandoffRecovery({
  scopes,
  members,
}: {
  scopes: readonly ProjectExecutionScope[];
  members: readonly EnvironmentProject[];
}) {
  const { environments } = useEnvironments();
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const canGit = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  const canWrite = useEnvironmentsWithScope(environments, AuthFilesystemWriteScope);
  const canConfigure = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const prepare = useAtomCommand(machineHandoff.prepare, { reportFailure: false });
  const receive = useAtomCommand(machineHandoff.receive, { reportFailure: false });
  const running = useRef(new Set<string>());
  const [statuses, setStatuses] = useState<
    Record<string, { text: string; complete?: boolean; busy?: boolean }>
  >({});
  const entries = scopes.flatMap((scope) => {
    const binding = members.find(
      (member) => member.environmentId === scope.environmentId && member.id === scope.projectId,
    )?.workspaceSettings?.coordinatorBinding;
    if (binding?.state === "transferred" || !scope.coordinatorThreadId) return [];
    let pending = null;
    try {
      pending = parsePendingMachineHandoff(
        localStorage.getItem(machineHandoffStorageKey(scope.environmentId, scope.projectId)),
      );
    } catch {
      /* Server ownership remains an independent recovery source. */
    }
    const operationId =
      binding?.state === "transferring" ? binding.operationId : pending?.operationId;
    if (!operationId) return [];
    const key = `${scope.environmentId}:${scope.projectId}:${operationId}`;
    return [{ scope, operationId, key }];
  });
  const ready = (environmentId: (typeof scopes)[number]["environmentId"]) =>
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && environment.connection.phase === "connected",
    ) &&
    canOperate.has(environmentId) &&
    canGit.has(environmentId) &&
    canWrite.has(environmentId);
  const retry = async (entry: (typeof entries)[number]) => {
    if (running.current.has(entry.key)) return;
    running.current.add(entry.key);
    setStatuses((current) => ({
      ...current,
      [entry.key]: { text: "Checking the saved handoff…", busy: true },
    }));
    try {
      // No destination or new operation is invented. The source returns its immutable saved plan.
      const saved = await prepare({
        environmentId: entry.scope.environmentId,
        input: {
          projectId: entry.scope.projectId,
          sourceThreadId: entry.scope.coordinatorThreadId!,
          operationId: entry.operationId,
          publish: false,
        },
      });
      if (saved._tag === "Failure") throw squashAtomCommandFailure(saved);
      const bundle = saved.value.bundle;
      if (
        saved.value.publication !== "published" ||
        !bundle.destination ||
        !bundle.logicalProject ||
        bundle.coordinatorBinding?.state !== "transferring"
      )
        throw new Error(
          "This handoff has not published its checkpoint. Open the source coordinator's Handoff dialog to review and continue it.",
        );
      const destination = bundle.destination;
      if (!ready(destination.environmentId) || !canConfigure.has(destination.environmentId))
        throw new Error(
          "Reconnect the destination with permission to run work and transfer code, then retry this saved handoff.",
        );
      const checked = await receive({
        environmentId: destination.environmentId,
        input: {
          projectId: destination.projectId,
          operationId: entry.operationId,
          mode: "preview",
          manifest: bundle.manifest,
          sourceEnvironmentId: bundle.sourceEnvironmentId,
          sourceProjectId: bundle.sourceProjectId,
          sourceThreadId: bundle.sourceThreadId,
          digest: bundle.digest,
          logicalProject: bundle.logicalProject,
          coordinatorBinding: bundle.coordinatorBinding,
          destination,
        },
      });
      if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
      const received =
        checked.value.phase === "started"
          ? checked
          : await receive({
              environmentId: destination.environmentId,
              input: {
                projectId: destination.projectId,
                operationId: entry.operationId,
                mode: "start",
                bundle,
              },
            });
      if (received._tag === "Failure") throw squashAtomCommandFailure(received);
      const receipt = received.value;
      if (receipt.phase !== "started" || !receipt.coordinatorThreadId)
        throw new Error("The destination has not started. This saved handoff can be retried.");
      const acknowledged = await prepare({
        environmentId: entry.scope.environmentId,
        input: {
          projectId: entry.scope.projectId,
          sourceThreadId: bundle.sourceThreadId,
          operationId: entry.operationId,
          publish: true,
          expectedDigest: bundle.digest,
          destination,
          acknowledgment: {
            operationId: entry.operationId,
            environmentId: destination.environmentId,
            projectId: receipt.projectId,
            coordinatorThreadId: receipt.coordinatorThreadId,
            digest: bundle.digest,
          },
        },
      });
      if (acknowledged._tag === "Failure") throw squashAtomCommandFailure(acknowledged);
      try {
        localStorage.removeItem(
          machineHandoffStorageKey(entry.scope.environmentId, entry.scope.projectId),
        );
      } catch {
        /* A replay returns the same receipt. */
      }
      setStatuses((current) => ({
        ...current,
        [entry.key]: { text: "Handoff confirmed on the source and destination.", complete: true },
      }));
    } catch (cause) {
      setStatuses((current) => ({
        ...current,
        [entry.key]: {
          text:
            cause instanceof Error
              ? cause.message
              : "The saved handoff could not be confirmed. Retry when both machines are connected.",
        },
      }));
    } finally {
      running.current.delete(entry.key);
    }
  };
  return (
    <>
      {entries.map((entry) => {
        const status = statuses[entry.key];
        const label =
          environments.find(
            (environment) => environment.environmentId === entry.scope.environmentId,
          )?.label ?? entry.scope.environmentId;
        return (
          <section
            key={entry.key}
            className="project-notice"
            aria-label={`Handoff recovery from ${label}`}
            data-handoff-recovery={entry.operationId}
          >
            <p>
              Unfinished handoff from {label}. The saved transfer needs confirmation; the source
              will not resume automatically.
            </p>
            <p className="project-muted">Operation {entry.operationId}</p>
            {status ? <p role="status">{status.text}</p> : null}
            {!ready(entry.scope.environmentId) ? (
              <p>
                Reconnect {label} with permission to run work and transfer code to recover this
                handoff.
              </p>
            ) : null}
            {!status?.complete ? (
              <button
                type="button"
                className="project-control"
                disabled={!ready(entry.scope.environmentId) || status?.busy}
                onClick={() => void retry(entry)}
              >
                Retry saved handoff
              </button>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
