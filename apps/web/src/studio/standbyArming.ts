import type {
  CoordinatorStandbyAfterMinutes,
  EnvironmentId,
  LogicalProjectMember,
  ProjectAcceptStandbyInput,
  ProjectId,
  ProjectLinkSyncMembersInput,
  ProjectSetStandbyInput,
  StandbyRearmConsent,
} from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioFleetWorkerAccess,
  StudioFleetWorkers,
  StudioWorkGrant,
  StudioWorkGrantProjects,
  StudioWorkGrantsSnapshot,
  StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";

/**
 * Arming automatic takeover (1086). The owner's desktop app, holding
 * full-access sessions to every machine involved, gives the chosen standby a
 * worker grant on each machine the coordinator runs workers on, so it can
 * reach those workers after it takes over. The chain per worker machine W:
 * invite on W, add W on the standby, allow workers there, narrow the grant to
 * W's copy of this one project, then revoke the setup management session on
 * W: the one a Tailscale line names, or the one a line over SpecWithCode
 * Connect was redeemed for. Nothing is minted for the standby on the coordinator, or
 * between machines the owner did not choose.
 */

/** A machine the coordinator runs workers on, holding a copy of this project. */
export interface StandbyWorkerMachine {
  readonly environmentId: EnvironmentId;
  /** W's own copy of the project: the only project the standby's grant covers. */
  readonly projectId: ProjectId;
  readonly label: string;
  /** The coordinator's own worker access on W: the standby never gets more. */
  readonly access: StudioFleetWorkerAccess;
}

const LIVE_WORKERS = new Set<StudioFleetWorkers["status"]>(["allowed", "expiring"]);
/** How far another machine's clock may run behind this one when matching a redeemed session. */
const REDEEM_CLOCK_SKEW_MS = 10 * 60_000;

/**
 * The machines the standby needs a grant on: every machine where the
 * coordinator's own workers are allowed and that holds a copy of this
 * project. The coordinator and the standby themselves are never on the list.
 */
export function standbyWorkerMachines(input: {
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly standbyEnvironmentId: EnvironmentId;
  readonly coordinatorFleet: StudioFleetSnapshot | null;
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  readonly label: (environmentId: EnvironmentId) => string;
}): StandbyWorkerMachine[] {
  const machines: StandbyWorkerMachine[] = [];
  for (const machine of input.coordinatorFleet?.machines ?? []) {
    const workers = machine.workers;
    if (!workers || !LIVE_WORKERS.has(workers.status) || workers.access === null) continue;
    if (
      machine.environmentId === input.coordinatorEnvironmentId ||
      machine.environmentId === input.standbyEnvironmentId ||
      machines.some((entry) => entry.environmentId === machine.environmentId)
    )
      continue;
    const copy = input.members.find((member) => member.environmentId === machine.environmentId);
    if (!copy) continue;
    machines.push({
      environmentId: machine.environmentId,
      projectId: copy.id,
      label: input.label(machine.environmentId),
      access: workers.access,
    });
  }
  return machines;
}

/** Why arming cannot start from this app, or null when it can. */
export function standbyArmingProblem(input: {
  readonly desktop: boolean;
  readonly standbyLabel: string;
  readonly standbyCapable: boolean;
  readonly fullAccess: (environmentId: EnvironmentId) => boolean;
  readonly label: (environmentId: EnvironmentId) => string;
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly standbyEnvironmentId: EnvironmentId;
  readonly workers: ReadonlyArray<StandbyWorkerMachine>;
}): string | null {
  if (!input.desktop) return "Set this up in the SpecWithCode desktop app.";
  if (!input.standbyCapable)
    return `Update SpecWithCode on ${input.standbyLabel} to take over automatically.`;
  const needed = [
    input.coordinatorEnvironmentId,
    input.standbyEnvironmentId,
    ...input.workers.map((worker) => worker.environmentId),
  ];
  const missing = needed.find((environmentId) => !input.fullAccess(environmentId));
  return missing === undefined
    ? null
    : `This app needs full access to ${input.label(missing)} to set this up.`;
}

export type StandbyMachineResult =
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly message: string };

/** The calls arming makes; each throws an Error whose message the person can act on. */
export interface StandbyArmingCommands {
  readonly fleet: (environmentId: EnvironmentId) => Promise<StudioFleetSnapshot>;
  readonly workGrants: (environmentId: EnvironmentId) => Promise<StudioWorkGrantsSnapshot>;
  readonly invite: (
    environmentId: EnvironmentId,
    input: { readonly coordinatorEnvironmentId: EnvironmentId },
  ) => Promise<{ readonly code: string; readonly sessionId?: string | undefined }>;
  /**
   * `sessionId`: the management session a line over SpecWithCode Connect was
   * redeemed for, which its invitation cannot name before it is spent.
   */
  readonly add: (
    environmentId: EnvironmentId,
    invitation: string,
  ) => Promise<{ readonly id: string; readonly sessionId?: string | undefined }>;
  readonly allow: (
    environmentId: EnvironmentId,
    input: { readonly id: string; readonly access: StudioFleetWorkerAccess },
  ) => Promise<StudioFleetWorkers>;
  readonly updateGrant: (
    environmentId: EnvironmentId,
    input: StudioWorkGrantUpdateInput,
  ) => Promise<StudioWorkGrant>;
  readonly revokeSession: (environmentId: EnvironmentId, sessionId: string) => Promise<void>;
  /**
   * Management sessions invitations on `environmentId` were redeemed for by
   * `coordinatorEnvironmentId`, issued at or after `sinceMs`. A line over
   * SpecWithCode Connect names its session only in the answer to add, so a
   * failed or lost answer leaves this the only way to find it.
   */
  readonly redeemedSessions: (
    environmentId: EnvironmentId,
    coordinatorEnvironmentId: EnvironmentId,
    sinceMs: number,
  ) => Promise<ReadonlyArray<string>>;
  /**
   * Management sessions on a machine whose revoke did not go through, kept on
   * this device so the next attempt revokes them first.
   */
  readonly pendingRevocations: {
    readonly read: (environmentId: EnvironmentId) => ReadonlyArray<string>;
    readonly write: (environmentId: EnvironmentId, sessionIds: ReadonlyArray<string>) => void;
  };
}

/**
 * The project scope the standby's grant on W should have, or null to leave
 * it: a grant arming created covers only W's copy; a listed grant gains it;
 * a broader grant the owner gave earlier stays as it was.
 */
export function standbyGrantScope(
  before: StudioWorkGrant | undefined,
  projectId: ProjectId,
): StudioWorkGrantProjects | null {
  if (before === undefined) return { kind: "listed", projectIds: [projectId] };
  if (before.projects.kind !== "listed" || before.projects.projectIds.includes(projectId))
    return null;
  return { kind: "listed", projectIds: [...before.projects.projectIds, projectId] };
}

const problemText = (
  workers: StudioFleetWorkers,
  standbyLabel: string,
  worker: StandbyWorkerMachine,
) =>
  workers.problem === "unreachable"
    ? `${worker.label} did not answer ${standbyLabel}. Check that both are on and connected.`
    : `${standbyLabel} could not get access on ${worker.label}. Try again.`;

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Revokes management sessions an earlier attempt left on W; keeps the ones that still fail. */
async function revokePending(commands: StandbyArmingCommands, environmentId: EnvironmentId) {
  const pending = commands.pendingRevocations.read(environmentId);
  if (pending.length === 0) return;
  const kept: string[] = [];
  for (const sessionId of pending)
    await commands.revokeSession(environmentId, sessionId).catch(() => kept.push(sessionId));
  commands.pendingRevocations.write(environmentId, kept);
}

/**
 * Makes sure the standby holds a live worker grant on W scoped to W's copy of
 * this project. A live grant is reused; otherwise the full chain runs, and
 * the invitation's management session is revoked whatever happens after it.
 */
export async function ensureStandbyGrant(
  commands: StandbyArmingCommands,
  input: {
    readonly standbyEnvironmentId: EnvironmentId;
    readonly standbyLabel: string;
    readonly worker: StandbyWorkerMachine;
  },
): Promise<StandbyMachineResult> {
  const { worker, standbyEnvironmentId: standby } = input;
  try {
    await revokePending(commands, worker.environmentId);
    const [standbyFleet, grants] = await Promise.all([
      commands.fleet(standby),
      commands.workGrants(worker.environmentId),
    ]);
    const entry = standbyFleet.machines.find(
      (machine) => machine.environmentId === worker.environmentId,
    );
    const before = grants.grants.find((grant) => grant.coordinatorEnvironmentId === standby);
    if (before?.status === "revoked")
      return {
        status: "failed",
        message: `${worker.label} stopped ${input.standbyLabel}'s access. Restore it on ${worker.label} first.`,
      };
    const live =
      entry?.workers !== undefined &&
      LIVE_WORKERS.has(entry.workers.status) &&
      before?.status === "active";
    if (!live) {
      const sessionIds: string[] = [];
      try {
        // Clocks differ between machines: look a little before this attempt.
        const invitedAt = Date.now() - REDEEM_CLOCK_SKEW_MS;
        const invitation = await commands.invite(worker.environmentId, {
          coordinatorEnvironmentId: standby,
        });
        if (invitation.sessionId) sessionIds.push(invitation.sessionId);
        const added = await commands.add(standby, invitation.code).catch(async (cause: unknown) => {
          // The line may have been redeemed before add failed or its answer was lost.
          if (sessionIds.length === 0)
            sessionIds.push(
              ...(await commands
                .redeemedSessions(worker.environmentId, standby, invitedAt)
                .catch(() => [])),
            );
          throw cause;
        });
        if (sessionIds.length === 0 && added.sessionId) sessionIds.push(added.sessionId);
        const workers = await commands.allow(standby, { id: added.id, access: worker.access });
        if (!LIVE_WORKERS.has(workers.status))
          return { status: "failed", message: problemText(workers, input.standbyLabel, worker) };
        const scope = standbyGrantScope(before, worker.projectId);
        if (scope)
          await commands.updateGrant(worker.environmentId, {
            coordinatorEnvironmentId: standby,
            projects: scope,
          });
      } finally {
        for (const revoked of sessionIds) {
          await commands
            .revokeSession(worker.environmentId, revoked)
            .catch(() =>
              commands.pendingRevocations.write(worker.environmentId, [
                ...commands.pendingRevocations.read(worker.environmentId),
                revoked,
              ]),
            );
        }
      }
      if (commands.pendingRevocations.read(worker.environmentId).length > 0)
        return {
          status: "failed",
          message: `Could not remove the setup access on ${worker.label}. Try again.`,
        };
      return { status: "ready" };
    }
    const scope = standbyGrantScope(before, worker.projectId);
    if (scope)
      await commands.updateGrant(worker.environmentId, {
        coordinatorEnvironmentId: standby,
        projects: scope,
      });
    return { status: "ready" };
  } catch (cause) {
    return {
      status: "failed",
      message: messageOf(cause, `${input.standbyLabel} could not get access on ${worker.label}.`),
    };
  }
}

export interface StandbySide {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly member: LogicalProjectMember;
  readonly label: string;
}

export interface StandbyProjectCommands {
  readonly setStandby: (
    environmentId: EnvironmentId,
    input: ProjectSetStandbyInput,
  ) => Promise<void>;
  readonly acceptStandby: (
    environmentId: EnvironmentId,
    input: ProjectAcceptStandbyInput,
  ) => Promise<void>;
  /** A member copy adopts the coordinator's member list; absent where the app cannot. */
  readonly syncMembers?: (
    environmentId: EnvironmentId,
    input: ProjectLinkSyncMembersInput,
  ) => Promise<void>;
}

/**
 * Re-arming after an automatic takeover. The owner may list the machines to
 * arm next: whichever of them takes over registers the next one as its own
 * standby. Each machine on the list holds the owner's consent naming the
 * whole list, and a worker grant on every other machine involved, so the one
 * that takes over can reach the next one and the workers.
 */

/** How many machines the owner may list after the standby; the server takes a few more. */
export const STANDBY_REARM_NEXT_MAX = 3;

/** One list machine's state after a save: its consent is written, or why not. */
export type RearmMachineResult =
  | { readonly status: "ready" }
  | { readonly status: "needs_update" }
  | { readonly status: "failed"; readonly message: string };

/** The owner's "if it takes over, arm next" list for one save. */
export interface StandbyRearmPlan {
  /** In the owner's order, after the standby; empty turns re-arming off. */
  readonly order: ReadonlyArray<StandbySide>;
  /** The machines the last list named: those left out lose their consent. */
  readonly previous: ReadonlyArray<StandbySide>;
  /** The coordinator epoch now; a peer may only arm at or above it. */
  readonly fromEpoch: number;
  /** Whether the machine's server holds a re-arm consent at all. */
  readonly capable: (environmentId: EnvironmentId) => boolean;
  /** The worker access a list machine gets on another list machine. */
  readonly access: (environmentId: EnvironmentId) => StudioFleetWorkerAccess;
  /**
   * The coordinator's member list. Each listed machine adopts it before its
   * consent is written, so a machine that joined before another one was
   * linked accepts a list naming it.
   */
  readonly coordinator?:
    | {
        readonly environmentId: EnvironmentId;
        readonly logicalProjectId: string;
        readonly member: LogicalProjectMember;
        readonly epoch: number;
        readonly members: ReadonlyArray<LogicalProjectMember>;
      }
    | undefined;
  /** Whether the machine's server adopts a member list (`linkedMembersSync`). */
  readonly membersSyncCapable?: ((environmentId: EnvironmentId) => boolean) | undefined;
}

const sameSide = (
  left: { environmentId: EnvironmentId },
  right: { environmentId: EnvironmentId },
) => left.environmentId === right.environmentId;

/**
 * Every grant a list needs: each listed machine on every other listed machine
 * and on every worker machine, so whichever takes over reaches all of them.
 */
export function rearmGrantPairs(input: {
  readonly members: ReadonlyArray<StandbySide>;
  readonly workers: ReadonlyArray<StandbyWorkerMachine>;
  readonly access: (environmentId: EnvironmentId) => StudioFleetWorkerAccess;
}): ReadonlyArray<{ readonly from: StandbySide; readonly on: StandbyWorkerMachine }> {
  const targets: StandbyWorkerMachine[] = [...input.workers];
  for (const member of input.members)
    if (!targets.some((target) => sameSide(target, member)))
      targets.push({
        environmentId: member.environmentId,
        projectId: member.projectId,
        label: member.label,
        access: input.access(member.environmentId),
      });
  return input.members.flatMap((from) =>
    targets.filter((on) => !sameSide(on, from)).map((on) => ({ from, on })),
  );
}

/**
 * Gives each listed machine its grants. A pair that fails marks the machine
 * it is for; the first failure is the one reported.
 */
export async function prepareRearmMachines(
  commands: StandbyArmingCommands,
  pairs: ReturnType<typeof rearmGrantPairs>,
): Promise<ReadonlyMap<EnvironmentId, StandbyMachineResult>> {
  const results = new Map<EnvironmentId, StandbyMachineResult>();
  for (const pair of pairs) {
    const result = await ensureStandbyGrant(commands, {
      standbyEnvironmentId: pair.from.environmentId,
      standbyLabel: pair.from.label,
      worker: pair.on,
    });
    if (results.get(pair.from.environmentId)?.status !== "failed")
      results.set(pair.from.environmentId, result);
  }
  return results;
}

/**
 * Brings each listed machine's member list in line with the coordinator's,
 * best effort: a machine that refuses keeps its list, and its consent then
 * says why.
 */
export async function syncRearmMembers(
  commands: StandbyProjectCommands,
  plan: Pick<StandbyRearmPlan, "coordinator" | "membersSyncCapable">,
  members: ReadonlyArray<StandbySide>,
): Promise<void> {
  const coordinator = plan.coordinator;
  const sync = commands.syncMembers;
  if (!coordinator || !sync) return;
  await Promise.allSettled(
    members
      .filter(
        (member) =>
          member.environmentId !== coordinator.environmentId &&
          plan.membersSyncCapable?.(member.environmentId) === true,
      )
      .map((member) =>
        sync(member.environmentId, {
          projectId: member.projectId,
          logicalProjectId: coordinator.logicalProjectId,
          from: coordinator.member,
          fromEpoch: coordinator.epoch,
          members: coordinator.members,
        }),
      ),
  );
}

/**
 * Writes the consent, or removes it with null, on each machine. A machine
 * whose server cannot hold one is not asked. A refusal keeps the machine's
 * own words.
 */
/** A consent write: done, a server too old to hold one, or the machine's refusal. */
export type ConsentWriteResult = "ok" | "needs_update" | { readonly failed: string };

export async function writeRearmConsent(
  commands: StandbyProjectCommands,
  input: {
    readonly logicalProjectId: string;
    readonly consent: StandbyRearmConsent | null;
    readonly members: ReadonlyArray<StandbySide>;
    readonly capable: (environmentId: EnvironmentId) => boolean;
  },
): Promise<ReadonlyMap<EnvironmentId, ConsentWriteResult>> {
  const results = new Map<EnvironmentId, ConsentWriteResult>();
  for (const member of input.members) {
    if (!input.capable(member.environmentId)) {
      results.set(member.environmentId, "needs_update");
      continue;
    }
    const written = await commands
      .acceptStandby(member.environmentId, {
        projectId: member.projectId,
        logicalProjectId: input.logicalProjectId,
        rearm: input.consent,
      })
      .then(
        (): ConsentWriteResult => "ok",
        (cause: unknown): ConsentWriteResult => ({ failed: messageOf(cause, "") }),
      );
    results.set(member.environmentId, written);
  }
  return results;
}

/**
 * Saves the list: grants first, then the consent on the standby and every
 * listed machine, then removes it from machines the list no longer names.
 * Nothing here blocks the standby itself; each machine reports on its own.
 */
export async function saveRearmList(
  commands: StandbyArmingCommands & StandbyProjectCommands,
  input: {
    readonly logicalProjectId: string;
    readonly standby: StandbySide;
    readonly afterMinutes: CoordinatorStandbyAfterMinutes;
    readonly chainId: string;
    readonly workers: ReadonlyArray<StandbyWorkerMachine>;
    readonly plan: StandbyRearmPlan;
  },
): Promise<ReadonlyMap<EnvironmentId, RearmMachineResult>> {
  const { plan } = input;
  const next = plan.order.filter((side) => !sameSide(side, input.standby));
  const members = next.length === 0 ? [] : [input.standby, ...next];
  const results = new Map<EnvironmentId, RearmMachineResult>();
  if (members.length > 0) {
    const listed = members.filter((member) => plan.capable(member.environmentId));
    // A machine that joined before another one was linked learns it first.
    await syncRearmMembers(commands, plan, listed);
    // The standby's grants on the worker machines are arming's own, made before this.
    const pairs = rearmGrantPairs({
      members: listed,
      workers: input.workers,
      access: plan.access,
    }).filter(
      (pair) =>
        !(
          sameSide(pair.from, input.standby) &&
          input.workers.some((worker) => sameSide(worker, pair.on))
        ),
    );
    const prepared = await prepareRearmMachines(commands, pairs);
    const written = await writeRearmConsent(commands, {
      logicalProjectId: input.logicalProjectId,
      consent: {
        chainId: input.chainId,
        members: members.map((member) => member.member),
        afterMinutes: input.afterMinutes,
        fromEpoch: plan.fromEpoch,
      },
      members,
      capable: plan.capable,
    });
    for (const member of members) {
      const write = written.get(member.environmentId);
      const grant = prepared.get(member.environmentId);
      results.set(
        member.environmentId,
        write === "needs_update"
          ? { status: "needs_update" }
          : typeof write === "object"
            ? {
                status: "failed",
                message: write.failed
                  ? `Could not save the list on ${member.label}: ${write.failed}`
                  : `Could not save the list on ${member.label}.`,
              }
            : grant?.status === "failed"
              ? grant
              : { status: "ready" },
      );
    }
  }
  const dropped = plan.previous.filter((side) => !members.some((member) => sameSide(member, side)));
  if (dropped.length > 0)
    await writeRearmConsent(commands, {
      logicalProjectId: input.logicalProjectId,
      consent: null,
      members: dropped,
      capable: plan.capable,
    });
  return results;
}

export type RearmProblem = "needs_update" | "no_consent" | "needs_grant" | "expiring";

/**
 * What stops each listed machine from arming the next one: an old server, a
 * consent from another list, a missing grant, or one that runs out and cannot
 * renew itself. Unknown answers raise nothing.
 */
export function rearmReadiness(input: {
  readonly members: ReadonlyArray<StandbySide>;
  readonly workers: ReadonlyArray<StandbyWorkerMachine>;
  readonly capable: (environmentId: EnvironmentId) => boolean;
  /** `from`'s worker grant on `on`; null when it has none, undefined when not known. */
  readonly grants: (
    from: EnvironmentId,
    on: EnvironmentId,
  ) => StudioFleetWorkers | null | undefined;
  /** The chain each machine holds; null for none, absent when not known. */
  readonly consents: ReadonlyMap<EnvironmentId, string | null>;
  readonly chainId: string;
}): ReadonlyArray<{ readonly member: StandbySide; readonly problem: RearmProblem | null }> {
  const pairs = rearmGrantPairs({
    members: input.members,
    workers: input.workers,
    access: () => "approval-required",
  });
  return input.members.map((member) => {
    if (!input.capable(member.environmentId)) return { member, problem: "needs_update" };
    const consent = input.consents.get(member.environmentId);
    if (consent !== undefined && consent !== input.chainId)
      return { member, problem: "no_consent" };
    let problem: RearmProblem | null = null;
    for (const pair of pairs) {
      if (!sameSide(pair.from, member)) continue;
      const grant = input.grants(member.environmentId, pair.on.environmentId);
      if (grant === undefined) continue;
      if (grant === null || !LIVE_WORKERS.has(grant.status))
        return { member, problem: "needs_grant" };
      if (grant.status === "expiring" || !grant.renewable) problem = "expiring";
    }
    return { member, problem };
  });
}

export interface StandbyArmingResult {
  /** Both sides armed: the standby registered the coordinator, the coordinator names it. */
  readonly armed: boolean;
  readonly machines: ReadonlyMap<EnvironmentId, StandbyMachineResult>;
  /** Each machine of the re-arm list; empty without one. */
  readonly rearm: ReadonlyMap<EnvironmentId, RearmMachineResult>;
}

/**
 * Turns automatic takeover on, or changes its standby or delay. Grants come
 * first; nothing is armed while a worker machine is not ready. The standby
 * accepts before the coordinator names it, so the first lease finds it
 * listening; when naming it fails, the standby is disarmed again.
 */
export async function armStandby(
  commands: StandbyArmingCommands & StandbyProjectCommands,
  input: {
    readonly logicalProjectId: string;
    readonly coordinator: StandbySide;
    /** The coordinator's current epoch, which the standby registers. */
    readonly epoch: number;
    readonly standby: StandbySide;
    readonly previousStandby: StandbySide | null;
    readonly afterMinutes: CoordinatorStandbyAfterMinutes;
    readonly workers: ReadonlyArray<StandbyWorkerMachine>;
    readonly operationId: string;
    readonly changeAnyway: boolean;
    /** The list to arm next after a takeover; its chain is this operation. */
    readonly rearm?: StandbyRearmPlan | undefined;
  },
): Promise<StandbyArmingResult> {
  const machines = new Map<EnvironmentId, StandbyMachineResult>();
  for (const worker of input.workers)
    machines.set(
      worker.environmentId,
      await ensureStandbyGrant(commands, {
        standbyEnvironmentId: input.standby.environmentId,
        standbyLabel: input.standby.label,
        worker,
      }),
    );
  if ([...machines.values()].some((result) => result.status !== "ready"))
    return { armed: false, machines, rearm: new Map() };
  // The list goes in before the standby registers, so it arms with the list in place.
  const rearm = input.rearm
    ? await saveRearmList(commands, {
        logicalProjectId: input.logicalProjectId,
        standby: input.standby,
        afterMinutes: input.afterMinutes,
        chainId: input.operationId,
        workers: input.workers,
        plan: input.rearm,
      })
    : new Map<EnvironmentId, RearmMachineResult>();
  await commands.acceptStandby(input.standby.environmentId, {
    projectId: input.standby.projectId,
    logicalProjectId: input.logicalProjectId,
    standby: {
      coordinator: input.coordinator.member,
      epoch: input.epoch,
      afterMinutes: input.afterMinutes,
    },
  });
  try {
    await commands.setStandby(input.coordinator.environmentId, {
      operationId: input.operationId,
      projectId: input.coordinator.projectId,
      standby: { member: input.standby.member, afterMinutes: input.afterMinutes },
      ...(input.changeAnyway ? { changeAnyway: true } : {}),
    });
  } catch (cause) {
    await commands
      .acceptStandby(input.standby.environmentId, {
        projectId: input.standby.projectId,
        logicalProjectId: input.logicalProjectId,
        standby: null,
      })
      .catch(() => undefined);
    throw cause;
  }
  const previous = input.previousStandby;
  if (previous && previous.environmentId !== input.standby.environmentId)
    // The coordinator already released it; this only clears its registration early.
    await commands
      .acceptStandby(previous.environmentId, {
        projectId: previous.projectId,
        logicalProjectId: input.logicalProjectId,
        standby: null,
      })
      .catch(() => undefined);
  return { armed: true, machines, rearm };
}

/**
 * Turns automatic takeover off. The coordinator releases its standby before
 * the change commits, and refuses when the standby does not answer unless
 * `changeAnyway`. The standby's own registration is then cleared when it can
 * be reached; a released standby disarms on its own otherwise. The re-arm
 * consent is removed from every list machine that answers.
 */
export async function disarmStandby(
  commands: StandbyProjectCommands,
  input: {
    readonly logicalProjectId: string;
    readonly coordinator: StandbySide;
    readonly standby: StandbySide | null;
    readonly operationId: string;
    readonly changeAnyway: boolean;
    /** The machines of the re-arm list, whose consent goes too. */
    readonly rearmMembers?: ReadonlyArray<StandbySide> | undefined;
    readonly rearmCapable?: ((environmentId: EnvironmentId) => boolean) | undefined;
  },
): Promise<void> {
  await commands.setStandby(input.coordinator.environmentId, {
    operationId: input.operationId,
    projectId: input.coordinator.projectId,
    standby: null,
    ...(input.changeAnyway ? { changeAnyway: true } : {}),
  });
  if (input.standby)
    await commands
      .acceptStandby(input.standby.environmentId, {
        projectId: input.standby.projectId,
        logicalProjectId: input.logicalProjectId,
        standby: null,
      })
      .catch(() => undefined);
  if (input.rearmMembers && input.rearmMembers.length > 0)
    await writeRearmConsent(commands, {
      logicalProjectId: input.logicalProjectId,
      consent: null,
      members: input.rearmMembers,
      capable: input.rearmCapable ?? (() => true),
    });
}
