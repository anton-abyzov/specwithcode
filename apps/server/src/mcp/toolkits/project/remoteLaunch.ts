import {
  isLocalWorkerMachine,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type Project,
  type ProjectId,
  projectWorkerMachineOrder,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { teamRulesOutgoingCarried } from "@specweave-studio/shared/teamRules";
import { delegationRefusal, outgoingDelegation } from "../../../fleet/workGrantPolicy.ts";
import { currentTeamRules } from "../../../teamRules/TeamRules.ts";
import type { Caller } from "../../threadAccess.ts";
import { fleetPrincipalOf } from "../orchestrator/remote.ts";
import { addToMachineHint } from "./addToMachine.ts";

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
  readonly userAskedForWorktree?: boolean | undefined;
  readonly message?: string | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly increment?: string | undefined;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Why a launch runs where it does, reported to the agent as `placement`. */
export type PlacementReason = "explicit" | "project_worker_machine" | "this_machine";

export interface SkippedMachine {
  readonly machine: string;
  readonly reason: string;
}

export interface LaunchCandidate {
  readonly target: RemoteWorkers.MachineTarget;
  readonly reason: PlacementReason;
}

/**
 * Where a launch may run, best first. `strict`: the project's list leaves this
 * machine out, so a launch none of the candidates takes fails instead of
 * running here.
 */
export interface LaunchPlacement {
  readonly candidates: ReadonlyArray<LaunchCandidate>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
  readonly strict: boolean;
}

/**
 * Failures that prove the other machine started nothing, so the next
 * candidate may take the thread. A launch whose outcome is unknown is never
 * retried elsewhere.
 */
const PLACEMENT_SKIPPABLE = new Set<OrchestratorMcpFailure["code"]>([
  "unknown_machine",
  "machine_unreachable",
  "machine_identity_mismatch",
  "machine_not_authorized",
  "machine_unsupported",
  "project_unavailable_on_machine",
  "project_ambiguous_on_machine",
  "model_unavailable_on_machine",
  "outside_grant_scope",
  "account_not_allowed",
  "delegation_cycle",
  "delegation_limit",
]);

export const placementSkippable = (error: unknown): error is OrchestratorMcpFailure =>
  Schema.is(OrchestratorMcpFailure)(error) && PLACEMENT_SKIPPABLE.has(error.code);

/**
 * Where a launch runs: the machine the agent named (refused, never
 * substituted, when it cannot take the thread); else, for the project's
 * coordinator, the project's worker machines in the user's order, where
 * "local" is this machine; else this machine, the coordinator's own. A listed
 * machine that cannot be resolved is skipped with its reason here, and one
 * that refuses the launch is skipped by the caller, so one machine being out
 * does not stop the project.
 */
export const launchTarget = Effect.fn("mcp.launchTarget")(function* (
  context: Caller,
  input: LaunchTargetInput,
  project: Project | undefined,
) {
  const remote = yield* RemoteWorkers.RemoteWorkers;
  if (input.machine !== undefined)
    return {
      candidates: [{ target: yield* remote.resolveMachine(input.machine), reason: "explicit" }],
      skipped: [],
      strict: true,
    } satisfies LaunchPlacement;
  const here: LaunchPlacement = {
    candidates: [{ target: { kind: "local" }, reason: "this_machine" }],
    skipped: [],
    strict: false,
  };
  const isCoordinator =
    context.caller !== undefined &&
    project !== undefined &&
    project.workspaceSettings?.coordinatorThreadId === context.caller.id;
  if (!isCoordinator) return here;
  const order = projectWorkerMachineOrder(project.workspaceSettings, context.scope.environmentId);
  if (order.length === 1 && isLocalWorkerMachine(order[0]!)) return here;
  if (input.scratch === true) {
    if (isLocalWorkerMachine(order[0]!)) return here;
    return yield* invalid(
      'This project\'s workers run on another machine, and scratch threads run here. Pass machine:"local" with scratch to start one here.',
    );
  }
  const candidates: LaunchCandidate[] = [];
  const skipped: SkippedMachine[] = [];
  for (const configured of order) {
    if (isLocalWorkerMachine(configured)) {
      candidates.push({ target: { kind: "local" }, reason: "this_machine" });
      continue;
    }
    const resolved = yield* remote.resolveMachine(configured.machineId).pipe(Effect.result);
    if (resolved._tag === "Failure") {
      skipped.push({ machine: configured.machineId, reason: resolved.failure.message });
      continue;
    }
    // The setting pins the machine it was saved for; a fleet entry re-pointed elsewhere is not it.
    if (
      resolved.success.kind === "remote" &&
      resolved.success.machine.environmentId !== configured.environmentId
    ) {
      skipped.push({
        machine: resolved.success.machine.label,
        reason: `${resolved.success.machine.label} is now a different machine than the one chosen for this project's workers; the user can choose it again in project settings.`,
      });
      continue;
    }
    candidates.push({
      target: resolved.success,
      reason: resolved.success.kind === "remote" ? "project_worker_machine" : "this_machine",
    });
  }
  return {
    candidates,
    skipped,
    strict: !order.some(isLocalWorkerMachine),
  } satisfies LaunchPlacement;
});

/** The refusal when no machine in the project's list could take a launch. */
export const noWorkerMachineFailure = (skipped: ReadonlyArray<SkippedMachine>) =>
  new OrchestratorMcpFailure({
    code: "machine_unreachable",
    message: `None of this project's worker machines could take the thread${
      skipped.length > 0
        ? `: ${skipped.map((entry) => `${entry.machine}: ${entry.reason}`).join("; ")}`
        : "."
    } The project's list leaves this machine out, so nothing started here. Tell the user in one line, and offer to run it here with machine:"local".`,
  });

/**
 * Starts the thread on another machine. A thread caller's worker is followed
 * and reports back to it; an outside MCP client's is not (it reads and waits
 * on the thread instead), and runs within the lower of the client's approved
 * access and the machine's grant. With no project, or `scratch`, the thread
 * runs in a scratch folder there.
 */
export const launchRemote = Effect.fn("mcp.launchRemote")(function* (input: {
  readonly context: Caller;
  readonly machine: RemoteWorkers.MachineTarget & { readonly kind: "remote" };
  readonly params: LaunchTargetInput;
  readonly project: Project | undefined;
  readonly commandId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const { context, params } = input;
  const principal = yield* fleetPrincipalOf(context, "act");
  // A project named here that is not here is an error, never a scratch launch there.
  if (params.projectId !== undefined && input.project === undefined)
    return yield* invalid("The project was not found.");
  // No project here: the one named there, else a scratch folder there.
  const scratch = params.scratch === true || input.project === undefined;
  if (
    params.scratch === true &&
    (params.projectId !== undefined ||
      params.machineProjectId !== undefined ||
      params.workspaceStrategy !== undefined)
  )
    return yield* invalid(
      "scratch:true runs in a scratch folder on that machine; omit projectId, machineProjectId and workspaceStrategy.",
    );
  if ((params.attachments ?? []).length > 0)
    return yield* invalid(
      "Attachments cannot be sent to another machine; describe the files in message or launch here.",
    );
  const project = scratch ? undefined : input.project;
  const caller = principal.kind === "thread" ? principal.caller : undefined;
  const isCoordinator =
    caller !== undefined && project?.workspaceSettings?.coordinatorThreadId === caller.id;
  const remote = yield* RemoteWorkers.RemoteWorkers;
  // Work that reached this machine from another carries its path on, so no
  // chain of launches can come back to a machine it passed through. A
  // client's launch starts a path here.
  const grants = yield* WorkGrants.WorkGrants;
  const origin =
    caller === undefined
      ? undefined
      : yield* grants.originOf(caller).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message:
                  "This machine could not read where this thread's work came from. Try again.",
              }),
          ),
        );
  const outgoing = outgoingDelegation({
    localEnvironmentId: context.scope.environmentId,
    targetEnvironmentId: input.machine.machine.environmentId,
    origin,
    carried: teamRulesOutgoingCarried(
      yield* currentTeamRules,
      caller?.origin?.carried,
      context.scope.environmentId,
    ),
  });
  if (!outgoing.ok)
    return yield* new OrchestratorMcpFailure({
      code: outgoing.code,
      message: delegationRefusal(
        outgoing,
        new Map([...(yield* remote.machineLabels), [context.scope.environmentId, "this machine"]]),
      ),
    });
  const launched = remote.launch({
    machine: input.machine.machine,
    commandId: input.commandId,
    ...(caller === undefined ? {} : { callerThreadId: caller.id }),
    launchedBy: principal.launchedBy,
    localProject: project,
    machineProjectId: params.scratch === true ? undefined : params.machineProjectId,
    title: params.title,
    explicitModelSelection: params.modelSelection,
    inheritedModelSelection:
      (isCoordinator
        ? project?.defaultModelSelection
        : (caller?.modelSelection ?? project?.defaultModelSelection)) ?? undefined,
    runtimeMode: input.runtimeMode,
    requestedRuntimeMode: params.runtimeMode,
    interactionMode: input.interactionMode,
    workspaceStrategy: params.workspaceStrategy,
    userAskedForWorktree: params.userAskedForWorktree === true,
    message: params.message,
    // Resolved by the machine that runs the thread, against its own checkout.
    increment: params.increment,
    // Only a thread here can be woken when its worker finishes.
    reportBack: principal.kind === "thread" && (params.reportBack ?? true),
    delegation: outgoing.delegation,
    // Display text for the badge there: the client's name, or the thread here.
    originHint:
      principal.kind === "client"
        ? { clientLabel: principal.client.label }
        : { parentThreadId: principal.caller.id },
  });
  // A project that is not there yet can be put there over MCP.
  return yield* project === undefined
    ? launched
    : launched.pipe(
        Effect.mapError((error) =>
          error.code === "project_unavailable_on_machine"
            ? new OrchestratorMcpFailure({
                code: error.code,
                message: `${error.message} ${addToMachineHint(input.machine.machine, project.id)}`,
              })
            : error,
        ),
      );
});
