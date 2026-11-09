import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import { teamRulesMachineLinkRefusal } from "@specweave-studio/shared/teamRules";
import {
  isProjectCoordinatorThreadId,
  OrchestratorMcpFailure,
  type ProjectLinkError,
  type OrchestratorMcpDelegation,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type ProviderInstanceId,
  type StandbyRearmReason,
} from "@specweave-studio/contracts";
import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import * as WorkerEpochStore from "../fleet/WorkerEpochStore.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import {
  accountInGrant,
  checkIncomingDelegation,
  delegationRefusal,
  type EffectiveWorkGrant,
  projectInGrant,
  type WorkOrigin,
} from "../fleet/workGrantPolicy.ts";
import { ProjectLink } from "../project/ProjectLink.ts";
import { PEER_ARM_NO_CONSENT, STANDBY_CAPABILITY_REFUSAL } from "../project/ProjectLinkStandby.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
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
  /** The coordinator epochs the calling machine named, one per linked project it coordinates. */
  readonly coordinatorEpochs?: ReadonlyMap<string, number> | undefined;
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

/**
 * Machine names for messages: the nickname the user gave a machine (shared
 * across the fleet), else its name in this machine's fleet list. Read without
 * adding a requirement, so every tool can name the coordinator.
 */
const labelsOf = Effect.gen(function* () {
  const fleet = yield* RemoteWorkers.RemoteWorkers.pipe(
    Effect.flatMap((remote) => remote.machineLabels),
  );
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (Option.isNone(settings)) return fleet;
  const read = yield* settings.value.getSettings.pipe(Effect.option);
  const nicknames = Option.isSome(read) ? read.value.machineNicknames : {};
  const labels = new Map(fleet);
  for (const [environmentId, entry] of Object.entries(nicknames)) {
    const name = normalizeMachineNickname(entry.name);
    if (name !== "") labels.set(environmentId, name);
  }
  return labels;
});

/** Never an environment id in a sentence the user reads (bugs fleet-04, m4core-03). */
export const COORDINATOR_FALLBACK_LABEL = "the coordinating machine";

const coordinatorLabelOf = (labels: ReadonlyMap<string, string>, environmentId: string) =>
  labels.get(environmentId) ?? COORDINATOR_FALLBACK_LABEL;

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
      coordinatorLabel: coordinatorLabelOf(labels, grant.coordinatorEnvironmentId),
      coordinatorEpochs: context.scope.client?.coordinatorEpochs,
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
    coordinatorLabel: coordinatorLabelOf(labels, grant.coordinatorEnvironmentId),
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
              ? `Project "${project.title}" on this machine is not linked to ${work.coordinatorLabel}, and this machine lets ${work.coordinatorLabel} run work only in linked projects. Link the projects, or widen what ${work.coordinatorLabel} may use here in Settings > Machines > Who can run work here.`
              : `This machine does not let ${work.coordinatorLabel} run work in project "${project.title}". The user can add it in Settings > Machines > Who can run work here.`,
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
          ? `This machine lets ${work.coordinatorLabel} use none of its sign-ins, so it cannot start work here. The user can allow sign-ins in Settings > Machines > Who can run work here.`
          : `This machine lets ${work.coordinatorLabel} use only these sign-ins: ${allowed.join(", ")}. Pass modelSelection with one of them (orchestrator_capabilities lists their models), or the user can allow ${instanceId} in Settings > Machines > Who can run work here.`,
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
 * After a coordinator took over a linked project and claimed its epoch here,
 * the other machine steers that project's threads only if it names a higher
 * epoch, or that epoch as the machine that claimed it: the coordinator it
 * replaced still believes an older one, or names none, and may read but no
 * longer steer. Threads another machine's work started here act under that
 * work's origin and are not held to it.
 */
export const assertCoordinatorEpoch = Effect.fn("mcp.assertCoordinatorEpoch")(function* (
  work: WorkGrantContext,
  project: Project,
) {
  if (work.origin !== undefined) return;
  const identity = project.workspaceSettings?.logicalProject;
  if (identity === undefined || identity.members.length < 2) return;
  const store = yield* WorkerEpochStore.WorkerEpochStore;
  const claimed = yield* store.get(identity.id).pipe(Effect.mapError(storageFailure));
  if (
    WorkerEpochStore.epochAdmits(
      claimed,
      work.coordinatorEpochs?.get(identity.id),
      work.grant.coordinatorEnvironmentId,
    )
  )
    return;
  return yield* new OrchestratorMcpFailure({
    code: "thread_fenced",
    message: `Another machine now coordinates "${project.title}". This machine takes steering for it only from that coordinator. ${work.coordinatorLabel} may still read its threads.`,
  });
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
  yield* assertCoordinatorEpoch(work, project);
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

/** Where the user lets another machine's coordinator manage routines here. */
export const ROUTINES_GRANT_HINT =
  "The user can allow it with Manage scheduled routines in Settings > Machines > Who can run work here.";

/**
 * Another machine's work may create, change, delete or run this machine's
 * scheduled routines only when its grant allows routines, and only in a
 * project the grant covers. A routine made or changed that way records the
 * grant (see ScheduledTaskGrantGate), so it stops when the grant does. A
 * legacy grant (the owner's own machines, from before grants) keeps managing
 * routines as it did. Without a project only the capability is checked, so a
 * caller refused anyway learns nothing about this machine's routines. Returns
 * the grant the change is made under, if any.
 */
export const refuseGrantRoutineChange = Effect.fn("mcp.refuseGrantRoutineChange")(function* (
  context: GrantCaller,
  projectId: ProjectId | undefined,
) {
  const work = yield* workGrantOf(context);
  if (work === undefined || work.grant.legacy === true) return undefined;
  yield* refuseRevoked(work);
  if (!work.grant.routines)
    return yield* new OrchestratorMcpFailure({
      code: "outside_grant_scope",
      message: `This machine does not let ${work.coordinatorLabel}'s work create, change, delete or run its scheduled routines. Ask the user here to set up the routine, or schedule it on ${work.coordinatorLabel}. ${ROUTINES_GRANT_HINT}`,
    });
  if (projectId === undefined) return work;
  const project = yield* findProject(projectId);
  if (project === undefined) return yield* unreachable(work, "project");
  yield* assertProjectInGrant(work, project);
  return work;
});

/** At most this many threads' origins come back from one claim, as many as a lease reports. */
export const CLAIM_EPOCH_MAX_THREADS = 50;

export interface CoordinatorEpochClaimInput {
  readonly logicalProjectId: string;
  readonly epoch: number;
  readonly threadIds?: ReadonlyArray<string> | undefined;
  /** Register this machine as the caller's standby, under the owner's re-arm consent here. */
  readonly standby?: { readonly chainId: string } | undefined;
}

/** Whether this machine now stands by for the caller, and why not. */
export interface ClaimStandbyAnswer {
  readonly armed: boolean;
  readonly code?: StandbyRearmReason | undefined;
  readonly message?: string | undefined;
}

/**
 * What a refused peer registration tells the coordinator that asked.
 * `teamRulesMessage` is this machine's team-rules refusal, when there is one:
 * a registration refused under the lock because the rules changed carries it.
 */
export function peerArmCode(
  error: ProjectLinkError,
  teamRulesMessage?: string,
): StandbyRearmReason {
  if (error.detail === PEER_ARM_NO_CONSENT) return "no_consent";
  if (
    error.code === "invalid" &&
    teamRulesMessage !== undefined &&
    error.detail === teamRulesMessage
  )
    return "team_rules";
  switch (error.code) {
    case "superseded_conflict":
      return "superseded_conflict";
    case "not_member":
    case "not_linked":
    case "handoff_in_progress":
      return "not_member";
    case "invalid":
      return error.detail === STANDBY_CAPABILITY_REFUSAL ? "needs_update" : "refused";
    default:
      return "refused";
  }
}

export interface CoordinatorEpochClaimResult {
  readonly logicalProjectId: string;
  readonly accepted: boolean;
  readonly epoch: number;
  readonly origins: ReadonlyArray<{
    readonly threadId: string;
    readonly coordinatorEnvironmentId: string | null;
  }>;
  /** Present when the claim asked for a standby registration. */
  readonly standby?: ClaimStandbyAnswer;
}

/**
 * A coordinator that took over a linked project claims its epoch here, and
 * learns which of the listed threads the coordinator it replaced started, so
 * it adopts only those. Only another machine's own grant may claim, in a
 * project that grant covers; a thread outside this machine's copy of the
 * project has no origin to report.
 */
export const claimCoordinatorEpoch = Effect.fn("mcp.claimCoordinatorEpoch")(function* (
  context: Caller,
  input: CoordinatorEpochClaimInput,
) {
  const work = yield* workGrantOf(context);
  if (work === undefined || work.origin !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "outside_grant_scope",
      message: "Only another machine's coordinator claims a project here.",
    });
  yield* refuseRevoked(work);
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  const project = Option.isNone(projects)
    ? undefined
    : (yield* projects.value.snapshot.pipe(
        Effect.map((snapshot) => snapshot.projects),
        Effect.orElseSucceed(() => []),
      )).find(
        (candidate) =>
          candidate.deletedAt === null &&
          candidate.workspaceSettings?.logicalProject?.id === input.logicalProjectId,
      );
  if (project === undefined) return yield* unreachable(work, "project");
  yield* assertProjectInGrant(work, project);
  const store = yield* WorkerEpochStore.WorkerEpochStore;
  const claimed = yield* store
    .claim({
      logicalProjectId: input.logicalProjectId,
      epoch: input.epoch,
      by: work.grant.coordinatorEnvironmentId,
    })
    .pipe(Effect.mapError(storageFailure));
  const grants = yield* WorkGrants.WorkGrants;
  const origins: Array<CoordinatorEpochClaimResult["origins"][number]> = [];
  for (const threadId of [...new Set(input.threadIds ?? [])].slice(0, CLAIM_EPOCH_MAX_THREADS)) {
    const shell = yield* context.threads
      .getThreadShell(threadId as never)
      .pipe(Effect.orElseSucceed(() => null));
    const origin =
      shell === null || shell === undefined || shell.projectId !== project.id
        ? undefined
        : yield* grants.originOf(shell).pipe(Effect.mapError(storageFailure));
    origins.push({ threadId, coordinatorEnvironmentId: origin?.coordinatorEnvironmentId ?? null });
  }
  const standby =
    input.standby === undefined
      ? undefined
      : yield* registerStandby(work, input, input.standby.chainId, claimed.accepted);
  return {
    logicalProjectId: input.logicalProjectId,
    accepted: claimed.accepted,
    epoch: claimed.epoch,
    origins,
    ...(standby === undefined ? {} : { standby }),
  } satisfies CoordinatorEpochClaimResult;
});

/**
 * A coordinator that took over automatically asks this machine to stand by
 * for it. Only a claim that stands may; the caller is the machine its grant
 * names, and the owner's consent here decides the rest. A refusal is an
 * answer, never a failure of the claim.
 */
const registerStandby = Effect.fn("mcp.claimCoordinatorEpoch.standby")(function* (
  work: WorkGrantContext,
  input: CoordinatorEpochClaimInput,
  chainId: string,
  claimAccepted: boolean,
) {
  if (!claimAccepted) return { armed: false, code: "superseded_conflict" } as ClaimStandbyAnswer;
  const refused = teamRulesMachineLinkRefusal(yield* currentTeamRules);
  if (refused !== null)
    return {
      armed: false,
      code: "team_rules",
      message: refused.message.slice(0, 1000),
    } as ClaimStandbyAnswer;
  const link = yield* Effect.serviceOption(ProjectLink);
  if (Option.isNone(link)) return { armed: false, code: "refused" } as ClaimStandbyAnswer;
  return yield* link.value
    .acceptStandbyFromPeer({
      logicalProjectId: input.logicalProjectId,
      callerEnvironmentId: work.grant.coordinatorEnvironmentId,
      epoch: input.epoch,
      chainId,
    })
    .pipe(
      Effect.as({ armed: true } as ClaimStandbyAnswer),
      Effect.catchTag("ProjectLinkError", (error) =>
        Effect.map(currentTeamRules, (rules) => ({
          armed: false,
          code: peerArmCode(error, teamRulesMachineLinkRefusal(rules)?.message),
          ...(error.detail === undefined || error.detail === PEER_ARM_NO_CONSENT
            ? {}
            : { message: error.detail.slice(0, 1000) }),
        })),
      ),
      Effect.map((answer): ClaimStandbyAnswer => answer),
    );
});
