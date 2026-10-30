import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  logicalProjectMemberKey,
  MachineHandoffError,
  ProjectId,
  ThreadId,
  type EnvironmentId,
  type LogicalProject,
  type MachineHandoffContext,
  type MachineHandoffManifest,
  type MachineHandoffPrepareInput,
  type MachineHandoffPrepareResult,
  type Project,
  type ProjectCoordinatorBinding,
} from "@specweave-studio/contracts";
import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import { checkBundle, machineHandoffDigest } from "./handoffBundle.ts";

/**
 * The first prepare's unpublished source record: the logical project with its
 * source, destination and successor members, the active binding, and the retained context.
 */
export const newSourceRecord = (input: {
  readonly current: Project;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly operationId: string;
  readonly selected: ThreadId;
  readonly destination: NonNullable<MachineHandoffPrepareInput["destination"]>;
  readonly binding: ProjectCoordinatorBinding | undefined;
  readonly manifest: MachineHandoffManifest;
  readonly retained: MachineHandoffContext;
}): Effect.Effect<MachineHandoffPrepareResult, MachineHandoffError> =>
  Effect.gen(function* () {
    const { current, sourceEnvironmentId, selected, destination, binding, manifest, retained } =
      input;
    const source = {
      environmentId: sourceEnvironmentId,
      projectId: input.projectId,
      coordinatorThreadId: selected,
    };
    const successor = {
      environmentId: destination.environmentId,
      projectId:
        destination.executionMode === "project-folder"
          ? destination.projectId
          : ProjectId.make(`machine-handoff:${input.operationId}`),
      coordinatorThreadId:
        destination.executionMode === "project-folder"
          ? (destination.coordinatorThreadId ??
            ThreadId.make(`project-coordinator:${destination.projectId}`))
          : ThreadId.make(`project-coordinator:machine-handoff:${input.operationId}`),
    };
    const id =
      current.workspaceSettings?.logicalProject?.id ??
      `logical:${sha256([stringifyJson([sourceEnvironmentId, input.projectId])], "hex")}`;
    const members = new Map(
      (current.workspaceSettings?.logicalProject?.members ?? []).map((m) => [
        logicalProjectMemberKey(m),
        m,
      ]),
    );
    members.set(logicalProjectMemberKey(source), source);
    const destinationMember = {
      environmentId: destination.environmentId,
      projectId: destination.projectId,
      coordinatorThreadId:
        destination.coordinatorThreadId ??
        ThreadId.make(`project-coordinator:${destination.projectId}`),
    };
    members.set(logicalProjectMemberKey(destinationMember), destinationMember);
    members.set(logicalProjectMemberKey(successor), successor);
    const logicalProject: LogicalProject = {
      id,
      title: current.workspaceSettings?.logicalProject?.title ?? current.title,
      coordinatorId:
        current.workspaceSettings?.logicalProject?.coordinatorId ?? `coordinator:${id}`,
      members: [...members.values()],
    };
    const value = {
      manifest,
      sourceEnvironmentId,
      sourceProjectId: input.projectId,
      sourceThreadId: selected,
      destination,
      logicalProject,
      coordinatorBinding: {
        ...binding,
        epoch: binding?.epoch ?? 0,
        state: "active" as const,
        operationId: input.operationId,
        successor,
      },
      createdAt: DateTime.formatIso(yield* DateTime.now),
      context: retained,
    };
    const bundle = { ...value, digest: machineHandoffDigest(value) };
    yield* Effect.try({
      try: () => checkBundle(bundle),
      catch: () => new MachineHandoffError({ code: "too_large" }),
    });
    return {
      bundle,
      publication: "unpublished",
      contextBytes: Buffer.byteLength(stringifyJson(retained)),
      messageCount: retained.threads.reduce((sum, t) => sum + t.messages.length, 0),
    };
  });
