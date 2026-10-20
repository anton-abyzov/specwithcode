import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  ProjectId,
  ThreadId,
  type LogicalProject,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  ProjectPlanActor,
  ProjectPlanLinkExport,
  ProjectPlanSnapshot,
} from "../../../../packages/contracts/src/projectPlan.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Plans from "./ProjectPlanService.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const envC = EnvironmentId.make("env-c");
const projectA = ProjectId.make("app-a");
const projectB = ProjectId.make("app-b");
const user: ProjectPlanActor = { kind: "user" };
const worker = (id: string): ProjectPlanActor => ({ kind: "thread", threadId: ThreadId.make(id) });
const logical: LogicalProject = {
  id: "logical-app",
  title: "App",
  coordinatorId: "coordinator",
  members: [
    { environmentId: envA, projectId: projectA, coordinatorThreadId: ThreadId.make("app-a:lead") },
    { environmentId: envB, projectId: projectB, coordinatorThreadId: ThreadId.make("app-b:lead") },
  ],
};

/** One machine: its own database, its own identity, its own project row. */
const machineLayer = (environmentId: EnvironmentId) =>
  Layer.fresh(
    Plans.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Projects.layer,
          ProcessRunner.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (id) =>
              Effect.succeed({
                ...liveThreadShell(id),
                projectId: ProjectId.make(id.split(":")[0]!),
              }),
          }),
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ).pipe(Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
  );

const machine = (environmentId: EnvironmentId, projectId: ProjectId, linked = true) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(machineLayer(environmentId));
    yield* Context.get(context, Projects.ProjectStoreV2).apply({
      sequence: 1,
      eventId: EventId.make(`event:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "App",
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          ...(linked ? { logicalProject: logical } : {}),
        },
      },
    });
    return { environmentId, projectId, plans: Context.get(context, Plans.ProjectPlanService) };
  });
type Machine = Effect.Success<ReturnType<typeof machine>>;

const sync = (from: Machine, to: Machine, label: string) =>
  Effect.gen(function* () {
    const exported = yield* from.plans.exportLinked({ projectId: from.projectId });
    return yield* to.plans.mergeLinked({
      projectId: to.projectId,
      peer: { environmentId: from.environmentId, projectId: from.projectId, label },
      export: exported,
    });
  });
const task = (snapshot: ProjectPlanSnapshot) => snapshot.native!.tasks[0]!;
const definition = {
  spec: "Ship the linked feature.",
  criteria: [{ id: "AC-1", text: "It works." }],
  tasks: [{ id: "T-1", title: "Build it", criterionIds: ["AC-1"], verification: null }],
};

it.layer(NodeServices.layer, { excludeTestServices: true })("linked plan claims", (it) => {
  it.effect("replicates a plan and its claim, and fences the claim on the other machine", () =>
    Effect.gen(function* () {
      const a = yield* machine(envA, projectA);
      const b = yield* machine(envB, projectB);
      yield* a.plans.replace({ projectId: projectA, actor: user, expectedRevision: 0, definition });
      const claimed = yield* a.plans.claim({
        projectId: projectA,
        expectedRevision: 1,
        taskId: "T-1",
        actor: worker("app-a:worker"),
      });
      assert.deepEqual(task(claimed).owner, {
        kind: "thread",
        threadId: ThreadId.make("app-a:worker"),
        environmentId: envA,
      });
      assert.isString(task(claimed).claimedAt);
      assert.equal(claimed.environmentId, envA);

      assert.isTrue((yield* sync(a, b, "Mac A")).changed);
      const seen = yield* b.plans.read({ projectId: projectB });
      assert.equal(seen.environmentId, envB);
      assert.equal(seen.native!.spec, "Ship the linked feature.");
      assert.deepEqual(task(seen).owner, task(claimed).owner);
      assert.equal(task(seen).claimedAt, task(claimed).claimedAt);
      assert.equal(task(seen).status, "in_progress");
      assert.deepEqual(seen.native!.machines, [{ environmentId: envA, label: "Mac A" }]);

      const refused = yield* b.plans
        .claim({
          projectId: projectB,
          expectedRevision: seen.revision,
          taskId: "T-1",
          actor: worker("app-b:worker"),
        })
        .pipe(Effect.flip);
      assert.equal(refused.code, "claimed");
      assert.equal(refused.machine, "Mac A");
      assert.include(refused.message, "Mac A");
      const report = yield* b.plans
        .report({
          projectId: projectB,
          expectedRevision: seen.revision,
          taskId: "T-1",
          actor: worker("app-b:worker"),
          status: "reported_done",
          note: "done",
        })
        .pipe(Effect.flip);
      assert.equal(report.code, "claimed");

      assert.isFalse((yield* sync(a, b, "Mac A")).changed);
      assert.isTrue((yield* sync(b, a, "Mac B")).changed);
      assert.isFalse((yield* sync(b, a, "Mac B")).changed);
      const back = yield* a.plans.read({ projectId: projectA });
      assert.deepEqual(task(back).owner, task(claimed).owner);
      assert.deepEqual(back.native!.machines, [{ environmentId: envB, label: "Mac B" }]);
    }),
  );

  it.effect("keeps a stale claim until the user releases it, and never restores it", () =>
    Effect.gen(function* () {
      const a = yield* machine(envA, projectA);
      const b = yield* machine(envB, projectB);
      yield* a.plans.replace({ projectId: projectA, actor: user, expectedRevision: 0, definition });
      const claimed = yield* a.plans.claim({
        projectId: projectA,
        expectedRevision: 1,
        taskId: "T-1",
        actor: worker("app-a:worker"),
      });
      yield* sync(a, b, "Mac A");
      // Machine A is now unreachable: no further syncs from it.
      const seen = yield* b.plans.read({ projectId: projectB });
      const foreignOwner = task(seen).owner!;
      const threadRelease = yield* b.plans
        .release({
          projectId: projectB,
          expectedRevision: seen.revision,
          taskId: "T-1",
          actor: worker("app-b:worker"),
          expectedOwner: foreignOwner,
        })
        .pipe(Effect.flip);
      assert.equal(threadRelease.code, "claimed");
      const disguised = yield* b.plans
        .claim({
          projectId: projectB,
          expectedRevision: seen.revision,
          taskId: "T-1",
          actor: { kind: "thread", threadId: ThreadId.make("app-a:worker"), environmentId: envA },
        })
        .pipe(Effect.flip);
      assert.equal(disguised.code, "forbidden");
      assert.deepEqual(task(yield* b.plans.read({ projectId: projectB })).owner, foreignOwner);

      const released = yield* b.plans.release({
        projectId: projectB,
        expectedRevision: seen.revision,
        taskId: "T-1",
        actor: user,
        expectedOwner: foreignOwner,
      });
      assert.isNull(task(released).owner);
      assert.deepEqual(task(released).releasedClaims, [
        { owner: foreignOwner, claimedAt: task(claimed).claimedAt! },
      ]);

      // A comes back still holding its old copy; the user's release wins on both machines.
      assert.isFalse((yield* sync(a, b, "Mac A")).changed);
      assert.isNull(task(yield* b.plans.read({ projectId: projectB })).owner);
      assert.isTrue((yield* sync(b, a, "Mac B")).changed);
      const onA = yield* a.plans.read({ projectId: projectA });
      assert.isNull(task(onA).owner);
      const reclaimed = yield* b.plans.claim({
        projectId: projectB,
        expectedRevision: released.revision,
        taskId: "T-1",
        actor: worker("app-b:worker"),
      });
      assert.equal(task(reclaimed).owner?.kind, "thread");
    }),
  );

  it.effect("records the losing claim after a partition and refuses its thread", () =>
    Effect.gen(function* () {
      const a = yield* machine(envA, projectA);
      const b = yield* machine(envB, projectB);
      yield* a.plans.replace({ projectId: projectA, actor: user, expectedRevision: 0, definition });
      yield* sync(a, b, "Mac A");
      const first = yield* a.plans.claim({
        projectId: projectA,
        expectedRevision: 1,
        taskId: "T-1",
        actor: worker("app-a:worker"),
      });
      yield* Effect.sleep("5 millis");
      const bRead = yield* b.plans.read({ projectId: projectB });
      const second = yield* b.plans.claim({
        projectId: projectB,
        expectedRevision: bRead.revision,
        taskId: "T-1",
        actor: worker("app-b:worker"),
      });
      assert.isTrue(task(first).claimedAt! < task(second).claimedAt!);

      // Export both sides first, then merge each into the other (as the web driver does).
      const exportA = yield* a.plans.exportLinked({ projectId: projectA });
      const exportB = yield* b.plans.exportLinked({ projectId: projectB });
      const mergeInto = (target: Machine, from: Machine, exported: ProjectPlanLinkExport) =>
        target.plans.mergeLinked({
          projectId: target.projectId,
          peer: {
            environmentId: from.environmentId,
            projectId: from.projectId,
            label: from === a ? "Mac A" : "Mac B",
          },
          export: exported,
        });
      yield* mergeInto(b, a, exportA);
      yield* mergeInto(a, b, exportB);
      const onA = task(yield* a.plans.read({ projectId: projectA }));
      const onB = task(yield* b.plans.read({ projectId: projectB }));
      assert.deepEqual(onA.owner, task(first).owner);
      assert.deepEqual(onB.owner, task(first).owner);
      assert.deepEqual(onA.claimConflict, {
        owner: task(second).owner!,
        claimedAt: task(second).claimedAt!,
      });
      assert.deepEqual(onB.claimConflict, onA.claimConflict);

      const loser = yield* b.plans
        .report({
          projectId: projectB,
          expectedRevision: (yield* b.plans.read({ projectId: projectB })).revision,
          taskId: "T-1",
          actor: worker("app-b:worker"),
          status: "reported_done",
          note: "finished",
        })
        .pipe(Effect.flip);
      assert.equal(loser.code, "claimed");
      assert.equal(loser.machine, "Mac A");
      assert.isFalse((yield* sync(a, b, "Mac A")).changed);
      assert.isFalse((yield* sync(b, a, "Mac B")).changed);
    }),
  );

  it.effect("accepts plans only from another listed member of the same logical project", () =>
    Effect.gen(function* () {
      const a = yield* machine(envA, projectA);
      const b = yield* machine(envB, projectB);
      const loose = yield* machine(envC, ProjectId.make("app-c"), false);
      const exported = yield* a.plans.exportLinked({ projectId: projectA });
      const merge = (
        peer: { environmentId: EnvironmentId; projectId: ProjectId },
        value = exported,
      ) =>
        b.plans
          .mergeLinked({
            projectId: projectB,
            peer: { ...peer, label: "peer" },
            export: value,
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          );
      assert.equal(yield* merge({ environmentId: envB, projectId: projectB }), "not_linked");
      assert.equal(yield* merge({ environmentId: envC, projectId: projectA }), "not_linked");
      assert.equal(yield* merge({ environmentId: envA, projectId: projectB }), "not_linked");
      assert.equal(
        yield* merge(
          { environmentId: envA, projectId: projectA },
          { ...exported, logicalProjectId: "other" },
        ),
        "not_linked",
      );
      assert.equal(
        (yield* loose.plans.exportLinked({ projectId: ProjectId.make("app-c") }).pipe(Effect.flip))
          .code,
        "not_linked",
      );
      const accepted = () =>
        b.plans.mergeLinked({
          projectId: projectB,
          peer: { environmentId: envA, projectId: projectA, label: "Mac A" },
          export: exported,
        });
      assert.isTrue((yield* accepted()).changed);
      assert.isFalse((yield* accepted()).changed);
    }),
  );
});
