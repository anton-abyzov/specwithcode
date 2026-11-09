/**
 * Away preflight (AC-01): what leaving this machine for `target` would do,
 * per thread, routine and coordinator, and every grant or link the target
 * still needs. Read-only: it composes the checks that already exist (the
 * target's grant status from the fleet list, handoff mode's per-thread
 * preflight, project links and the target's routines permission) and
 * changes no thread, routine, binding or grant.
 *
 * The decisions live in `buildAwayPlan`, a pure function over gathered
 * facts, so the rules are tested without a server.
 */
import {
  AWAY_PLAN_MAX_ITEMS,
  type AwayCoordinatorScope,
  AwayError,
  type AwayMissingGrant,
  type AwayPlan,
  type AwayPlanItem,
  type AwayPreflightInput,
  type EnvironmentId,
  type HandoffPreflightFailure,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpMachineStatus,
  type ProjectId,
  type ScheduledTask,
  type ThreadId,
  isProjectCoordinatorThreadId,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import { WORKTREE_SET_HANDOFF_MESSAGE } from "../handoff/HandoffMoves.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { coordinatorRoleOf } from "../project/CoordinatorRole.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { AwayAccess, type AwayTargetGrant } from "./AwayAccessRequest.ts";

/** A project whose coordinator runs on this machine. */
export interface AwayProjectFact {
  readonly id: ProjectId;
  readonly title: string;
  readonly personal: boolean;
  /** Its linked copy on the target, or null when the target has none. */
  readonly targetProjectId: ProjectId | null;
  /** The target's grant is live but leaves this project out. */
  readonly notInGrant: boolean;
  /**
   * Whether this machine runs the project's coordinator (default true). A
   * project listed only for its enabled routines gets no coordinator row.
   */
  readonly coordinated?: boolean;
  /**
   * This copy gave way to the target in a handover the target did not
   * confirm (the session's item is in-doubt): it is listed to finish it.
   */
  readonly inDoubt?: boolean;
}

/** The handoff preflight's answer for one thread, or why it could not run. */
export type AwayThreadCheck =
  | {
      readonly kind: "checked";
      readonly ok: boolean;
      readonly failures: ReadonlyArray<HandoffPreflightFailure>;
      readonly resume: boolean;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "skipped" };

export interface AwayThreadFact {
  readonly id: ThreadId;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly personal: boolean;
  readonly queued: boolean;
  readonly check: AwayThreadCheck;
}

export interface AwayRoutineFact {
  readonly id: string;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly webhook: boolean;
}

export interface AwayPlanFacts {
  readonly self: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly status: OrchestratorMcpMachineStatus;
  };
  readonly coordinatorScope: AwayCoordinatorScope;
  /**
   * Projects coordinated here (personal assistant included, so it can be listed
   * as staying), plus any other project with an enabled routine here.
   */
  readonly projects: ReadonlyArray<AwayProjectFact>;
  /** Running or queued threads that run here, coordinators left out. */
  readonly threads: ReadonlyArray<AwayThreadFact>;
  /** Enabled routines here, of any project. */
  readonly routines: ReadonlyArray<AwayRoutineFact>;
  /** What the target's grant for this machine allows, or null when it could not say. */
  readonly targetGrant: AwayTargetGrant | null;
  /**
   * Why the grant could not be read: `older` (no away route on the target) or
   * `failed`. Then nothing is known about routines, so the plan is not ready.
   */
  readonly targetGrantProblem?: "older" | "failed" | null;
  readonly checkedAt: string;
}

const clip = (text: string, max = 500) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Whether the target can take work at all; otherwise why not, in the user's words. */
export function targetBlocker(target: AwayPlanFacts["target"]): string | null {
  switch (target.status) {
    case "ready":
    case "grant_expiring":
    case "project_not_in_grant":
      return null;
    case "needs_grant":
      return `${target.label} does not let this machine run work there yet.`;
    case "grant_revoked":
      return `${target.label} stopped this machine's work there.`;
    case "grant_expired":
      return `This machine's access to ${target.label} expired.`;
    case "unreachable":
      return `${target.label} did not answer. Check that it is on and connected.`;
    case "identity_mismatch":
      return `${target.label} answered as a different machine.`;
    case "unsupported":
      return `${target.label} runs an older SpecWithCode. Update it first.`;
  }
}

/** The grant step the target's status asks for, if any. */
function machineGrantGap(facts: AwayPlanFacts): AwayMissingGrant | null {
  const { self, target } = facts;
  switch (target.status) {
    case "needs_grant":
      return {
        kind: "work-grant",
        machineEnvironmentId: self.environmentId,
        machineLabel: clip(self.label, 120),
        detail: clip(`${target.label} does not let ${self.label} run work there yet.`),
        fix: clip(`On this machine, open Settings > Machines and choose Allow on ${target.label}.`),
      };
    case "grant_expired":
      return {
        kind: "work-grant",
        machineEnvironmentId: self.environmentId,
        machineLabel: clip(self.label, 120),
        detail: clip(`This machine's access to ${target.label} expired.`),
        fix: clip(`On this machine, allow work on ${target.label} again in Settings > Machines.`),
      };
    case "grant_revoked":
      return {
        kind: "work-grant",
        machineEnvironmentId: target.environmentId,
        machineLabel: clip(target.label, 120),
        detail: clip(`${target.label} stopped ${self.label}'s work there.`),
        fix: clip(
          `On ${target.label}, restore ${self.label} in Settings > Machines > Who can run work here.`,
        ),
      };
    default:
      return null;
  }
}

/** The missing item a failed thread check names, if it names one. */
function failureGap(
  facts: AwayPlanFacts,
  thread: AwayThreadFact,
  projectTitle: string | undefined,
  failure: HandoffPreflightFailure,
): AwayMissingGrant | null {
  const { target, self } = facts;
  const onTarget = {
    machineEnvironmentId: target.environmentId,
    machineLabel: clip(target.label, 120),
    projectId: thread.projectId,
    ...(projectTitle === undefined ? {} : { projectTitle: clip(projectTitle) }),
    detail: clip(failure.message),
  };
  switch (failure.check) {
    case "provider":
    case "model":
      return {
        kind: "provider",
        ...onTarget,
        fix: clip(`On ${target.label}, sign in to the provider in Settings > Providers.`),
      };
    case "ignored-files":
      return {
        kind: "secret-file",
        ...onTarget,
        fix: clip(`Copy the missing file into the project folder on ${target.label}.`),
      };
    case "grant":
      return {
        kind: "work-grant",
        ...onTarget,
        fix: clip(
          `On ${target.label}, let ${self.label}'s work into this project in Settings > Machines > Who can run work here.`,
        ),
      };
    case "project-link":
      return {
        kind: "project-link",
        ...onTarget,
        fix: clip(
          `Link this project with its copy on ${target.label} in the project's Machines settings.`,
        ),
      };
    default:
      return null;
  }
}

const isWorktreeSet = (failures: ReadonlyArray<HandoffPreflightFailure>) =>
  failures.some((failure) => failure.message.startsWith(WORKTREE_SET_HANDOFF_MESSAGE.slice(0, 60)));

/** One row per thread: moves, stays here ready to continue elsewhere, or never leaves. */
export function threadItem(facts: AwayPlanFacts, thread: AwayThreadFact): AwayPlanItem {
  const base = {
    kind: "thread" as const,
    id: thread.id,
    title: clip(thread.title),
    projectId: thread.projectId,
  };
  if (thread.personal) {
    return { ...base, action: "stay", reason: "The personal assistant stays on this machine." };
  }
  const blocked = targetBlocker(facts.target);
  if (blocked !== null) return { ...base, action: "handoff-ready", reason: clip(blocked) };
  switch (thread.check.kind) {
    case "skipped":
      return {
        ...base,
        action: "handoff-ready",
        reason: clip(`Not checked against ${facts.target.label}.`),
      };
    case "error":
      return { ...base, action: "handoff-ready", reason: clip(thread.check.message) };
    case "checked": {
      if (isWorktreeSet(thread.check.failures)) {
        return {
          ...base,
          action: "stay",
          reason: "It works in a worktree set across several repositories. Finish it here.",
        };
      }
      if (!thread.check.ok) {
        const reason = thread.check.failures.map((failure) => failure.message).join(" ");
        return {
          ...base,
          action: "handoff-ready",
          reason: clip(reason === "" ? "A check on the target failed." : reason),
        };
      }
      const what = thread.queued
        ? "with its queued messages"
        : thread.check.resume
          ? "and continues its turn"
          : "";
      return {
        ...base,
        action: "move",
        reason: clip(`Moves to ${facts.target.label}${what === "" ? "" : ` ${what}`}.`),
      };
    }
  }
}

/** One row per enabled routine of a project coordinated here. */
export function routineItem(
  facts: AwayPlanFacts,
  routine: AwayRoutineFact,
  project: AwayProjectFact | undefined,
): AwayPlanItem {
  const base = {
    kind: "routine" as const,
    id: routine.id,
    title: clip(routine.title),
    projectId: routine.projectId,
  };
  if (project?.personal === true) {
    return {
      ...base,
      action: "stay",
      reason: "The personal assistant's routines stay on this machine.",
    };
  }
  if (routine.webhook) {
    return {
      ...base,
      action: "pause",
      reason: "Its URL belongs to this machine, so it pauses here while you are away.",
    };
  }
  if (project === undefined || project.targetProjectId === null) {
    return {
      ...base,
      action: "stay",
      reason: clip(`Stays until its project is linked on ${facts.target.label}.`),
    };
  }
  return {
    ...base,
    action: "move",
    reason: clip(`Moves to ${facts.target.label} with its run state.`),
  };
}

/** Whether a coordinator counts under `live` (D-03): running or queued work, or enabled routines. */
function isLive(facts: AwayPlanFacts, projectId: ProjectId) {
  return (
    facts.threads.some((thread) => thread.projectId === projectId) ||
    facts.routines.some((routine) => routine.projectId === projectId)
  );
}

export function coordinatorItem(facts: AwayPlanFacts, project: AwayProjectFact): AwayPlanItem {
  const base = { kind: "coordinator" as const, id: project.id, title: clip(project.title) };
  const withProject = { ...base, projectId: project.id };
  if (project.personal) {
    return {
      ...withProject,
      action: "stay",
      reason: "The personal assistant stays on this machine.",
    };
  }
  if (project.targetProjectId === null) {
    return {
      ...withProject,
      action: "stay",
      reason: clip(`Not linked with a copy on ${facts.target.label}, so it stays here.`),
    };
  }
  if (project.inDoubt === true)
    return {
      ...withProject,
      action: "move",
      reason: clip(
        `Finishes the handover to ${facts.target.label}, which it has not confirmed yet. No machine coordinates it until then.`,
      ),
    };
  const blocked = targetBlocker(facts.target);
  if (blocked !== null) return { ...withProject, action: "handoff-ready", reason: clip(blocked) };
  if (project.notInGrant) {
    return {
      ...withProject,
      action: "move",
      reason: clip(`Hands over once ${facts.target.label} lets this machine's work into it.`),
    };
  }
  return {
    ...withProject,
    action: "move",
    reason: clip(`Hands over to ${facts.target.label}. This machine's copy steps back.`),
  };
}

/** The link or grant step one project still needs on the target, if any. */
function projectGap(facts: AwayPlanFacts, project: AwayProjectFact): AwayMissingGrant | null {
  const { target, self } = facts;
  if (project.personal) return null;
  if (project.targetProjectId === null) {
    return {
      kind: "project-link",
      machineEnvironmentId: target.environmentId,
      machineLabel: clip(target.label, 120),
      projectId: project.id,
      projectTitle: clip(project.title),
      detail: clip(`${project.title} has no linked copy on ${target.label}.`),
      fix: clip(
        `Link ${project.title} with a copy on ${target.label} in the project's Machines settings.`,
      ),
    };
  }
  if (project.notInGrant) {
    return {
      kind: "work-grant",
      machineEnvironmentId: target.environmentId,
      machineLabel: clip(target.label, 120),
      projectId: project.id,
      projectTitle: clip(project.title),
      detail: clip(`${target.label}'s grant for ${self.label} leaves ${project.title} out.`),
      fix: clip(
        `On ${target.label}, add ${project.title} to ${self.label}'s projects in Settings > Machines > Who can run work here.`,
      ),
    };
  }
  return null;
}

/** The step when the target could not say what its grant allows. */
function grantUnreadableGap(facts: AwayPlanFacts): AwayMissingGrant | null {
  const { target, self } = facts;
  if (facts.targetGrantProblem == null || targetBlocker(target) !== null) return null;
  return facts.targetGrantProblem === "older"
    ? {
        kind: "work-grant",
        machineEnvironmentId: target.environmentId,
        machineLabel: clip(target.label, 120),
        detail: clip(
          `${target.label} runs an older SpecWithCode, so ${self.label} cannot check its access there.`,
        ),
        fix: clip(`Update ${target.label} to check access.`),
      }
    : {
        kind: "work-grant",
        machineEnvironmentId: target.environmentId,
        machineLabel: clip(target.label, 120),
        detail: clip(`${self.label} could not check its access on ${target.label}.`),
        fix: clip(`Check that ${target.label} is on and up to date, then check again.`),
      };
}

const gapKey = (gap: AwayMissingGrant) =>
  JSON.stringify([gap.kind, gap.machineEnvironmentId, gap.projectId ?? null, gap.detail]);

/** The whole plan: rows per kind, then every missing item once. */
export function buildAwayPlan(facts: AwayPlanFacts): AwayPlan {
  const { target, self } = facts;
  const projects = new Map(facts.projects.map((project) => [project.id, project]));
  const gaps = new Map<string, AwayMissingGrant>();
  const addGap = (gap: AwayMissingGrant | null) => {
    if (gap !== null && !gaps.has(gapKey(gap))) gaps.set(gapKey(gap), gap);
  };
  addGap(machineGrantGap(facts));
  addGap(grantUnreadableGap(facts));

  const threads = facts.threads.map((thread) => {
    const item = threadItem(facts, thread);
    if (item.action === "handoff-ready" && thread.check.kind === "checked") {
      for (const failure of thread.check.failures) {
        addGap(failureGap(facts, thread, projects.get(thread.projectId)?.title, failure));
      }
    }
    return item;
  });

  const routines = facts.routines.map((routine) =>
    routineItem(facts, routine, projects.get(routine.projectId)),
  );
  // Every routine that can leave (not paused, not the assistant's) needs its
  // project linked and in the grant, and the target's routines permission,
  // asked once per project. One that stays only for a missing link counts too.
  const leaving = routines.filter(
    (item) =>
      item.projectId !== undefined &&
      (item.action === "move" ||
        (item.action === "stay" && projects.get(item.projectId)?.personal !== true)),
  );
  for (const item of leaving) {
    const project = projects.get(item.projectId!);
    if (project !== undefined) addGap(projectGap(facts, project));
  }
  if (facts.targetGrant !== null && !facts.targetGrant.routines) {
    for (const item of leaving) {
      if (item.projectId === undefined) continue;
      const project = projects.get(item.projectId);
      addGap({
        kind: "routines",
        machineEnvironmentId: target.environmentId,
        machineLabel: clip(target.label, 120),
        projectId: item.projectId,
        ...(project === undefined ? {} : { projectTitle: clip(project.title) }),
        detail: clip(`${target.label} does not let ${self.label}'s coordinator manage routines.`),
        fix: clip(
          `On ${target.label}, turn on Routines for ${self.label} in Settings > Machines > Who can run work here.`,
        ),
      });
    }
  }

  const coordinators: Array<AwayPlanItem> = [];
  for (const project of facts.projects) {
    if (project.coordinated === false) continue;
    if (project.inDoubt !== true && facts.coordinatorScope === "live" && !isLive(facts, project.id))
      continue;
    coordinators.push(coordinatorItem(facts, project));
    addGap(projectGap(facts, project));
  }

  const missingGrants = [...gaps.values()].slice(0, 100);
  return {
    targetEnvironmentId: target.environmentId,
    targetLabel: clip(target.label, 120),
    items: [
      ...threads.slice(0, AWAY_PLAN_MAX_ITEMS),
      ...routines.slice(0, AWAY_PLAN_MAX_ITEMS),
      ...coordinators.slice(0, AWAY_PLAN_MAX_ITEMS),
    ],
    missingGrants,
    ready: missingGrants.length === 0 && targetBlocker(target) === null,
    checkedAt: facts.checkedAt,
  };
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * A copy that gave way to `target` in a handover the latest session lists as
 * in doubt: transferred, its successor the target.
 */
export function inDoubtHandover(
  project: {
    readonly id: string;
    readonly workspaceSettings?:
      | {
          readonly coordinatorBinding?:
            | {
                readonly state: string;
                readonly successor?: { readonly environmentId: string } | undefined;
              }
            | undefined;
        }
      | undefined;
  },
  inDoubt: ReadonlySet<string>,
  target: { readonly environmentId: string },
): boolean {
  const binding = project.workspaceSettings?.coordinatorBinding;
  return (
    inDoubt.has(project.id) &&
    binding?.state === "transferred" &&
    binding.successor?.environmentId === target.environmentId
  );
}

/** A live top-level thread with a turn running or messages queued. */
export function isAwayCandidate(
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "activityRunStatus"
    | "activeRunId"
    | "archivedAt"
    | "deletedAt"
    | "lineage"
    | "heldQueuedCount"
    | "executionMachineId"
  >,
  self: EnvironmentId,
): { readonly queued: boolean } | null {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return null;
  if (shell.lineage.relationshipToParent === "subagent") return null;
  // A thread another machine runs now is that machine's to move.
  if (shell.executionMachineId != null && shell.executionMachineId !== self) return null;
  const queued = (shell.heldQueuedCount ?? 0) > 0 || shell.status === "queued";
  const running =
    shell.activeRunId !== null || ACTIVE_RUN_STATUSES.has(shell.activityRunStatus ?? shell.status);
  return running || queued ? { queued } : null;
}

const isWebhookRoutine = (task: Pick<ScheduledTask, "schedule">) =>
  task.schedule.type === "webhook";

const PREFLIGHT_BATCH = 100;

export class AwayPlanner extends Context.Service<
  AwayPlanner,
  {
    /**
     * `inDoubtProjectIds`: copies the latest session handed over in doubt;
     * a transferred one whose successor is the target is listed to finish it.
     */
    readonly preflight: (
      input: AwayPreflightInput,
      options?: { readonly inDoubtProjectIds?: ReadonlyArray<ProjectId> },
    ) => Effect.Effect<AwayPlan, AwayError>;
  }
>()("specweave-studio/away/AwayPlanner") {}

export const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduled = yield* ScheduledTaskService;
  const access = yield* AwayAccess;
  const remote = yield* RemoteWorkers.RemoteWorkers;

  const preflight = (
    input: AwayPreflightInput,
    options?: { readonly inDoubtProjectIds?: ReadonlyArray<ProjectId> },
  ) =>
    Effect.gen(function* () {
      const inDoubt = new Set<string>(options?.inDoubtProjectIds ?? []);
      const self = handoff.environmentId;
      if (input.targetEnvironmentId === self) {
        return yield* new AwayError({
          code: "invalid",
          message: "Pick another machine to leave your work on.",
        });
      }
      const listed = yield* remote
        .listMachines({ projectId: undefined, probe: true })
        .pipe(
          Effect.mapError((failure) => new AwayError({ code: "failed", message: failure.message })),
        );
      const machine = listed.machines.find(
        (entry) => entry.environmentId === input.targetEnvironmentId,
      );
      if (machine === undefined) {
        return yield* new AwayError({
          code: "unknown_machine",
          message: "That machine is not one of your machines.",
        });
      }
      const target = {
        environmentId: machine.environmentId,
        label: machine.label,
        status: machine.status,
      };
      const usable = targetBlocker(target) === null;

      const snapshot = yield* projects.snapshot.pipe(
        Effect.mapError(
          () => new AwayError({ code: "failed", message: "Could not read projects." }),
        ),
      );
      const coordinated = snapshot.projects.filter(
        (project) =>
          project.deletedAt === null &&
          (coordinatorRoleOf(project).active || inDoubtHandover(project, inDoubt, target)),
      );
      const byId = new Map(coordinated.map((project) => [project.id, project]));
      const everyProject = new Map(snapshot.projects.map((project) => [project.id, project]));

      // The target's grant per linked project: its fleet row for that project says
      // whether the grant leaves it out. The probe behind it is cached briefly.
      const projectFacts: Array<AwayProjectFact> = [];
      const factFor = Effect.fn("AwayPlanner.projectFact")(function* (
        project: (typeof coordinated)[number],
        isCoordinated: boolean,
      ) {
        const personal = isPersonalAssistantProject(project.workspaceSettings);
        const member = project.workspaceSettings?.logicalProject?.members.find(
          (entry) => entry.environmentId === target.environmentId,
        );
        let notInGrant = false;
        if (!personal && member !== undefined && usable) {
          const row = yield* remote.listMachines({ projectId: project.id, probe: true }).pipe(
            Effect.map((result) =>
              result.machines.find((entry) => entry.environmentId === target.environmentId),
            ),
            Effect.orElseSucceed(() => undefined),
          );
          notInGrant = row?.status === "project_not_in_grant";
        }
        return {
          id: project.id,
          title: project.workspaceSettings?.logicalProject?.title ?? project.title,
          personal,
          targetProjectId: member?.projectId ?? null,
          notInGrant,
          ...(isCoordinated ? {} : { coordinated: false }),
          ...(inDoubtHandover(project, inDoubt, target) ? { inDoubt: true } : {}),
        } satisfies AwayProjectFact;
      });
      for (const project of coordinated) projectFacts.push(yield* factFor(project, true));

      const shells = yield* projections
        .getShellSnapshot({ unsettledOnly: false })
        .pipe(
          Effect.mapError(
            () => new AwayError({ code: "failed", message: "Could not read threads." }),
          ),
        );
      const candidates: Array<{ shell: OrchestrationV2ThreadShell; queued: boolean }> = [];
      for (const shell of shells.threads) {
        const candidate = isAwayCandidate(shell, self);
        if (candidate === null) continue;
        const project = everyProject.get(shell.projectId);
        // A coordinator moves with its project, never as a thread.
        if (project !== undefined && isProjectCoordinatorThreadId(shell.id, project)) continue;
        candidates.push({ shell, queued: candidate.queued });
      }

      const checks = new Map<ThreadId, AwayThreadCheck>();
      const movable = candidates.filter(
        ({ shell }) =>
          !isPersonalAssistantProject(everyProject.get(shell.projectId)?.workspaceSettings),
      );
      if (usable) {
        for (let start = 0; start < movable.length; start += PREFLIGHT_BATCH) {
          const batch = movable.slice(start, start + PREFLIGHT_BATCH).map(({ shell }) => shell.id);
          const answer = yield* handoff
            .preflight({ destinationEnvironmentId: target.environmentId, threadIds: batch })
            .pipe(Effect.result);
          if (answer._tag === "Failure") {
            for (const id of batch)
              checks.set(id, { kind: "error", message: answer.failure.message });
            continue;
          }
          for (const result of answer.success) {
            checks.set(result.threadId, {
              kind: "checked",
              ok: result.ok,
              failures: result.failures,
              resume: result.resume,
            });
          }
        }
      }

      const threads: Array<AwayThreadFact> = candidates.map(({ shell, queued }) => ({
        id: shell.id,
        title: shell.title,
        projectId: shell.projectId,
        personal: isPersonalAssistantProject(everyProject.get(shell.projectId)?.workspaceSettings),
        queued,
        check: checks.get(shell.id) ?? { kind: "skipped" },
      }));

      const tasks = yield* scheduled
        .list()
        .pipe(
          Effect.mapError(
            () => new AwayError({ code: "failed", message: "Could not read routines." }),
          ),
        );
      // Every enabled routine here, of any live project: one whose coordinator runs
      // elsewhere still runs on this machine and still needs its project on the target.
      const enabled = tasks.tasks.filter((task) => {
        const project = everyProject.get(task.projectId);
        return task.enabled && project !== undefined && project.deletedAt === null;
      });
      for (const projectId of new Set(enabled.map((task) => task.projectId))) {
        if (byId.has(projectId)) continue;
        projectFacts.push(yield* factFor(everyProject.get(projectId)!, false));
      }
      const routines: Array<AwayRoutineFact> = enabled.map((task) => ({
        id: task.id,
        title: task.title,
        projectId: task.projectId,
        webhook: isWebhookRoutine(task),
      }));

      const grantRead = usable ? yield* access.targetGrant(target.environmentId) : null;

      const now = yield* Clock.currentTimeMillis;
      return buildAwayPlan({
        self: { environmentId: self, label: handoff.machineLabel },
        target,
        coordinatorScope: input.coordinatorScope ?? "live",
        projects: projectFacts,
        threads,
        routines,
        targetGrant: grantRead?.kind === "grant" ? grantRead.grant : null,
        targetGrantProblem:
          grantRead === null || grantRead.kind === "grant" ? null : grantRead.kind,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      });
    });

  return AwayPlanner.of({ preflight });
});

/** Needs HandoffMode, ProjectService, the projection store, routines, AwayAccess and RemoteWorkers. */
export const layer = Layer.effect(AwayPlanner, make);
