import {
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type Project,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { delegationRefusal, outgoingDelegation } from "../../../fleet/workGrantPolicy.ts";
import type { Caller } from "../../threadAccess.ts";

export interface LaunchTargetInput {
  readonly machine?: string | undefined;
  readonly machineProjectId?: ProjectId | undefined;
  readonly reportBack?: boolean | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly scratch?: boolean | undefined;
  readonly title: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  readonly message?: string | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Where a launch runs: the machine the agent named, else the machine the user
 * chose for this project's workers when its coordinator calls, else here.
 */
export const launchTarget = Effect.fn("mcp.launchTarget")(function* (
  context: Caller,
  input: LaunchTargetInput,
  project: Project | undefined,
) {
  const remote = yield* RemoteWorkers.RemoteWorkers;
  if (input.machine !== undefined) return yield* remote.resolveMachine(input.machine);
  const isCoordinator =
    context.caller !== undefined &&
    project !== undefined &&
    project.workspaceSettings?.coordinatorThreadId === context.caller.id;
  const configured = isCoordinator ? project.workspaceSettings?.workerMachine : undefined;
  if (!configured) return { kind: "local" } as const;
  if (input.scratch === true)
    return yield* invalid(
      'This project\'s workers run on another machine, and scratch threads run here. Pass machine:"local" with scratch to start one here.',
    );
  const resolved = yield* remote.resolveMachine(configured.machineId).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: error.code,
          message: `${error.message} This project's worker machine is not available; pass machine:"local" to run here.`,
        }),
    ),
  );
  // The setting pins the machine it was saved for; a fleet entry re-pointed elsewhere is not it.
  if (resolved.kind === "remote" && resolved.machine.environmentId !== configured.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "machine_identity_mismatch",
      message: `${resolved.machine.label} is now a different machine than the one chosen for this project's workers. The user can choose it again in project settings, or pass machine:"local" to run here.`,
    });
  return resolved;
});

/** Starts the thread on another machine and keeps following it for the caller. */
export const launchRemote = Effect.fn("mcp.launchRemote")(function* (input: {
  readonly context: Caller;
  readonly machine: RemoteWorkers.MachineTarget & { readonly kind: "remote" };
  readonly params: LaunchTargetInput;
  readonly project: Project | undefined;
  readonly commandId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const { context, params, project } = input;
  const caller = context.caller;
  if (caller === undefined || context.scope.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Starting work on another machine needs an agent running inside a SpecWithCode thread on this one.",
    });
  if (params.scratch === true)
    return yield* invalid("Scratch threads run on this machine; omit machine or scratch.");
  if ((params.attachments ?? []).length > 0)
    return yield* invalid(
      "Attachments cannot be sent to another machine; describe the files in message or launch here.",
    );
  if (project === undefined) return yield* invalid("The project was not found.");
  const isCoordinator = project.workspaceSettings?.coordinatorThreadId === caller.id;
  const remote = yield* RemoteWorkers.RemoteWorkers;
  // Work that reached this machine from another carries its path on, so no
  // chain of launches can come back to a machine it passed through.
  const grants = yield* WorkGrants.WorkGrants;
  const origin = yield* grants.originOf(caller).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "This machine could not read where this thread's work came from. Try again.",
        }),
    ),
  );
  const outgoing = outgoingDelegation({
    localEnvironmentId: context.scope.environmentId,
    targetEnvironmentId: input.machine.machine.environmentId,
    origin,
  });
  if (!outgoing.ok)
    return yield* new OrchestratorMcpFailure({
      code: outgoing.code,
      message: delegationRefusal(
        outgoing,
        new Map([...(yield* remote.machineLabels), [context.scope.environmentId, "this machine"]]),
      ),
    });
  return yield* remote.launch({
    machine: input.machine.machine,
    commandId: input.commandId,
    callerThreadId: caller.id,
    localProject: project,
    machineProjectId: params.machineProjectId,
    title: params.title,
    explicitModelSelection: params.modelSelection,
    inheritedModelSelection:
      (isCoordinator
        ? project.defaultModelSelection
        : (caller.modelSelection ?? project.defaultModelSelection)) ?? undefined,
    runtimeMode: input.runtimeMode,
    requestedRuntimeMode: params.runtimeMode,
    interactionMode: input.interactionMode,
    workspaceStrategy: params.workspaceStrategy,
    message: params.message,
    reportBack: params.reportBack ?? true,
    delegation: outgoing.delegation,
  });
});
