import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import {
  isProjectCoordinatorThreadId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegation,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import {
  accountInGrant,
  checkIncomingDelegation,
  delegationRefusal,
  type EffectiveWorkGrant,
  projectInGrant,
  type WorkOrigin,
} from "../fleet/workGrantPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * Work another machine started here runs under the grant this machine gave
 * that machine: only in the projects it covers, only on the sign-ins it
 * allows, and never back along the path it came by. The checks apply to the
 * other machine's own calls and to everything the threads it started do here.
 */
export interface WorkGrantContext {
  readonly grant: EffectiveWorkGrant;
  /** Where the work came from; undefined when the caller is the grant itself without a launch. */
  readonly origin: WorkOrigin | undefined;
  /** The coordinator machine's name, for messages. */
  readonly coordinatorLabel: string;
}

/**
 * Who is calling, as far as a grant cares: the credential's scope, and the
 * calling thread when there is one (its own record, or its root's, names the
 * machine whose work started it).
 */
export interface GrantCaller {
  readonly scope: Pick<Caller["scope"], "client">;
  readonly caller: Parameters<WorkGrants.WorkGrantsShape["originOf"]>[0] | undefined;
}

const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "This machine could not read who may run work on it. Try again.",
  });

const labelsOf = RemoteWorkers.RemoteWorkers.pipe(Effect.flatMap((remote) => remote.machineLabels));

/**
 * The grant the caller acts under here, if any: a worker-grant client's own,
 * or for a thread that another machine's work started (or its subagents and
 * forks), the grant of the machine that started it.
 */
export const workGrantOf = Effect.fn("mcp.workGrantOf")(function* (context: GrantCaller) {
  const grants = yield* WorkGrants.WorkGrants;
  if (!grants.enabled) return undefined;
  const labels = yield* labelsOf;
  if (context.caller === undefined) {
    const grant = yield* grants
      .forClient(context.scope.client)
      .pipe(Effect.mapError(storageFailure));
    if (grant === undefined) return undefined;
    return {
      grant,
      origin: undefined,
      coordinatorLabel:
        labels.get(grant.coordinatorEnvironmentId) ?? grant.coordinatorEnvironmentId,
    } satisfies WorkGrantContext;
  }
  const origin = yield* grants.originOf(context.caller).pipe(Effect.mapError(storageFailure));
  if (origin === undefined) return undefined;
  const grant = yield* grants
    .forCoordinator(origin.coordinatorEnvironmentId)
    .pipe(Effect.mapError(storageFailure));
  return {
    grant,
    origin,
    coordinatorLabel: labels.get(grant.coordinatorEnvironmentId) ?? grant.coordinatorEnvironmentId,
  } satisfies WorkGrantContext;
});

export const refuseRevoked = (work: WorkGrantContext) =>
  work.grant.revoked
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "machine_not_authorized",
          message: `This machine revoked work from ${work.coordinatorLabel}.`,
        }),
      )
    : Effect.void;

/**
 * The project as this machine knows it, read without adding a requirement so
 * every tool can call it. Undefined when the server cannot say, which the
 * checks below treat as outside the grant.
 */
const findProject = Effect.fn("mcp.workGrant.findProject")(function* (projectId: ProjectId) {
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  if (Option.isNone(projects)) return undefined;
  return yield* projects.value.getById(projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
});

const unreachable = (work: WorkGrantContext, what: "project" | "thread") =>
  new OrchestratorMcpFailure({
    code: "outside_grant_scope",
    message: `This machine does not let ${work.coordinatorLabel} reach that ${what}.`,
  });

/**
 * Admits a launch here and says what origin the new thread records: the
 * sender's path for another machine's launch, the caller's own origin for a
 * thread its work started. A launch by anyone else records nothing.
 */
export const admitLaunch = Effect.fn("mcp.admitLaunch")(function* (
  context: Caller,
  delegation: OrchestratorMcpDelegation | undefined,
) {
  const work = yield* workGrantOf(context);
  if (work === undefined) return undefined;
  yield* refuseRevoked(work);
  if (work.origin !== undefined) return work;
  const checked = checkIncomingDelegation({
    ownEnvironmentId: context.scope.environmentId,
    coordinatorEnvironmentId: work.grant.coordinatorEnvironmentId,
    delegation,
    hopLimit: work.grant.hopLimit,
  });
  if (!checked.ok)
    return yield* new OrchestratorMcpFailure({
      code: checked.code,
      message: delegationRefusal(
        checked,
        new Map([...(yield* labelsOf), [context.scope.environmentId, "this machine"]]),
        context.scope.environmentId,
      ),
    });
  return { ...work, origin: checked.origin } satisfies WorkGrantContext;
});

/** Refuses a project the grant does not cover, saying how the user can widen it. */
export const assertProjectInGrant = (work: WorkGrantContext | undefined, project: Project) =>
  work === undefined ||
  projectInGrant(work.grant.projects, work.grant.coordinatorEnvironmentId, project)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "outside_grant_scope",
          message: isPersonalAssistantProject(project)
            ? `${PERSONAL_ASSISTANT_PRIVATE_MESSAGE} ${work.coordinatorLabel} cannot reach this machine's assistant.`
            : work.grant.projects.kind === "linked"
              ? `Project "${project.title}" on this machine is not linked to ${work.coordinatorLabel}, and this machine lets ${work.coordinatorLabel} run work only in linked projects. Link the projects, or widen what ${work.coordinatorLabel} may use here in Settings > Connections > Who can run work on this Mac.`
              : `This machine does not let ${work.coordinatorLabel} run work in project "${project.title}". The user can add it in Settings > Connections > Who can run work on this Mac.`,
        }),
      );

/** Refuses a provider instance the grant does not allow, naming the ones it does. */
export const assertAccountInGrant = (
  work: WorkGrantContext | undefined,
  instanceId: ProviderInstanceId,
) => {
  if (work === undefined || accountInGrant(work.grant.accounts, instanceId)) return Effect.void;
  const allowed = work.grant.accounts.kind === "listed" ? work.grant.accounts.instanceIds : [];
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: "account_not_allowed",
      message:
        allowed.length === 0
          ? `This machine lets ${work.coordinatorLabel} use none of its sign-ins, so it cannot start work here. The user can allow sign-ins in Settings > Connections > Who can run work on this Mac.`
          : `This machine lets ${work.coordinatorLabel} use only these sign-ins: ${allowed.join(", ")}. Pass modelSelection with one of them (orchestrator_capabilities lists their models), or the user can allow ${instanceId} in Settings > Connections > Who can run work on this Mac.`,
    }),
  );
};

/** Refuses a thread whose project the grant does not cover. */
export const assertThreadInGrant = Effect.fn("mcp.assertThreadInGrant")(function* (
  work: WorkGrantContext | undefined,
  thread: Pick<OrchestrationV2ThreadShell, "projectId">,
) {
  if (work === undefined) return;
  yield* refuseRevoked(work);
  const project = yield* findProject(thread.projectId);
  if (project === undefined) return yield* unreachable(work, "thread");
  yield* assertProjectInGrant(work, project);
});

/**
 * Another machine's work steers only the threads it started here (and their
 * subagents and forks). Steering this machine's own work would run it, and
 * whatever it then does, outside the grant: it records no origin, so routines,
 * sign-in limits and revocation would never reach it. Another machine's work
 * may still read every thread the grant covers. In a linked project whose copy
 * here runs no coordinator of its own (it relinquished it at link time), the
 * project's coordinator keeps steering its threads. A legacy grant is held
 * only to the linked-project rule it had before grants were scoped.
 */
export const assertThreadWritable = Effect.fn("mcp.assertThreadWritable")(function* (
  work: WorkGrantContext | undefined,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage">,
) {
  if (work === undefined) return;
  yield* refuseRevoked(work);
  const project = yield* findProject(thread.projectId);
  // A thread whose project this machine cannot read is not one the grant may change.
  if (project === undefined) return yield* unreachable(work, "thread");
  const settings = project.workspaceSettings;
  const linked = (settings?.logicalProject?.members.length ?? 0) >= 2;
  // A legacy grant (the owner's own machines, from before grants) keeps
  // steering this machine's threads outside linked projects, as it always did.
  if (work.grant.legacy === true && !linked) return;
  if (
    linked &&
    settings?.coordinatorBinding !== undefined &&
    settings.coordinatorBinding.state !== "active"
  )
    return;
  const owner = isProjectCoordinatorThreadId(thread.id, project)
    ? undefined
    : yield* WorkGrants.WorkGrants.pipe(
        Effect.flatMap((grants) => grants.originOf(thread)),
        Effect.mapError(storageFailure),
      );
  if (owner?.coordinatorEnvironmentId === work.grant.coordinatorEnvironmentId) return;
  return yield* new OrchestratorMcpFailure({
    code: "outside_grant_scope",
    message: linked
      ? `This thread belongs to this machine's own coordinator for "${project.title}", so ${work.coordinatorLabel} may read it but not send to, interrupt or change it. Ask this machine's coordinator, or migrate the thread first.`
      : `This thread is this machine's own work in "${project.title}", so ${work.coordinatorLabel} may read it but not send to, interrupt or change it. ${work.coordinatorLabel}'s work steers only the threads it started here.`,
  });
});

/**
 * Sending to a thread runs it on its own sign-in, which must be one the grant
 * allows, as when that work started it.
 */
export const assertThreadSignInInGrant = (
  work: WorkGrantContext | undefined,
  thread: Pick<OrchestrationV2ThreadShell, "providerInstanceId">,
) => assertAccountInGrant(work, thread.providerInstanceId);

/**
 * Refuses a personal assistant's project to a caller acting under another
 * machine's work grant, whatever the tool: a grant never reaches the
 * assistant's threads, queue, requests, memory or plan.
 */
export const refuseMachinePrivate = Effect.fn("mcp.refuseMachinePrivate")(function* (
  context: GrantCaller,
  projectId: ProjectId,
) {
  const work = yield* workGrantOf(context);
  if (work === undefined) return;
  // A server that cannot say what the project is refuses it.
  const project = yield* findProject(projectId);
  if (project === undefined || isPersonalAssistantProject(project))
    return yield* new OrchestratorMcpFailure({
      code: "outside_grant_scope",
      message: `${PERSONAL_ASSISTANT_PRIVATE_MESSAGE} ${work.coordinatorLabel} cannot reach this machine's assistant.`,
    });
});

/**
 * Refuses a personal assistant's thread (or its subagents) sending to another
 * machine: what it writes there would carry its private context off this one.
 */
export const refusePrivateCallerRemote = Effect.fn("mcp.refusePrivateCallerRemote")(function* (
  context: Caller,
) {
  if (context.caller === undefined) return;
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  const project = Option.isNone(projects)
    ? undefined
    : yield* projects.value.getById(context.caller.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
  if (project === undefined || isPersonalAssistantProject(project))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `${PERSONAL_ASSISTANT_PRIVATE_MESSAGE} Send to threads on this machine, or route the work with studio_project_route to a project here.`,
    });
});

/** Records where a new thread's work came from, so its own launches carry it on. */
export const recordLaunchOrigin = (work: WorkGrantContext | undefined, threadId: string) =>
  work?.origin === undefined
    ? Effect.void
    : WorkGrants.WorkGrants.pipe(
        Effect.flatMap((grants) =>
          grants
            .recordOrigin(threadId as never, work.origin!)
            .pipe(Effect.mapError(storageFailure)),
        ),
      );

/**
 * The checks every tool applies to a caller acting under another machine's
 * work grant. Each one does nothing for a caller without a grant (this
 * machine's own user, an ordinary paired client), and refuses whatever it
 * cannot resolve once a grant applies: a revoked grant, a project or thread
 * this machine cannot read, or one the grant does not cover.
 */

/** Reading a project: the grant must cover it. Returns the grant, if any. */
export const assertProjectReadable = Effect.fn("mcp.assertProjectReadable")(function* (
  context: GrantCaller,
  projectId: ProjectId,
) {
  const work = yield* workGrantOf(context);
  if (work === undefined) return undefined;
  yield* refuseRevoked(work);
  const project = yield* findProject(projectId);
  if (project === undefined) return yield* unreachable(work, "project");
  yield* assertProjectInGrant(work, project);
  return work;
});

/** Whether the grant covers a project, for filtering what a caller lists. */
export const projectReachable = (work: WorkGrantContext | undefined, projectId: ProjectId) =>
  work === undefined
    ? Effect.succeed(true)
    : work.grant.revoked
      ? Effect.succeed(false)
      : findProject(projectId).pipe(
          Effect.map(
            (project) =>
              project !== undefined &&
              projectInGrant(work.grant.projects, work.grant.coordinatorEnvironmentId, project),
          ),
        );

/** Reading a thread: the grant must cover its project. */
export const assertThreadReadable = Effect.fn("mcp.assertThreadReadable")(function* (
  context: GrantCaller,
  thread: Pick<OrchestrationV2ThreadShell, "projectId">,
) {
  const work = yield* workGrantOf(context);
  yield* assertThreadInGrant(work, thread);
  return work;
});

/**
 * Changing a thread, the caller's own included: the grant must cover its
 * project, and in a project with a coordinator on each machine the thread must
 * be one the grant's own coordinator owns.
 */
export const assertThreadChangeable = Effect.fn("mcp.assertThreadChangeable")(function* (
  context: GrantCaller,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage">,
) {
  const work = yield* workGrantOf(context);
  yield* assertThreadInGrant(work, thread);
  yield* assertThreadWritable(work, thread);
  return work;
});

/**
 * Routines are refused to another machine's work until a routine records the
 * grant it was made under: a routine runs later as this machine's own work,
 * outside the grant's projects, sign-ins and revocation. A legacy grant (the
 * owner's own machines, from before grants) keeps managing routines as it did.
 */
export const refuseGrantRoutineChange = Effect.fn("mcp.refuseGrantRoutineChange")(function* (
  context: GrantCaller,
) {
  const work = yield* workGrantOf(context);
  if (work === undefined || work.grant.legacy === true) return;
  return yield* new OrchestratorMcpFailure({
    code: "outside_grant_scope",
    message: `This machine does not let ${work.coordinatorLabel}'s work create, change, delete or run its scheduled routines. Ask the user here to set up the routine, or schedule it on ${work.coordinatorLabel}.`,
  });
});
