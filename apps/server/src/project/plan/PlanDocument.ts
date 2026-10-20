import * as Schema from "effect/Schema";
import type { EnvironmentId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import {
  PROJECT_PLAN_BYTES,
  PROJECT_PLAN_SPEC_BYTES,
  ProjectPlanAuthority,
  ProjectNativePlan,
  type ProjectPlanActor,
  type ProjectPlanDefinition,
  type ProjectPlanTaskDefinition,
} from "../../../../../packages/contracts/src/projectPlan.ts";

export const PlanDocument = Schema.Struct({
  authority: ProjectPlanAuthority,
  native: Schema.NullOr(ProjectNativePlan),
});
export type PlanDocument = typeof PlanDocument.Type;
export const emptyNative = (): ProjectNativePlan => ({
  spec: "",
  criteria: [],
  tasks: [],
  contentRevision: 0,
});
export const emptyDocument = (): PlanDocument => ({
  authority: { kind: "native" },
  native: emptyNative(),
});
/** A thread owner without a machine belongs to the machine that stores the plan (`home`). */
export const ownerKey = (actor: ProjectPlanActor, home: EnvironmentId): string =>
  actor.kind === "user" ? "user" : `thread:${actor.environmentId ?? home}:${actor.threadId}`;
export const sameOwner = (
  a: ProjectPlanActor | null,
  b: ProjectPlanActor,
  home: EnvironmentId,
): boolean => a !== null && ownerKey(a, home) === ownerKey(b, home);
export const withOwnerMachine = (actor: ProjectPlanActor, home: EnvironmentId): ProjectPlanActor =>
  actor.kind === "thread" && actor.environmentId === undefined
    ? { ...actor, environmentId: home }
    : actor;
/** The machine of a thread owner on another machine than `home`, else null. */
export const foreignMachine = (
  actor: ProjectPlanActor | null,
  home: EnvironmentId,
): EnvironmentId | null =>
  actor?.kind === "thread" && actor.environmentId !== undefined && actor.environmentId !== home
    ? actor.environmentId
    : null;
export const definitionOf = (task: ProjectPlanTaskDefinition): ProjectPlanTaskDefinition => ({
  id: task.id,
  title: task.title,
  criterionIds: task.criterionIds,
  verification: task.verification,
});
export const equalDefinition = (
  a: ProjectPlanTaskDefinition,
  b: ProjectPlanTaskDefinition,
): boolean => JSON.stringify(definitionOf(a)) === JSON.stringify(definitionOf(b));
export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;
export function validDefinition(value: ProjectPlanDefinition): boolean {
  const criteria = new Set(value.criteria.map((c) => c.id));
  return (
    byteLength(value.spec) <= PROJECT_PLAN_SPEC_BYTES &&
    criteria.size === value.criteria.length &&
    new Set(value.tasks.map((t) => t.id)).size === value.tasks.length &&
    value.criteria.every((c) => c.text.trim().length > 0) &&
    value.tasks.every(
      (t) =>
        t.title.trim().length > 0 &&
        new Set(t.criterionIds).size === t.criterionIds.length &&
        t.criterionIds.every((id) => criteria.has(id)) &&
        (!t.verification ||
          (!t.verification.executable.includes("\0") &&
            t.verification.args.every((arg) => !arg.includes("\0")))),
    )
  );
}
export const withinDocumentLimit = (value: PlanDocument): boolean => {
  // Reserve worst-case JSON escaping for each bounded in-flight output, so later edits
  // cannot consume the room needed to finish an already admitted verification.
  const pending =
    value.native?.tasks.reduce(
      (sum, task) => sum + task.evidence.filter((e) => e.outcome === "unknown").length,
      0,
    ) ?? 0;
  return byteLength(JSON.stringify(value)) + pending * 100_000 <= PROJECT_PLAN_BYTES;
};
