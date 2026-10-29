import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectCoordinatorBinding,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as WorkerEpochStore from "../fleet/WorkerEpochStore.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as Project from "../project/ProjectService.ts";
import {
  assertThreadWritable,
  claimCoordinatorEpoch,
  type WorkGrantContext,
} from "./workGrantAccess.ts";

/** This machine is the Minis; M4 runs the other coordinator of the same linked project. */
const MINIS = EnvironmentId.make("env-minis");
const M4 = EnvironmentId.make("env-m4");
const project = ProjectId.make("easychamp-minis");

const linked = (coordinatorBinding?: ProjectCoordinatorBinding, members = 2) =>
  projectFixture(project, {
    title: "EasyChamp",
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      ...(coordinatorBinding ? { coordinatorBinding } : {}),
      logicalProject: {
        id: "logical:easychamp",
        title: "EasyChamp",
        coordinatorId: "coordinator",
        members: [
          {
            environmentId: M4,
            projectId: ProjectId.make("easychamp-m4"),
            coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m4"),
          },
          {
            environmentId: MINIS,
            projectId: project,
            coordinatorThreadId: ThreadId.make(`project-coordinator:${project}`),
          },
        ].slice(0, members),
      },
    },
  });

const fromM4: WorkGrantContext = {
  grant: { coordinatorEnvironmentId: M4 } as WorkGrantContext["grant"],
  origin: undefined,
  coordinatorLabel: "M4",
};

const check = (
  current: ReturnType<typeof linked>,
  threadId: string,
  origins: Record<string, EnvironmentId> = {},
  work: WorkGrantContext = fromM4,
  claimed?: WorkerEpochStore.WorkerEpochRecord,
) =>
  Effect.exit(
    assertThreadWritable(work, {
      id: ThreadId.make(threadId),
      projectId: project,
      lineage: { rootThreadId: ThreadId.make(threadId), parentThreadId: null },
    } as never).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Project.ProjectService)({
            getById: () => Effect.succeed(Option.some(current)),
          }),
          Layer.succeed(WorkGrants.WorkGrants, {
            ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
            originOf: (thread) =>
              Effect.succeed(
                origins[thread.id] === undefined
                  ? undefined
                  : { coordinatorEnvironmentId: origins[thread.id]!, path: [], hops: 1 },
              ),
          }),
          Layer.succeed(WorkerEpochStore.WorkerEpochStore, {
            get: (logicalProjectId) =>
              Effect.succeed(claimed?.logicalProjectId === logicalProjectId ? claimed : undefined),
            claim: () => Effect.die(new Error("not claimed here")),
          }),
        ),
      ),
    ),
  );

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  const error = Exit.isFailure(exit) ? exit.cause : undefined;
  const failure = JSON.stringify(error);
  expect(failure).toContain("outside_grant_scope");
  return failure;
};

describe("assertThreadWritable", () => {
  it.effect(
    "lets the other machine's coordinator steer only the threads its own work started here",
    () =>
      Effect.gen(function* () {
        const active = linked({ epoch: 3, state: "active", operationId: "start-op" });
        expect(
          Exit.isSuccess(yield* check(active, "worker-from-m4", { "worker-from-m4": M4 })),
        ).toBe(true);
        const local = refusal(yield* check(active, "started-on-minis"));
        expect(local).toContain("may read it but not send to");
        refusal(yield* check(active, `project-coordinator:${project}`));
        refusal(yield* check(active, "from-m1", { "from-m1": EnvironmentId.make("env-m1") }));
        // The coordinator thread is never M4's to steer, even if an origin names M4.
        refusal(
          yield* check(active, `project-coordinator:${project}`, {
            [`project-coordinator:${project}`]: M4,
          }),
        );
        // A legacy kept copy (no binding) runs its own coordinator too.
        refusal(yield* check(linked(undefined), "started-on-minis"));
      }),
  );

  it.effect("keeps taking the project coordinator's work where this copy runs no coordinator", () =>
    Effect.gen(function* () {
      const relinquished = linked({
        epoch: 0,
        state: "transferred",
        operationId: "link-op",
      });
      expect(Exit.isSuccess(yield* check(relinquished, "started-on-minis"))).toBe(true);
    }),
  );

  // Review round 3: steering this machine's own work in a project that is not
  // linked would run it outside the grant's routines, sign-ins and revocation.
  it.effect("steers only its own work's threads in a project that is not linked", () =>
    Effect.gen(function* () {
      for (const current of [
        linked(undefined, 1),
        projectFixture(project, { title: "EasyChamp" }),
      ]) {
        const local = refusal(yield* check(current, "started-on-minis"));
        expect(local).toContain("may read it but not send to");
        refusal(yield* check(current, `project-coordinator:${project}`));
        refusal(yield* check(current, "from-m1", { "from-m1": EnvironmentId.make("env-m1") }));
        expect(
          Exit.isSuccess(yield* check(current, "worker-from-m4", { "worker-from-m4": M4 })),
        ).toBe(true);
      }
    }),
  );

  // Review round 4: the owner's own machines, kept as legacy grants on update,
  // keep steering this machine's threads as they did before grants existed.
  it.effect("lets a legacy grant steer this machine's threads outside linked projects", () =>
    Effect.gen(function* () {
      const legacy: WorkGrantContext = {
        ...fromM4,
        grant: { coordinatorEnvironmentId: M4, legacy: true } as WorkGrantContext["grant"],
      };
      const unlinked = projectFixture(project, { title: "EasyChamp" });
      for (const current of [linked(undefined, 1), unlinked]) {
        for (const threadId of ["started-on-minis", `project-coordinator:${project}`, "from-m1"])
          expect(
            Exit.isSuccess(
              yield* check(current, threadId, { "from-m1": EnvironmentId.make("env-m1") }, legacy),
            ),
          ).toBe(true);
      }
      // In a linked project the other coordinator's threads stay its own, as before.
      const active = linked({ epoch: 3, state: "active", operationId: "start-op" });
      refusal(yield* check(active, "started-on-minis", {}, legacy));
      expect(
        Exit.isSuccess(yield* check(active, "worker-from-m4", { "worker-from-m4": M4 }, legacy)),
      ).toBe(true);
      // A revoked legacy grant steers nothing.
      const revoked: WorkGrantContext = {
        ...legacy,
        grant: { ...legacy.grant, revoked: true },
      };
      expect(JSON.stringify(yield* check(unlinked, "started-on-minis", {}, revoked))).toContain(
        "machine_not_authorized",
      );
    }),
  );
});

/** 1086 AC-08: after M1 took over and claimed epoch 5 here, only epoch 5 or newer steers. */
describe("coordinator epoch claims", () => {
  const M1 = EnvironmentId.make("env-m1");
  // This copy runs no coordinator, so the project's coordinator steers every thread.
  const relinquished = linked({ epoch: 4, state: "transferred", operationId: "link-op" });
  const claim: WorkerEpochStore.WorkerEpochRecord = {
    logicalProjectId: "logical:easychamp",
    epoch: 5,
    claimedBy: M1,
    claimedAt: "2026-10-26T14:30:00.000Z",
  };
  const naming = (coordinator: EnvironmentId, epoch?: number): WorkGrantContext => ({
    grant: { coordinatorEnvironmentId: coordinator } as WorkGrantContext["grant"],
    origin: undefined,
    coordinatorLabel: coordinator === M1 ? "M1" : "M4",
    coordinatorEpochs: epoch === undefined ? undefined : new Map([["logical:easychamp", epoch]]),
  });
  const fenced = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true);
    const text = JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined);
    expect(text).toContain("thread_fenced");
    expect(text).toContain("Another machine now coordinates");
    return text;
  };

  it.effect("refuses steering that names an older epoch or none once a claim stands", () =>
    Effect.gen(function* () {
      const steer = (work: WorkGrantContext, claimed = claim) =>
        check(relinquished, "worker-from-m4", { "worker-from-m4": M4 }, work, claimed);
      // Before any claim nothing is held to an epoch, as today.
      expect(Exit.isSuccess(yield* check(relinquished, "worker-from-m4", {}, naming(M4)))).toBe(
        true,
      );
      // The old coordinator sends none, or still believes its older epoch.
      fenced(yield* steer(naming(M4)));
      fenced(yield* steer(naming(M4, 4)));
      // Even its own workers' threads: the claim moved them to M1.
      fenced(
        yield* check(
          linked({ epoch: 4, state: "active", operationId: "x" }),
          "worker-from-m4",
          { "worker-from-m4": M4 },
          naming(M4, 4),
          claim,
        ),
      );
      // The new coordinator names its epoch; a later one (handed back by hand) also steers.
      expect(Exit.isSuccess(yield* steer(naming(M1, 5)))).toBe(true);
      expect(Exit.isSuccess(yield* steer(naming(M4, 6)))).toBe(true);
      // A claim for another project changes nothing here.
      expect(
        Exit.isSuccess(yield* steer(naming(M4), { ...claim, logicalProjectId: "logical:other" })),
      ).toBe(true);
    }),
  );

  it.effect("leaves threads another machine's work started here to that work's origin", () =>
    Effect.gen(function* () {
      const fromWorkerThread: WorkGrantContext = {
        ...naming(M4),
        origin: { coordinatorEnvironmentId: M4, path: [M4], hops: 1 },
      };
      expect(
        Exit.isSuccess(
          yield* check(
            relinquished,
            "worker-from-m4",
            { "worker-from-m4": M4 },
            fromWorkerThread,
            claim,
          ),
        ),
      ).toBe(true);
    }),
  );
});

describe("WorkerEpochStore", () => {
  const storeLayer = WorkerEpochStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-worker-epochs-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  it.effect("keeps the highest epoch and refuses older or foreign claims", () =>
    Effect.gen(function* () {
      const store = yield* WorkerEpochStore.WorkerEpochStore;
      const claim = (epoch: number, by: string) =>
        store.claim({ logicalProjectId: "logical:easychamp", epoch, by });
      expect(yield* store.get("logical:easychamp")).toBeUndefined();
      expect(yield* claim(5, "env-m1")).toEqual({ accepted: true, epoch: 5 });
      // A retry of the same claim after a lost answer stands.
      expect(yield* claim(5, "env-m1")).toEqual({ accepted: true, epoch: 5 });
      expect(yield* claim(5, "env-m4")).toEqual({ accepted: false, epoch: 5 });
      expect(yield* claim(4, "env-m4")).toEqual({ accepted: false, epoch: 5 });
      expect((yield* store.get("logical:easychamp"))?.claimedBy).toBe("env-m1");
      expect(yield* claim(6, "env-m4")).toEqual({ accepted: true, epoch: 6 });
      expect(yield* store.get("logical:easychamp")).toMatchObject({
        epoch: 6,
        claimedBy: "env-m4",
      });
    }).pipe(Effect.provide(storeLayer)),
  );

  it("reads only well-formed epoch headers", () => {
    expect(WorkerEpochStore.parseCoordinatorEpochs(undefined)).toBeUndefined();
    expect(WorkerEpochStore.parseCoordinatorEpochs("not json")).toBeUndefined();
    expect(WorkerEpochStore.parseCoordinatorEpochs('{"a":-1}')).toBeUndefined();
    expect(WorkerEpochStore.parseCoordinatorEpochs('{"a":1.5}')).toBeUndefined();
    expect(WorkerEpochStore.parseCoordinatorEpochs("[1]")).toBeUndefined();
    const header = WorkerEpochStore.encodeCoordinatorEpochs(new Map([["logical:a", 3]]));
    expect(WorkerEpochStore.parseCoordinatorEpochs(header)).toEqual(new Map([["logical:a", 3]]));
    expect(WorkerEpochStore.encodeCoordinatorEpochs(new Map())).toBeUndefined();
  });
});

describe("claimCoordinatorEpoch", () => {
  const M1 = EnvironmentId.make("env-m1");
  const current = linked({ epoch: 4, state: "transferred", operationId: "link-op" });
  const claims: Array<WorkerEpochStore.EpochClaim> = [];
  const run = (
    client: { readonly principal: unknown } | undefined,
    grant: Partial<WorkGrantContext["grant"]> = {},
  ) =>
    Effect.exit(
      claimCoordinatorEpoch(
        {
          scope: { client: client as never } as never,
          threads: {
            getThreadShell: (threadId: string) =>
              Effect.succeed(
                threadId === "elsewhere"
                  ? { id: threadId, projectId: ProjectId.make("other-project") }
                  : threadId === "missing"
                    ? null
                    : { id: threadId, projectId: project },
              ),
          } as never,
          caller: undefined,
          limits: { runtimeMode: "auto", interactionMode: "default" } as never,
        },
        {
          logicalProjectId: "logical:easychamp",
          epoch: 5,
          threadIds: ["from-m4", "from-m3", "elsewhere", "missing", "from-m4"],
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Project.ProjectService)({
              snapshot: Effect.succeed({ projects: [current] } as never),
            }),
            Layer.succeed(WorkGrants.WorkGrants, {
              ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
              enabled: true,
              forClient: (caller) =>
                Effect.succeed(
                  caller === undefined
                    ? undefined
                    : ({
                        coordinatorEnvironmentId: M1,
                        // Arming grants the standby this one project here (AC-02).
                        projects: { kind: "listed", projectIds: [project] },
                        accounts: { kind: "all" },
                        revoked: false,
                        ...grant,
                      } as WorkGrantContext["grant"]),
                ),
              originOf: (thread) =>
                Effect.succeed(
                  thread.id === ("from-m4" as never) || thread.id === ("elsewhere" as never)
                    ? { coordinatorEnvironmentId: M4, path: [M4], hops: 1 }
                    : thread.id === ("from-m3" as never)
                      ? {
                          coordinatorEnvironmentId: EnvironmentId.make("env-m3"),
                          path: [],
                          hops: 1,
                        }
                      : undefined,
                ),
            }),
            Layer.succeed(WorkerEpochStore.WorkerEpochStore, {
              get: () => Effect.succeed(undefined),
              claim: (input) =>
                Effect.sync(() => {
                  claims.push(input);
                  return { accepted: true, epoch: input.epoch };
                }),
            }),
          ),
        ),
      ),
    );

  it.effect("records the claim for the caller's machine and reports origins in the project", () =>
    Effect.gen(function* () {
      claims.length = 0;
      const exit = yield* run({ principal: { kind: "coordinator" } });
      expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual({
        logicalProjectId: "logical:easychamp",
        accepted: true,
        epoch: 5,
        origins: [
          { threadId: "from-m4", coordinatorEnvironmentId: M4 },
          { threadId: "from-m3", coordinatorEnvironmentId: "env-m3" },
          // A thread of another project here, or none at all, reports no origin.
          { threadId: "elsewhere", coordinatorEnvironmentId: null },
          { threadId: "missing", coordinatorEnvironmentId: null },
        ],
      });
      expect(claims).toEqual([{ logicalProjectId: "logical:easychamp", epoch: 5, by: M1 }]);
    }),
  );

  it.effect("refuses a caller without a grant, a revoked grant, or a project outside it", () =>
    Effect.gen(function* () {
      claims.length = 0;
      expect(JSON.stringify(yield* run(undefined))).toContain("outside_grant_scope");
      expect(JSON.stringify(yield* run({ principal: {} }, { revoked: true }))).toContain(
        "machine_not_authorized",
      );
      expect(
        JSON.stringify(
          yield* run(
            { principal: {} },
            { projects: { kind: "listed", projectIds: ["something-else"] } as never },
          ),
        ),
      ).toContain("outside_grant_scope");
      expect(claims).toEqual([]);
    }),
  );
});
