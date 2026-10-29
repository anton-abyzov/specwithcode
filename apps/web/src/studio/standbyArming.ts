import type {
  CoordinatorStandbyAfterMinutes,
  EnvironmentId,
  LogicalProjectMember,
  ProjectAcceptStandbyInput,
  ProjectId,
  ProjectSetStandbyInput,
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
}

export interface StandbyArmingResult {
  /** Both sides armed: the standby registered the coordinator, the coordinator names it. */
  readonly armed: boolean;
  readonly machines: ReadonlyMap<EnvironmentId, StandbyMachineResult>;
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
    return { armed: false, machines };
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
  return { armed: true, machines };
}

/**
 * Turns automatic takeover off. The coordinator releases its standby before
 * the change commits, and refuses when the standby does not answer unless
 * `changeAnyway`. The standby's own registration is then cleared when it can
 * be reached; a released standby disarms on its own otherwise.
 */
export async function disarmStandby(
  commands: StandbyProjectCommands,
  input: {
    readonly logicalProjectId: string;
    readonly coordinator: StandbySide;
    readonly standby: StandbySide | null;
    readonly operationId: string;
    readonly changeAnyway: boolean;
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
}
