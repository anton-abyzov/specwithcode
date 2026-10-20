import type { EnvironmentId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import {
  PROJECT_PLAN_EVIDENCE_LIMIT,
  PROJECT_PLAN_MACHINES_LIMIT,
  PROJECT_PLAN_RELEASED_CLAIMS_LIMIT,
  PROJECT_PLAN_TASK_LIMIT,
  type ProjectNativePlan,
  type ProjectPlanActor,
  type ProjectPlanClaim,
  type ProjectPlanCriterion,
  type ProjectPlanEvidence,
  type ProjectPlanMachine,
  type ProjectPlanStamp,
  type ProjectPlanTask,
  type ProjectPlanTaskDefinition,
} from "../../../../../packages/contracts/src/projectPlan.ts";
import { definitionOf, equalDefinition, ownerKey, withOwnerMachine } from "./PlanDocument.ts";

const CRITERIA_LIMIT = 128;

/** One machine's copy of a linked project's native plan. */
export interface PlanCopy {
  readonly plan: ProjectNativePlan;
  readonly environmentId: EnvironmentId;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        )
      : value;
/** JSON with sorted keys, so equal plans compare equal whatever their key order. */
export const stableJson = (value: unknown): string => JSON.stringify(sortKeys(value));

const claimOf = (owner: ProjectPlanActor, claimedAt: string | undefined): ProjectPlanClaim =>
  claimedAt === undefined ? { owner } : { owner, claimedAt };
const claimKey = (claim: ProjectPlanClaim, home: EnvironmentId) =>
  `${ownerKey(claim.owner, home)}|${claim.claimedAt ?? ""}`;
const claimTime = (claim: ProjectPlanClaim): number => {
  const time = claim.claimedAt === undefined ? Number.NaN : Date.parse(claim.claimedAt);
  // A claim from before claim times were recorded is the oldest.
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};
/** Earliest claim first; ties go to the user, then the smaller machine id, then the thread id. */
const compareClaims = (a: ProjectPlanClaim, b: ProjectPlanClaim, home: EnvironmentId): number => {
  const ta = claimTime(a);
  const tb = claimTime(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.owner.kind !== b.owner.kind) return a.owner.kind === "user" ? -1 : 1;
  return compareText(claimKey(a, home), claimKey(b, home));
};

const normalizeClaim = (claim: ProjectPlanClaim, home: EnvironmentId): ProjectPlanClaim => ({
  ...claim,
  owner: withOwnerMachine(claim.owner, home),
});
const normalizeTask = (task: ProjectPlanTask, home: EnvironmentId): ProjectPlanTask => {
  const { claimConflict, releasedClaims, ...rest } = task;
  return {
    ...rest,
    owner: task.owner && withOwnerMachine(task.owner, home),
    ...(claimConflict ? { claimConflict: normalizeClaim(claimConflict, home) } : {}),
    ...(releasedClaims
      ? { releasedClaims: releasedClaims.map((claim) => normalizeClaim(claim, home)) }
      : {}),
  };
};
/** Records every thread owner with its machine, so the copy can leave this machine. */
export const normalizePlan = (plan: ProjectNativePlan, home: EnvironmentId): ProjectNativePlan => ({
  ...plan,
  tasks: plan.tasks.map((task) => normalizeTask(task, home)),
});

const definitionOfPlan = (plan: ProjectNativePlan) => ({
  spec: plan.spec,
  criteria: plan.criteria,
  tasks: plan.tasks.map(definitionOf),
});
const hasDefinition = (plan: ProjectNativePlan) =>
  plan.spec.length > 0 || plan.criteria.length > 0 || plan.tasks.length > 0;
const compareStamps = (
  a: ProjectPlanStamp | undefined,
  aHome: EnvironmentId,
  b: ProjectPlanStamp | undefined,
  bHome: EnvironmentId,
): number =>
  compareText(a?.at ?? "", b?.at ?? "") ||
  compareText(a?.environmentId ?? aHome, b?.environmentId ?? bHome);
/** Last writer wins; an empty plan never replaces one that was written before stamps existed. */
const localDefinitionWins = (local: PlanCopy, peer: PlanCopy): boolean => {
  const a = local.plan;
  const b = peer.plan;
  const at = compareText(a.definitionStamp?.at ?? "", b.definitionStamp?.at ?? "");
  if (at !== 0) return at > 0;
  if (hasDefinition(a) !== hasDefinition(b)) return hasDefinition(a);
  return (
    (compareStamps(a.definitionStamp, local.environmentId, b.definitionStamp, peer.environmentId) ||
      compareText(stableJson(definitionOfPlan(a)), stableJson(definitionOfPlan(b)))) >= 0
  );
};

const mergeReleased = (
  a: readonly ProjectPlanClaim[] | undefined,
  b: readonly ProjectPlanClaim[] | undefined,
  home: EnvironmentId,
): ProjectPlanClaim[] => {
  const byKey = new Map<string, ProjectPlanClaim>();
  for (const claim of [...(a ?? []), ...(b ?? [])]) byKey.set(claimKey(claim, home), claim);
  return [...byKey.values()]
    .sort((x, y) => compareClaims(x, y, home))
    .slice(-PROJECT_PLAN_RELEASED_CLAIMS_LIMIT);
};

const betterEvidence = (a: ProjectPlanEvidence, b: ProjectPlanEvidence): ProjectPlanEvidence => {
  if ((a.finishedAt === null) !== (b.finishedAt === null)) return a.finishedAt === null ? b : a;
  const order =
    compareText(a.finishedAt ?? "", b.finishedAt ?? "") ||
    compareText(stableJson(a), stableJson(b));
  return order >= 0 ? a : b;
};
/** Every receipt survives by command id; over the limit the oldest finished ones go first. */
const mergeEvidence = (
  a: readonly ProjectPlanEvidence[],
  b: readonly ProjectPlanEvidence[],
): ProjectPlanEvidence[] => {
  const byId = new Map<string, ProjectPlanEvidence>();
  for (const evidence of [...a, ...b]) {
    const previous = byId.get(evidence.commandId);
    byId.set(evidence.commandId, previous ? betterEvidence(previous, evidence) : evidence);
  }
  const merged = [...byId.values()].sort(
    (x, y) => compareText(x.startedAt, y.startedAt) || compareText(x.commandId, y.commandId),
  );
  while (merged.length > PROJECT_PLAN_EVIDENCE_LIMIT) {
    const oldestFinished = merged.findIndex((evidence) => evidence.outcome !== "unknown");
    merged.splice(oldestFinished === -1 ? 0 : oldestFinished, 1);
  }
  return merged;
};

const mergeTask = (
  definition: ProjectPlanTaskDefinition,
  local: ProjectPlanTask,
  peer: ProjectPlanTask,
  localHome: EnvironmentId,
  peerHome: EnvironmentId,
): ProjectPlanTask => {
  // Owners are normalized, so keys no longer depend on which copy they came from.
  const home = localHome;
  const releasedClaims = mergeReleased(local.releasedClaims, peer.releasedClaims, home);
  const released = new Set(releasedClaims.map((claim) => claimKey(claim, home)));
  const live = (task: ProjectPlanTask) => {
    if (!task.owner) return null;
    const claim = claimOf(task.owner, task.claimedAt);
    return released.has(claimKey(claim, home)) ? null : claim;
  };
  const localClaim = live(local);
  const peerClaim = live(peer);
  let owner = localClaim ?? peerClaim;
  let loser: ProjectPlanClaim | null = null;
  let stateFrom: "local" | "peer" | null = null;
  if (localClaim && peerClaim) {
    const localFirst = compareClaims(localClaim, peerClaim, home) <= 0;
    owner = localFirst ? localClaim : peerClaim;
    if (ownerKey(localClaim.owner, home) !== ownerKey(peerClaim.owner, home)) {
      // Claimed on both machines while they could not reach each other: the earliest claim
      // keeps the task with its state, and the other is kept as a visible conflict.
      loser = localFirst ? peerClaim : localClaim;
      stateFrom = localFirst ? "local" : "peer";
    }
  }
  const conflict = owner
    ? [loser, local.claimConflict ?? null, peer.claimConflict ?? null]
        .filter(
          (claim): claim is ProjectPlanClaim =>
            claim !== null &&
            !released.has(claimKey(claim, home)) &&
            ownerKey(claim.owner, home) !== ownerKey(owner!.owner, home),
        )
        .sort((a, b) => compareClaims(a, b, home))[0]
    : undefined;
  stateFrom ??=
    (compareStamps(local.stateStamp, localHome, peer.stateStamp, peerHome) ||
      compareText(
        stableJson({ status: local.status, note: local.note }),
        stableJson({ status: peer.status, note: peer.note }),
      )) >= 0
      ? "local"
      : "peer";
  const state = stateFrom === "local" ? local : peer;
  return {
    ...definition,
    owner: owner?.owner ?? null,
    // Verification of another definition no longer holds.
    status:
      state.status === "verified" && !equalDefinition(state, definition)
        ? "reported_done"
        : state.status,
    note: state.note,
    evidence: mergeEvidence(local.evidence, peer.evidence),
    ...(owner?.claimedAt !== undefined ? { claimedAt: owner.claimedAt } : {}),
    ...(conflict ? { claimConflict: conflict } : {}),
    ...(releasedClaims.length > 0 ? { releasedClaims } : {}),
    ...(state.stateStamp ? { stateStamp: state.stateStamp } : {}),
  };
};

const mergeMachines = (
  local: readonly ProjectPlanMachine[] | undefined,
  peer: readonly ProjectPlanMachine[] | undefined,
  peerMachine: ProjectPlanMachine,
  home: EnvironmentId,
): ProjectPlanMachine[] => {
  const byId = new Map<string, ProjectPlanMachine>();
  for (const machine of [...(peer ?? []), ...(local ?? [])])
    byId.set(machine.environmentId, machine);
  const label =
    peerMachine.label.trim() || byId.get(peerMachine.environmentId)?.label || peerMachine.label;
  byId.delete(peerMachine.environmentId);
  byId.delete(home);
  return [
    { environmentId: peerMachine.environmentId, label },
    ...[...byId.values()]
      .sort((a, b) => compareText(a.environmentId, b.environmentId))
      .slice(0, PROJECT_PLAN_MACHINES_LIMIT - 1),
  ].sort((a, b) => compareText(a.environmentId, b.environmentId));
};

/**
 * Merges a linked machine's copy into this machine's copy. The result is the same whichever
 * copy merges first, and merging it again changes nothing, so a pass that fails half way
 * converges on the next one.
 */
export function mergeNativePlans(
  localCopy: PlanCopy,
  peerCopy: PlanCopy,
  peerLabel: string,
): { readonly plan: ProjectNativePlan; readonly changed: boolean } {
  const local = { ...localCopy, plan: normalizePlan(localCopy.plan, localCopy.environmentId) };
  const peer = { ...peerCopy, plan: normalizePlan(peerCopy.plan, peerCopy.environmentId) };
  const localWins = localDefinitionWins(local, peer);
  const winner = localWins ? local.plan : peer.plan;
  const loser = localWins ? peer.plan : local.plan;
  const criteria: ProjectPlanCriterion[] = [...winner.criteria];
  const definitions: ProjectPlanTaskDefinition[] = winner.tasks.map(definitionOf);
  const winnerIds = new Set(winner.tasks.map((task) => task.id));
  // A task removed on one machine while claimed or verified on the other keeps that work.
  for (const task of loser.tasks) {
    if (winnerIds.has(task.id) || (!task.owner && task.evidence.length === 0)) continue;
    const missing = task.criterionIds.filter((id) => !criteria.some((c) => c.id === id));
    const needed = loser.criteria.filter((criterion) => missing.includes(criterion.id));
    if (
      definitions.length >= PROJECT_PLAN_TASK_LIMIT ||
      needed.length !== missing.length ||
      criteria.length + needed.length > CRITERIA_LIMIT
    )
      continue;
    criteria.push(...needed);
    definitions.push(definitionOf(task));
  }
  const localTasks = new Map(local.plan.tasks.map((task) => [task.id, task]));
  const peerTasks = new Map(peer.plan.tasks.map((task) => [task.id, task]));
  const tasks = definitions.map((definition): ProjectPlanTask => {
    const a = localTasks.get(definition.id);
    const b = peerTasks.get(definition.id);
    if (a && b) return mergeTask(definition, a, b, local.environmentId, peer.environmentId);
    return { ...(a ?? b)!, ...definition };
  });
  const definition = { spec: winner.spec, criteria, tasks };
  const definitionChanged =
    stableJson(definitionOfPlan({ ...definition, contentRevision: 0 })) !==
    stableJson(definitionOfPlan(local.plan));
  const plan: ProjectNativePlan = {
    ...definition,
    contentRevision: local.plan.contentRevision + (definitionChanged ? 1 : 0),
    ...(winner.definitionStamp ? { definitionStamp: winner.definitionStamp } : {}),
    machines: mergeMachines(
      local.plan.machines,
      peer.plan.machines,
      {
        environmentId: peer.environmentId,
        label: peerLabel,
      },
      local.environmentId,
    ),
  };
  return { plan, changed: stableJson(plan) !== stableJson(localCopy.plan) };
}
