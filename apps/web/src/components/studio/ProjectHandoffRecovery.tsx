import { useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  logicalProjectTitle,
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
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

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
    const member = members.find(
      (item) => item.environmentId === scope.environmentId && item.id === scope.projectId,
    );
    const binding = member?.workspaceSettings?.coordinatorBinding;
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
    // Where the move was going: the binding's successor, else the pointer's "machine:project".
    const destinationId =
      binding?.successor?.environmentId ??
      (pending?.targetKey.includes(":") ? pending.targetKey.split(":")[0] : undefined);
    const project = member?.title ? logicalProjectTitle(member) : null;
    return [{ scope, operationId, key, destinationId, project }];
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
      [entry.key]: { text: "Checking the handoff…", busy: true },
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
          `This handoff isn't ready to finish yet. Open Hand off on ${
            environments.find((item) => item.environmentId === entry.scope.environmentId)?.label ??
            "the source"
          } to continue it.`,
        );
      const destination = bundle.destination;
      if (!ready(destination.environmentId) || !canConfigure.has(destination.environmentId))
        throw new Error(
          "Reconnect the destination machine with permission to run work and copy code, then try again.",
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
        throw new Error("The coordinator has not started on the destination yet. Try again.");
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
        [entry.key]: { text: "Handoff finished on both machines.", complete: true },
      }));
    } catch (cause) {
      setStatuses((current) => ({
        ...current,
        [entry.key]: {
          text:
            cause instanceof Error
              ? cause.message
              : "The handoff could not finish. Try again when both machines are connected.",
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
        const machineName = (environmentId: string | undefined) =>
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
          environmentId;
        const label = machineName(entry.scope.environmentId)!;
        const destination = machineName(entry.destinationId);
        const sourceReady = ready(entry.scope.environmentId);
        const project = entry.project ?? "this project";
        return (
          <section
            key={entry.key}
            className="project-notice"
            aria-label={`Finish handing off ${project}`}
            data-handoff-recovery={entry.operationId}
          >
            <p className="font-medium">
              {destination
                ? `Finish handing off ${project} to ${destination}`
                : `Finish handing off ${project}`}
            </p>
            <p className="project-muted">
              The handoff stopped partway. {label} won’t restart on its own.
            </p>
            {status ? <p role="status">{status.text}</p> : null}
            {!sourceReady ? (
              <p>Reconnect {label} with permission to run work and copy code.</p>
            ) : null}
            {!status?.complete ? (
              <Button
                size="sm"
                disabled={!sourceReady || status?.busy}
                onClick={() => void retry(entry)}
              >
                Finish handoff
              </Button>
            ) : null}
            <div className="project-muted text-xs">
              <Collapsible>
                <CollapsibleTrigger>Details</CollapsibleTrigger>
                <CollapsiblePanel>
                  <p>Operation {entry.operationId}</p>
                </CollapsiblePanel>
              </Collapsible>
            </div>
          </section>
        );
      })}
    </>
  );
}
