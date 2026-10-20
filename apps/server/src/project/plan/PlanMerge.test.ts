import { CommandId, EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  PROJECT_PLAN_EVIDENCE_LIMIT,
  type ProjectNativePlan,
  type ProjectPlanActor,
  type ProjectPlanEvidence,
  type ProjectPlanTask,
} from "../../../../../packages/contracts/src/projectPlan.ts";
import { mergeNativePlans, normalizePlan, stableJson, type PlanCopy } from "./PlanMerge.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const two = (value: number) => String(value).padStart(2, "0");
const at = (second: number) =>
  `2026-01-01T00:${two(Math.floor(second / 60))}:${two(second % 60)}.000Z`;
const thread = (id: string, environmentId?: EnvironmentId): ProjectPlanActor => ({
  kind: "thread",
  threadId: ThreadId.make(id),
  ...(environmentId ? { environmentId } : {}),
});
const task = (id: string, extra: Partial<ProjectPlanTask> = {}): ProjectPlanTask => ({
  id,
  title: `Task ${id}`,
  criterionIds: ["AC-1"],
  verification: null,
  owner: null,
  status: "planned",
  note: "",
  evidence: [],
  ...extra,
});
const base = (): ProjectNativePlan => ({
  spec: "Ship it.",
  criteria: [{ id: "AC-1", text: "It works." }],
  tasks: [task("T-1"), task("T-2")],
  contentRevision: 1,
  definitionStamp: { at: at(0), environmentId: envA },
});
const withTask = (
  plan: ProjectNativePlan,
  id: string,
  change: (task: ProjectPlanTask) => ProjectPlanTask,
): ProjectNativePlan => ({
  ...plan,
  tasks: plan.tasks.map((item) => (item.id === id ? change(item) : item)),
});
const claimed = (
  plan: ProjectNativePlan,
  id: string,
  owner: ProjectPlanActor,
  second: number,
  environmentId: EnvironmentId,
  note = "",
) =>
  withTask(plan, id, (item) => ({
    ...item,
    owner,
    claimedAt: at(second),
    status: "in_progress",
    note,
    stateStamp: { at: at(second), environmentId },
  }));
const evidence = (
  id: string,
  second: number,
  outcome: ProjectPlanEvidence["outcome"] = "passed",
): ProjectPlanEvidence => ({
  commandId: CommandId.make(id),
  contentRevision: 1,
  taskStateSha256: "0".repeat(64),
  taskId: "T-1",
  startedAt: at(second),
  finishedAt: outcome === "unknown" ? null : at(second + 1),
  outcome,
  command: { executable: "node", args: ["-v"], timeoutMs: 1_000 },
  workspaceRoot: "/work",
  exitCode: outcome === "unknown" ? null : 0,
  stdout: "",
  stderr: "",
  outputSha256: "",
  truncated: false,
});
const a = (plan: ProjectNativePlan): PlanCopy => ({ plan, environmentId: envA });
const b = (plan: ProjectNativePlan): PlanCopy => ({ plan, environmentId: envB });
/** One pass of the web driver: export both copies first, then merge each into the other. */
const sync = (left: ProjectNativePlan, right: ProjectNativePlan) => ({
  a: mergeNativePlans(a(left), b(right), "Mac B").plan,
  b: mergeNativePlans(b(right), a(left), "Mac A").plan,
});
/** What both machines must agree on; revision counters and machine labels stay local. */
const shared = (plan: ProjectNativePlan) => {
  const { contentRevision: _revision, machines: _machines, ...rest } = plan;
  return stableJson(rest);
};
const first = (plan: ProjectNativePlan) => plan.tasks[0]!;

describe("mergeNativePlans", () => {
  it("makes a claim on one machine visible on the other with its machine", () => {
    const left = claimed(base(), "T-1", thread("x", envA), 1, envA);
    const { a: mergedA, b: mergedB } = sync(left, base());
    expect(first(mergedB).owner).toEqual(thread("x", envA));
    expect(first(mergedB).claimedAt).toBe(at(1));
    expect(first(mergedB).status).toBe("in_progress");
    expect(shared(mergedA)).toBe(shared(mergedB));
    expect(mergedB.machines).toEqual([{ environmentId: envA, label: "Mac A" }]);
  });

  it("keeps the earliest of two claims made during a partition and records the other", () => {
    const left = claimed(base(), "T-1", thread("x", envA), 5, envA, "x started");
    const right = claimed(base(), "T-1", thread("y", envB), 3, envB, "y started");
    const { a: mergedA, b: mergedB } = sync(left, right);
    for (const plan of [mergedA, mergedB]) {
      expect(first(plan).owner).toEqual(thread("y", envB));
      expect(first(plan).claimedAt).toBe(at(3));
      expect(first(plan).note).toBe("y started");
      expect(first(plan).claimConflict).toEqual({ owner: thread("x", envA), claimedAt: at(5) });
    }
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("keeps the winner's later state even when the losing machine changed last", () => {
    const left = claimed(base(), "T-1", thread("x", envA), 1, envA, "x started");
    const right = withTask(claimed(base(), "T-1", thread("y", envB), 2, envB), "T-1", (item) => ({
      ...item,
      status: "reported_done",
      note: "y finished",
      stateStamp: { at: at(9), environmentId: envB },
    }));
    const { a: mergedA, b: mergedB } = sync(left, right);
    expect(first(mergedA).owner).toEqual(thread("x", envA));
    expect(first(mergedA).status).toBe("in_progress");
    expect(first(mergedA).note).toBe("x started");
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("breaks a tie on claim time by the smaller machine id", () => {
    const left = claimed(base(), "T-1", thread("x", envA), 4, envA);
    const right = claimed(base(), "T-1", thread("y", envB), 4, envB);
    const { a: mergedA, b: mergedB } = sync(left, right);
    expect(first(mergedA).owner).toEqual(thread("x", envA));
    expect(first(mergedB).owner).toEqual(thread("x", envA));
    expect(first(mergedB).claimConflict?.owner).toEqual(thread("y", envB));
  });

  it("does not restore a released claim from a copy that has not seen the release", () => {
    const both = claimed(base(), "T-1", thread("x", envA), 1, envA);
    const released = withTask(both, "T-1", (item) => {
      const { claimedAt: _claimedAt, ...rest } = item;
      return {
        ...rest,
        owner: null,
        releasedClaims: [{ owner: thread("x", envA), claimedAt: at(1) }],
        stateStamp: { at: at(2), environmentId: envB },
      };
    });
    const { a: mergedA, b: mergedB } = sync(both, released);
    expect(first(mergedA).owner).toBeNull();
    expect(first(mergedA).claimedAt).toBeUndefined();
    expect(first(mergedB).owner).toBeNull();
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("keeps a new claim made after a release that the other copy has not seen", () => {
    const old = claimed(base(), "T-1", thread("x", envA), 1, envA);
    const reclaimed = withTask(
      claimed(base(), "T-1", thread("x", envA), 3, envA),
      "T-1",
      (item) => ({
        ...item,
        releasedClaims: [{ owner: thread("x", envA), claimedAt: at(1) }],
      }),
    );
    const { a: mergedA, b: mergedB } = sync(reclaimed, old);
    expect(first(mergedB).owner).toEqual(thread("x", envA));
    expect(first(mergedB).claimedAt).toBe(at(3));
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("clears a conflict once the user releases both claims", () => {
    const left = claimed(base(), "T-1", thread("x", envA), 5, envA);
    const right = claimed(base(), "T-1", thread("y", envB), 3, envB);
    const firstPass = sync(left, right);
    const releasedOnB = withTask(firstPass.b, "T-1", (item) => {
      const { claimedAt: _claimedAt, claimConflict: _conflict, ...rest } = item;
      return {
        ...rest,
        owner: null,
        releasedClaims: [item.claimConflict!, { owner: item.owner!, claimedAt: item.claimedAt! }],
        stateStamp: { at: at(10), environmentId: envB },
      };
    });
    const { a: mergedA, b: mergedB } = sync(firstPass.a, releasedOnB);
    expect(first(mergedA).owner).toBeNull();
    expect(first(mergedA).claimConflict).toBeUndefined();
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("unions evidence by command id, prefers finished receipts and keeps in-flight ones", () => {
    const left = withTask(base(), "T-1", (item) => ({
      ...item,
      evidence: [
        ...Array.from({ length: 14 }, (_, i) => evidence(`a-${i}`, i)),
        evidence("shared", 30, "unknown"),
      ],
    }));
    const right = withTask(base(), "T-1", (item) => ({
      ...item,
      evidence: [
        ...Array.from({ length: 8 }, (_, i) => evidence(`b-${i}`, 40 + i)),
        evidence("shared", 30, "passed"),
        evidence("running", 50, "unknown"),
      ],
    }));
    const { a: mergedA, b: mergedB } = sync(left, right);
    const merged = first(mergedA).evidence;
    expect(merged).toHaveLength(PROJECT_PLAN_EVIDENCE_LIMIT);
    expect(merged.find((e) => e.commandId === "shared")?.outcome).toBe("passed");
    expect(merged.some((e) => e.commandId === "running")).toBe(true);
    expect(merged.some((e) => e.commandId === "a-0")).toBe(false);
    const started = merged.map((e) => e.startedAt);
    expect(started).toEqual(started.toSorted());
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("takes the latest definition and keeps a task removed there but claimed elsewhere", () => {
    const edited: ProjectNativePlan = {
      ...base(),
      criteria: [{ id: "AC-1", text: "It works." }],
      tasks: [{ ...task("T-1"), title: "Renamed" }],
      contentRevision: 2,
      definitionStamp: { at: at(8), environmentId: envA },
    };
    const right = withTask(
      { ...base(), criteria: [...base().criteria, { id: "AC-2", text: "More." }] },
      "T-2",
      (item) => ({
        ...claimed(base(), "T-2", thread("y", envB), 4, envB).tasks[1]!,
        criterionIds: ["AC-2"],
        title: item.title,
      }),
    );
    const { a: mergedA, b: mergedB } = sync(edited, right);
    expect(mergedA.tasks.map((t) => t.title)).toEqual(["Renamed", "Task T-2"]);
    expect(mergedA.tasks[1]!.owner).toEqual(thread("y", envB));
    expect(mergedA.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    expect(mergedA.contentRevision).toBe(3);
    expect(mergedB.contentRevision).toBe(2);
    expect(mergedA.definitionStamp).toEqual({ at: at(8), environmentId: envA });
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("drops a removed task that nobody claimed or verified", () => {
    const edited: ProjectNativePlan = {
      ...base(),
      tasks: [task("T-1")],
      definitionStamp: { at: at(8), environmentId: envB },
    };
    const { a: mergedA, b: mergedB } = sync(base(), edited);
    expect(mergedA.tasks.map((t) => t.id)).toEqual(["T-1"]);
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("demotes a verification made against a definition that changed elsewhere", () => {
    const verified = withTask(base(), "T-1", (item) => ({
      ...item,
      status: "verified",
      stateStamp: { at: at(9), environmentId: envA },
    }));
    const edited: ProjectNativePlan = {
      ...base(),
      tasks: [{ ...task("T-1"), title: "Changed" }, task("T-2")],
      definitionStamp: { at: at(7), environmentId: envB },
    };
    const { a: mergedA, b: mergedB } = sync(verified, edited);
    expect(first(mergedA).title).toBe("Changed");
    expect(first(mergedA).status).toBe("reported_done");
    expect(shared(mergedA)).toBe(shared(mergedB));
  });

  it("does not let an empty copy replace a plan written before stamps existed", () => {
    const { definitionStamp: _stamp, ...legacy } = base();
    const empty: ProjectNativePlan = { spec: "", criteria: [], tasks: [], contentRevision: 0 };
    const { a: mergedA, b: mergedB } = sync(legacy, empty);
    expect(mergedA.tasks).toHaveLength(2);
    expect(mergedB.tasks).toHaveLength(2);
  });

  it("assigns legacy thread owners to the machine that stored them", () => {
    const legacy = withTask(base(), "T-1", (item) => ({
      ...item,
      owner: thread("x"),
      status: "in_progress",
    }));
    const { a: mergedA, b: mergedB } = sync(legacy, base());
    expect(first(mergedA).owner).toEqual(thread("x", envA));
    expect(first(mergedB).owner).toEqual(thread("x", envA));
    expect(normalizePlan(legacy, envA).tasks[0]!.owner).toEqual(thread("x", envA));
  });

  it("is idempotent", () => {
    const left = claimed(base(), "T-1", thread("x", envA), 5, envA);
    const right = claimed(base(), "T-1", thread("y", envB), 3, envB);
    const once = sync(left, right);
    const again = mergeNativePlans(a(once.a), b(once.b), "Mac B");
    expect(again.changed).toBe(false);
    expect(mergeNativePlans(a(once.a), b(right), "Mac B").changed).toBe(false);
    expect(mergeNativePlans(b(once.b), a(once.a), "Mac A").changed).toBe(false);
  });

  it("converges when one merge of a pass failed", () => {
    const left = withTask(claimed(base(), "T-1", thread("x", envA), 5, envA), "T-2", (item) => ({
      ...item,
      evidence: [evidence("a-1", 1)],
    }));
    const right = claimed(
      {
        ...base(),
        tasks: [task("T-1"), task("T-2"), task("T-3")],
        definitionStamp: { at: at(6), environmentId: envB },
      },
      "T-1",
      thread("y", envB),
      3,
      envB,
    );
    const together = sync(left, right);
    // First pass: both copies exported, the merge into A applied, the merge into B failed.
    const halfA = mergeNativePlans(a(left), b(right), "Mac B").plan;
    const next = sync(halfA, right);
    expect(shared(next.a)).toBe(shared(together.a));
    expect(shared(next.b)).toBe(shared(together.b));
    expect(shared(next.a)).toBe(shared(next.b));
    // The reverse: only B applied.
    const halfB = mergeNativePlans(b(right), a(left), "Mac A").plan;
    const reverse = sync(left, halfB);
    expect(shared(reverse.a)).toBe(shared(together.a));
    expect(shared(reverse.b)).toBe(shared(together.b));
  });

  it("reports no change and keeps the revision for an identical copy", () => {
    const plan = { ...base(), machines: [{ environmentId: envB, label: "Mac B" }] };
    const result = mergeNativePlans(a(plan), b(base()), "Mac B");
    expect(result.changed).toBe(false);
    expect(result.plan.contentRevision).toBe(1);
  });
});
