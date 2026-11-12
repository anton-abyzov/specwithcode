import {
  isLocalWorkerMachine,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type OrchestratorMcpLaunchNeed,
  type Project,
  type ProjectId,
  projectWorkerMachineOrder,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { chooseForNeeds, type NeedsCandidate } from "../../../fleet/launchNeeds.ts";
import { thisMachinePlatform } from "../../../fleet/thisMachinePlatform.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { teamRulesOutgoingCarried } from "@specweave-studio/shared/teamRules";
import {
  delegationRefusal,
  mayReturnToOrigin,
  outgoingDelegation,
} from "../../../fleet/workGrantPolicy.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { currentTeamRules, teamRulesForFolder } from "../../../teamRules/TeamRules.ts";
import type { Caller } from "../../threadAccess.ts";
import { fleetPrincipalOf } from "../orchestrator/remote.ts";
import { addToMachineHint, type ExistingCopyOutcome, linkExistingCopy } from "./addToMachine.ts";
import { workGrantOf } from "../../workGrantAccess.ts";

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
  /** What the work needs from its machine, such as an iOS Simulator. */
  readonly needs?: ReadonlyArray<OrchestratorMcpLaunchNeed> | undefined;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Why a launch runs where it does, reported to the agent as `placement`. */
export type PlacementReason = "explicit" | "project_worker_machine" | "this_machine" | "needs";

export interface SkippedMachine {
  readonly machine: string;
  readonly reason: string;
}

export interface LaunchCandidate {
  readonly target: RemoteWorkers.MachineTarget;
  readonly reason: PlacementReason;
  /** Why this machine when the work states needs, for the launch result. */
  readonly note?: string | undefined;
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
  const placement = yield* usualLaunchTarget(context, input, project);
  const needs = input.needs ?? [];
  return needs.length === 0 ? placement : yield* placeByNeeds(needs, placement, project);
});

const usualLaunchTarget = Effect.fn("mcp.usualLaunchTarget")(function* (
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

/**
 * Keeps the usual order but only machines that can do the work: a named
 * machine known not to qualify is refused. Without one, the usual candidates
 * (the project's worker machines, or this machine) keep the work when one of
 * them reports the need; only when none does, the other connected machines
 * this one may start work on are used, and the note says so. Machines that
 * report the need come before ones that have not said. Nothing falls back to a
 * machine known not to qualify, so the result is strict. The machine chosen
 * still authorizes the launch itself.
 */
const placeByNeeds = Effect.fn("mcp.placeByNeeds")(function* (
  needs: ReadonlyArray<OrchestratorMcpLaunchNeed>,
  usual: LaunchPlacement,
  project: Project | undefined,
) {
  const remote = yield* RemoteWorkers.RemoteWorkers;
  const local = yield* thisMachinePlatform;
  const listed = yield* remote.listMachines({ projectId: project?.id, probe: true });
  const candidate = (launch: LaunchCandidate): NeedsCandidate<LaunchCandidate> => {
    if (launch.target.kind === "local")
      return { key: "local", label: "this machine", platform: local, value: launch };
    const id = launch.target.machine.id;
    return {
      key: id,
      label: launch.target.machine.label,
      platform: listed.machines.find((row) => row.id === id)?.platform,
      value: launch,
    };
  };
  const connected = listed.machines
    .filter(
      (row) =>
        (row.status === "ready" || row.status === "grant_expiring") &&
        row.reachable !== false &&
        row.teamRulesRefused === undefined,
    )
    .map((row) =>
      candidate({
        target: {
          kind: "remote",
          machine: { id: row.id, label: row.label, environmentId: row.environmentId },
        },
        reason: "needs",
      }),
    );
  const here = candidate({ target: { kind: "local" }, reason: "needs" });
  const explicit = usual.candidates.find((launch) => launch.reason === "explicit");
  const choice = chooseForNeeds({
    needs,
    explicit: explicit === undefined ? undefined : candidate(explicit),
    preferred: explicit === undefined ? usual.candidates.map(candidate) : [here],
    fallback: [...connected, here],
  });
  if (!choice.ok) return yield* invalid(choice.message);
  return {
    candidates: choice.chosen.map((chosen) => ({ ...chosen.candidate.value, note: chosen.note })),
    skipped: [...usual.skipped, ...choice.skipped],
    strict: true,
  } satisfies LaunchPlacement;
});

/** The refusal when no machine in the project's list could take a launch. */
export const noWorkerMachineFailure = (skipped: ReadonlyArray<SkippedMachine>, byNeeds = false) => {
  const reasons =
    skipped.length > 0
      ? `: ${skipped.map((entry) => `${entry.machine}: ${entry.reason}`).join("; ")}`
      : ".";
  return new OrchestratorMcpFailure({
    code: "machine_unreachable",
    message: byNeeds
      ? `No machine that can do this work could take the thread${reasons} Nothing was started. Tell the user in one line; studio_machine_list shows which machines are connected.`
      : `None of this project's worker machines could take the thread${reasons} The project's list leaves this machine out, so nothing started here. Tell the user in one line, and offer to run it here with machine:"local".`,
  });
};

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
  const storage = () =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "This machine could not read who may run work on it. Try again.",
    });
  const outgoing = outgoingDelegation({
    localEnvironmentId: context.scope.environmentId,
    targetEnvironmentId: input.machine.machine.environmentId,
    origin,
    returnToOrigin:
      origin !== undefined &&
      mayReturnToOrigin({
        grant: yield* grants
          .forCoordinator(origin.coordinatorEnvironmentId)
          .pipe(Effect.mapError(storage)),
        origin,
        targetEnvironmentId: input.machine.machine.environmentId,
      }),
    carried: teamRulesOutgoingCarried(
      yield* teamRulesForFolder(caller?.worktreePath ?? project?.workspaceRoot),
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
  const launch = (localProject: Project | undefined = project) =>
    remote.launch({
      machine: input.machine.machine,
      commandId: input.commandId,
      ...(caller === undefined ? {} : { callerThreadId: caller.id }),
      launchedBy: principal.launchedBy,
      localProject,
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
      // Never forwarded: an older worker would let it override its own Use worktrees switch.
      userAskedForWorktree: false,
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
  if (project === undefined) return yield* launch();
  const machine = input.machine.machine;
  const hinted = (error: OrchestratorMcpFailure, extra: string) =>
    new OrchestratorMcpFailure({ code: error.code, message: `${error.message} ${extra}` });
  return yield* launch().pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (error.code !== "project_unavailable_on_machine") return yield* error;
        // The repository may already be a project of its own there, added on that
        // machine separately, so every machine lists it twice. Link that copy into
        // this project and launch in it. Work another machine started here cannot
        // change projects elsewhere, and a person's explicit choice there is kept.
        // Only when this project has nothing there at all: a listed member that could
        // not be read or no longer matches (the person unlinked it there, or that
        // machine is briefly out), or a saved project for that machine, is not a
        // missing copy, and linking another one would undo their choice.
        const logical = project.workspaceSettings?.logicalProject;
        const listedThere =
          logical?.members.some((member) => member.environmentId === machine.environmentId) ===
            true || RemoteWorkers.savedWorkerMachine(project, machine)?.projectId != null;
        if (listedThere)
          return yield* hinted(
            error,
            `This project already names a copy on ${machine.label}, and it cannot be used now: that machine may be briefly out, or the copy was moved or unlinked there. Do not add another copy. Check studio_machine_list, try again later, or ask the user to relink it (its sidebar menu > Link…).`,
          );
        // A machineProjectId naming an unlinked copy of this repository is linked too,
        // and only that one: launching in it is refused until it is.
        const named = params.scratch === true ? undefined : params.machineProjectId;
        const linkable = logical != null && (yield* workGrantOf(context)) === undefined;
        const existing = linkable
          ? yield* linkExistingCopy({ project, machine, copyId: named }).pipe(
              Effect.catch(() => Effect.succeed({ kind: "none" } as ExistingCopyOutcome)),
            )
          : ({ kind: "none" } as ExistingCopyOutcome);
        const projects = yield* ProjectService.ProjectService;
        const reread = projects.getById(project.id).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        if (existing.kind === "linked")
          // The link added that machine's copy to this project's members.
          return yield* launch((yield* reread) ?? project);
        if (existing.kind === "unlinked") {
          // Another launch may have linked the same copy a moment ago.
          const fresh = yield* reread;
          if (
            fresh?.workspaceSettings?.logicalProject?.members.some(
              (member) =>
                member.environmentId === machine.environmentId &&
                member.projectId === existing.copy.id,
            )
          )
            return yield* launch(fresh);
        }
        if (existing.kind === "ambiguous")
          return yield* hinted(
            error,
            `${machine.label} has several projects of this repository: ${existing.candidates
              .map((copy) => `${copy.title} (${copy.id}, ${copy.workspaceRoot})`)
              .join(
                ", ",
              )}. Ask the user which one to link (its sidebar menu > Link…), then launch again.`,
          );
        // studio_project_add_to_machine would return this same copy, so it is not offered.
        if (existing.kind === "unlinked")
          return yield* hinted(
            error,
            `${machine.label} has this repository as a separate project, ${existing.copy.title} (${existing.copy.id}), not linked to this one. ${existing.problem} Do not call studio_project_add_to_machine for it: that finds this same copy.`,
          );
        if (named !== undefined)
          return yield* hinted(
            error,
            `${named} on ${machine.label} is not a copy of this project's repository that can be linked. studio_machine_list shows this project's copy there, if it has one. ${addToMachineHint(machine, project.id)}`,
          );
        // A project that is not there yet can be put there over MCP.
        return yield* hinted(error, addToMachineHint(machine, project.id));
      }),
    ),
  );
});
