import {
  isProjectCoordinatorThreadId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegation,
  type OrchestrationV2ThreadShell,
  type Project,
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
export const workGrantOf = Effect.fn("mcp.workGrantOf")(function* (context: Caller) {
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

const refuseRevoked = (work: WorkGrantContext) =>
  work.grant.revoked
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "machine_not_authorized",
          message: `This machine revoked work from ${work.coordinatorLabel}.`,
        }),
      )
    : Effect.void;

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
          message:
            work.grant.projects.kind === "linked"
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
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  if (project === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "outside_grant_scope",
      message: `This machine does not let ${work.coordinatorLabel} reach that thread.`,
    });
  yield* assertProjectInGrant(work, project);
});

/**
 * With a coordinator on each machine of a linked project, a thread is steered
 * only by the coordinator that owns it: this machine's, or the one whose work
 * started it here. Another machine's work may still read every thread the
 * grant covers. A copy that runs no coordinator of its own (it relinquished
 * it at link time) keeps taking work from the project's coordinator.
 */
export const assertThreadWritable = Effect.fn("mcp.assertThreadWritable")(function* (
  work: WorkGrantContext | undefined,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage">,
) {
  if (work === undefined) return;
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const settings = project?.workspaceSettings;
  if (project === undefined || (settings?.logicalProject?.members.length ?? 0) < 2) return;
  if (settings?.coordinatorBinding !== undefined && settings.coordinatorBinding.state !== "active")
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
    message: `This thread belongs to this machine's own coordinator for "${project.title}", so ${work.coordinatorLabel} may read it but not send to, interrupt or change it. Ask this machine's coordinator, or migrate the thread first.`,
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
