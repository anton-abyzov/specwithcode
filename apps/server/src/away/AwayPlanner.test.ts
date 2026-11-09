import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";

import { WORKTREE_SET_HANDOFF_MESSAGE } from "../handoff/HandoffMoves.ts";
import {
  type AwayPlanFacts,
  type AwayProjectFact,
  type AwayThreadFact,
  buildAwayPlan,
  inDoubtHandover,
  isAwayCandidate,
} from "./AwayPlanner.ts";

const M4 = EnvironmentId.make("env-m4");
const MINI = EnvironmentId.make("env-ministorm");
const P1 = ProjectId.make("p-insta");
const P2 = ProjectId.make("p-site");
const PA = ProjectId.make("p-assistant");

const project = (overrides: Partial<AwayProjectFact> & { id: ProjectId }): AwayProjectFact => ({
  title: overrides.id,
  personal: false,
  targetProjectId: ProjectId.make(`${overrides.id}-mini`),
  notInGrant: false,
  ...overrides,
});

const thread = (
  overrides: Omit<Partial<AwayThreadFact>, "id"> & { readonly id: string },
): AwayThreadFact => ({
  title: overrides.id,
  projectId: P1,
  personal: false,
  queued: false,
  check: { kind: "checked", ok: true, failures: [], resume: true },
  ...overrides,
  id: ThreadId.make(overrides.id),
});

const facts = (overrides: Partial<AwayPlanFacts> = {}): AwayPlanFacts => ({
  self: { environmentId: M4, label: "M4" },
  target: { environmentId: MINI, label: "Ministorm", status: "ready" },
  coordinatorScope: "live",
  projects: [project({ id: P1 })],
  threads: [],
  routines: [],
  targetGrant: { routines: true, projects: { kind: "linked" }, revoked: false },
  checkedAt: "2026-11-09T10:00:00.000Z",
  ...overrides,
});

const item = (plan: ReturnType<typeof buildAwayPlan>, kind: string, id: string) =>
  plan.items.find((entry) => entry.kind === kind && entry.id === id);

describe("buildAwayPlan threads", () => {
  it("moves a thread whose checks pass, running or queued", () => {
    const plan = buildAwayPlan(
      facts({
        threads: [
          thread({ id: "t-run" }),
          thread({
            id: "t-queued",
            queued: true,
            check: { kind: "checked", ok: true, failures: [], resume: false },
          }),
        ],
      }),
    );
    expect(item(plan, "thread", "t-run")).toMatchObject({
      action: "move",
      reason: "Moves to Ministorm and continues its turn.",
    });
    expect(item(plan, "thread", "t-queued")).toMatchObject({
      action: "move",
      reason: "Moves to Ministorm with its queued messages.",
    });
    expect(plan.ready).toBe(true);
    expect(plan.missingGrants).toEqual([]);
  });

  it("marks a failed thread handoff-ready with the failure text and lists what is missing", () => {
    const plan = buildAwayPlan(
      facts({
        threads: [
          thread({
            id: "t-env",
            check: {
              kind: "checked",
              ok: false,
              failures: [{ check: "ignored-files", message: "Ministorm: no .env.local" }],
              resume: false,
            },
          }),
          thread({
            id: "t-provider",
            check: {
              kind: "checked",
              ok: false,
              failures: [{ check: "provider", message: "Ministorm: Codex is not signed in" }],
              resume: false,
            },
          }),
        ],
      }),
    );
    expect(item(plan, "thread", "t-env")).toMatchObject({
      action: "handoff-ready",
      reason: "Ministorm: no .env.local",
    });
    expect(plan.missingGrants.map((gap) => gap.kind).toSorted()).toEqual([
      "provider",
      "secret-file",
    ]);
    expect(plan.missingGrants.every((gap) => gap.machineEnvironmentId === MINI)).toBe(true);
    expect(plan.ready).toBe(false);
  });

  it("keeps worktree sets and the personal assistant here", () => {
    const plan = buildAwayPlan(
      facts({
        projects: [project({ id: P1 }), project({ id: PA, personal: true })],
        threads: [
          thread({
            id: "t-set",
            check: {
              kind: "checked",
              ok: false,
              failures: [
                { check: "checkpoint", message: WORKTREE_SET_HANDOFF_MESSAGE.slice(0, 500) },
              ],
              resume: false,
            },
          }),
          thread({ id: "t-pa", projectId: PA, personal: true, check: { kind: "skipped" } }),
        ],
      }),
    );
    expect(item(plan, "thread", "t-set")?.action).toBe("stay");
    expect(item(plan, "thread", "t-pa")?.action).toBe("stay");
    // A thread that stays by design is no missing grant.
    expect(plan.missingGrants).toEqual([]);
  });

  it("marks every thread handoff-ready when the preflight call failed", () => {
    const plan = buildAwayPlan(
      facts({
        threads: [
          thread({ id: "t1", check: { kind: "error", message: "Ministorm did not answer." } }),
        ],
      }),
    );
    expect(item(plan, "thread", "t1")).toMatchObject({
      action: "handoff-ready",
      reason: "Ministorm did not answer.",
    });
  });
});

describe("buildAwayPlan target status", () => {
  it("asks this machine to allow work when the target has no grant for it", () => {
    const plan = buildAwayPlan(
      facts({
        target: { environmentId: MINI, label: "Ministorm", status: "needs_grant" },
        threads: [thread({ id: "t1", check: { kind: "skipped" } })],
      }),
    );
    expect(plan.missingGrants).toEqual([
      expect.objectContaining({ kind: "work-grant", machineEnvironmentId: M4 }),
    ]);
    expect(item(plan, "thread", "t1")?.action).toBe("handoff-ready");
    expect(plan.ready).toBe(false);
  });

  it("is not ready while the target is unreachable, with nothing to request", () => {
    const plan = buildAwayPlan(
      facts({
        target: { environmentId: MINI, label: "Ministorm", status: "unreachable" },
        threads: [thread({ id: "t1", check: { kind: "skipped" } })],
      }),
    );
    expect(plan.missingGrants).toEqual([]);
    expect(plan.ready).toBe(false);
    expect(item(plan, "thread", "t1")?.reason).toContain("did not answer");
  });
});

describe("buildAwayPlan routines", () => {
  it("moves routines, pauses webhook ones, and asks for routines access once per project", () => {
    const plan = buildAwayPlan(
      facts({
        routines: [
          { id: "r-insta", title: "Instagram post", projectId: P1, webhook: false },
          { id: "r-digest", title: "Digest", projectId: P1, webhook: false },
          { id: "r-hook", title: "Deploy hook", projectId: P1, webhook: true },
        ],
        targetGrant: { routines: false, projects: { kind: "linked" }, revoked: false },
      }),
    );
    expect(item(plan, "routine", "r-insta")).toMatchObject({ action: "move" });
    expect(item(plan, "routine", "r-hook")).toMatchObject({
      action: "pause",
      reason: expect.stringContaining("URL belongs to this machine"),
    });
    const routineGaps = plan.missingGrants.filter((gap) => gap.kind === "routines");
    expect(routineGaps).toHaveLength(1);
    expect(routineGaps[0]).toMatchObject({ machineEnvironmentId: MINI, projectId: P1 });
    expect(plan.ready).toBe(false);
  });

  it("does not guess when the target could not say what its grant allows", () => {
    const plan = buildAwayPlan(
      facts({
        routines: [{ id: "r1", title: "R", projectId: P1, webhook: false }],
        targetGrant: null,
      }),
    );
    expect(plan.missingGrants).toEqual([]);
  });

  it("keeps routines of unlinked projects and of the personal assistant here", () => {
    const plan = buildAwayPlan(
      facts({
        projects: [project({ id: P2, targetProjectId: null }), project({ id: PA, personal: true })],
        routines: [
          { id: "r-site", title: "Site", projectId: P2, webhook: false },
          { id: "r-pa", title: "Morning", projectId: PA, webhook: false },
        ],
      }),
    );
    expect(item(plan, "routine", "r-site")?.action).toBe("stay");
    expect(item(plan, "routine", "r-pa")?.action).toBe("stay");
  });
});

describe("buildAwayPlan when the target cannot say what its grant allows", () => {
  it("is not ready and asks to update an older target", () => {
    const plan = buildAwayPlan(
      facts({
        routines: [{ id: "r1", title: "R", projectId: P1, webhook: false }],
        targetGrant: null,
        targetGrantProblem: "older",
      }),
    );
    expect(plan.ready).toBe(false);
    expect(plan.missingGrants).toEqual([
      expect.objectContaining({
        kind: "work-grant",
        machineEnvironmentId: MINI,
        fix: "Update Ministorm to check access.",
      }),
    ]);
  });

  it("is not ready when the check failed", () => {
    const plan = buildAwayPlan(facts({ targetGrant: null, targetGrantProblem: "failed" }));
    expect(plan.ready).toBe(false);
    expect(plan.missingGrants[0]?.detail).toContain("could not check its access");
  });

  it("adds nothing when the target is already blocked for another reason", () => {
    const plan = buildAwayPlan(
      facts({
        target: { environmentId: MINI, label: "Ministorm", status: "unreachable" },
        targetGrant: null,
        targetGrantProblem: "failed",
      }),
    );
    expect(plan.missingGrants).toEqual([]);
  });
});

describe("buildAwayPlan routine projects", () => {
  it("names link, grant and routines steps for every enabled routine's project", () => {
    const plan = buildAwayPlan(
      facts({
        projects: [
          project({ id: P1, coordinated: false, notInGrant: true }),
          project({ id: P2, coordinated: false, targetProjectId: null }),
        ],
        routines: [
          { id: "r-insta", title: "Instagram", projectId: P1, webhook: false },
          { id: "r-site", title: "Site", projectId: P2, webhook: false },
        ],
        targetGrant: {
          routines: false,
          projects: { kind: "listed", projectIds: [] },
          revoked: false,
        },
      }),
    );
    expect(plan.items.filter((entry) => entry.kind === "coordinator")).toEqual([]);
    expect(plan.missingGrants.map((gap) => [gap.kind, gap.projectId]).toSorted()).toEqual(
      [
        ["project-link", P2],
        ["routines", P1],
        ["routines", P2],
        ["work-grant", P1],
      ].toSorted(),
    );
    expect(plan.ready).toBe(false);
  });

  it("asks nothing for a webhook routine's project", () => {
    const plan = buildAwayPlan(
      facts({
        projects: [project({ id: P2, coordinated: false, targetProjectId: null })],
        routines: [{ id: "r-hook", title: "Hook", projectId: P2, webhook: true }],
      }),
    );
    expect(plan.missingGrants).toEqual([]);
  });
});

describe("buildAwayPlan coordinators", () => {
  it("lists only live coordinators under the default scope, all of them under 'all'", () => {
    const projects = [project({ id: P1 }), project({ id: P2 })];
    const threads = [thread({ id: "t1", projectId: P1 })];
    const live = buildAwayPlan(facts({ projects, threads }));
    expect(
      live.items.filter((entry) => entry.kind === "coordinator").map((entry) => entry.id),
    ).toEqual([P1]);
    const all = buildAwayPlan(facts({ projects, threads, coordinatorScope: "all" }));
    expect(
      all.items.filter((entry) => entry.kind === "coordinator").map((entry) => entry.id),
    ).toEqual([P1, P2]);
  });

  it("names the link step for an unlinked project and the grant step for one left out", () => {
    const plan = buildAwayPlan(
      facts({
        coordinatorScope: "all",
        projects: [
          project({ id: P1, notInGrant: true }),
          project({ id: P2, targetProjectId: null }),
          project({ id: PA, personal: true }),
        ],
      }),
    );
    expect(item(plan, "coordinator", P1)?.action).toBe("move");
    expect(item(plan, "coordinator", P2)?.action).toBe("stay");
    expect(item(plan, "coordinator", PA)?.action).toBe("stay");
    expect(plan.missingGrants).toEqual([
      expect.objectContaining({ kind: "work-grant", projectId: P1, machineEnvironmentId: MINI }),
      expect.objectContaining({ kind: "project-link", projectId: P2 }),
    ]);
  });
});

describe("isAwayCandidate", () => {
  const shell = {
    status: "idle" as const,
    activityRunStatus: null,
    activeRunId: null,
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null } as never,
    heldQueuedCount: 0,
    executionMachineId: undefined,
  };

  it("takes running and queued top-level threads that run here", () => {
    expect(isAwayCandidate({ ...shell, activeRunId: "run-1" as never }, M4)).toEqual({
      queued: false,
    });
    expect(isAwayCandidate({ ...shell, heldQueuedCount: 2 }, M4)).toEqual({ queued: true });
    expect(isAwayCandidate(shell, M4)).toBeNull();
  });

  it("leaves out subagents, archived threads and threads another machine runs", () => {
    const running = { ...shell, activeRunId: "run-1" as never };
    expect(
      isAwayCandidate({ ...running, lineage: { relationshipToParent: "subagent" } as never }, M4),
    ).toBeNull();
    expect(
      isAwayCandidate({ ...running, archivedAt: "2026-11-09T10:00:00.000Z" as never }, M4),
    ).toBeNull();
    expect(isAwayCandidate({ ...running, executionMachineId: MINI as never }, M4)).toBeNull();
  });
});

describe("an in-doubt handover in the next plan (N1)", () => {
  it("lists it to finish even with no live work under the live scope", () => {
    const plan = buildAwayPlan(facts({ projects: [project({ id: P1, inDoubt: true })] }));
    expect(item(plan, "coordinator", P1)).toMatchObject({
      action: "move",
      reason:
        "Finishes the handover to Ministorm, which it has not confirmed yet. No machine coordinates it until then.",
    });
  });

  it("takes a transferred copy only when the target is its successor and the session says in doubt", () => {
    const transferred = (successor: string) => ({
      id: "p1",
      workspaceSettings: {
        coordinatorBinding: { state: "transferred", successor: { environmentId: successor } },
      },
    });
    const target = { environmentId: MINI };
    expect(inDoubtHandover(transferred(MINI), new Set(["p1"]), target)).toBe(true);
    expect(inDoubtHandover(transferred(MINI), new Set(), target)).toBe(false);
    expect(inDoubtHandover(transferred("env-other"), new Set(["p1"]), target)).toBe(false);
    expect(
      inDoubtHandover(
        { id: "p1", workspaceSettings: { coordinatorBinding: { state: "active" } } },
        new Set(["p1"]),
        target,
      ),
    ).toBe(false);
  });
});
