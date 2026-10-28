import { useRef } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MachineHandoffBundle,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export const messageOf = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The copy could not continue.";

/** A destination refusal happened before this attempt could publish a source fence. */
export class DestinationContextPreviewError extends Error {
  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
  }
}

/** The destination registration a copied folder already has, if any. */
type KnownProject = (
  environmentId: EnvironmentId,
  targetFolder: string,
) => EnvironmentProject | null;

/**
 * Moves the coordinator after "Move and continue there" copied the files: previews the
 * destination, fences the source, then starts the coordinator in the copied folder.
 */
export function useCoordinatorTransfer({
  project,
  coordinatorId,
  knownProject,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly knownProject: KnownProject;
}) {
  const prepare = useAtomCommand(machineHandoff.prepare, { reportFailure: false });
  const receive = useAtomCommand(machineHandoff.receive, { reportFailure: false });
  /** Set once the source published this operation's bundle; a later failure keeps recovery. */
  const contextPublished = useRef(false);

  const destinationPlan = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    targetFolder: string,
  ) => {
    const known = knownProject(environmentId, targetFolder);
    if (known && known.id !== projectId)
      throw new DestinationContextPreviewError(
        new Error(
          "The destination registration changed. Check this copied folder before moving the coordinator.",
        ),
      );
    return {
      environmentId,
      projectId,
      executionMode: "project-folder" as const,
      transport: "folder-copy" as const,
      coordinatorThreadId:
        known?.workspaceSettings?.coordinatorThreadId ??
        ThreadId.make(`project-coordinator:${projectId}`),
      ...(known?.workspaceSettings?.logicalProject
        ? { logicalProjectId: known.workspaceSettings.logicalProject.id }
        : {}),
      joinExistingProject: true,
    };
  };

  /** Fences the source coordinator for a move; repeated calls return the same published bundle. */
  const fence = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    targetFolder: string,
  ) => {
    if (!coordinatorId) throw new Error("Open this project’s coordinator before moving it.");
    const base = {
      projectId: project.id,
      sourceThreadId: coordinatorId,
      operationId: operationId,
      destination: destinationPlan(environmentId, projectId, targetFolder),
    };
    const prepared = unwrap(
      await prepare({ environmentId: project.environmentId, input: { ...base, publish: false } }),
    );
    if (prepared.publication === "published") {
      contextPublished.current = true;
      return prepared.bundle;
    }
    // Check the actual registration, logical identity, coordinator and idle state
    // before fencing the source. Conversation contents stay on the source here.
    const bundle = prepared.bundle;
    try {
      const checked = unwrap(
        await receive({
          environmentId,
          input: {
            projectId,
            operationId: bundle.manifest.operationId,
            mode: "preview",
            manifest: bundle.manifest,
            sourceEnvironmentId: bundle.sourceEnvironmentId,
            sourceProjectId: bundle.sourceProjectId,
            sourceThreadId: bundle.sourceThreadId,
            digest: bundle.digest,
            ...(bundle.logicalProject ? { logicalProject: bundle.logicalProject } : {}),
            ...(bundle.coordinatorBinding ? { coordinatorBinding: bundle.coordinatorBinding } : {}),
            ...(bundle.destination ? { destination: bundle.destination } : {}),
          },
        }),
      );
      if (checked.executionMode !== "project-folder" || checked.projectId !== projectId)
        throw new Error(
          "Update or check the other machine before moving the coordinator into this copied folder.",
        );
    } catch (cause) {
      throw new DestinationContextPreviewError(cause);
    }
    const published = unwrap(
      await prepare({
        environmentId: project.environmentId,
        input: {
          ...base,
          destination: bundle.destination ?? base.destination,
          publish: true,
          expectedDigest: bundle.digest,
        },
      }),
    ).bundle;
    contextPublished.current = true;
    return published;
  };

  /** Fences the source, starts the coordinator on the destination and acknowledges it. */
  const continueThere = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    targetFolder: string,
  ) => {
    const bundle: MachineHandoffBundle = await fence(
      operationId,
      environmentId,
      projectId,
      targetFolder,
    );
    const started = unwrap(
      await receive({
        environmentId,
        input: { projectId, operationId: bundle.manifest.operationId, mode: "start", bundle },
      }),
    );
    if (started.phase !== "started" || !started.coordinatorThreadId)
      throw new Error("The files are in place, but the coordinator has not started. Retry.");
    if (bundle.logicalProject) {
      unwrap(
        await prepare({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            sourceThreadId: coordinatorId!,
            operationId: bundle.manifest.operationId,
            publish: true,
            expectedDigest: bundle.digest,
            destination:
              bundle.destination ?? destinationPlan(environmentId, projectId, targetFolder),
            acknowledgment: {
              operationId: bundle.manifest.operationId,
              environmentId,
              projectId: started.projectId,
              coordinatorThreadId: started.coordinatorThreadId,
              digest: bundle.digest,
            },
          },
        }),
      );
    }
  };

  return { contextPublished, continueThere };
}
