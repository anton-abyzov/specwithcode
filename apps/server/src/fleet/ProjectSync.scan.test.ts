// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The repository walk Sync makes (1469): bounded by its budget, shared by concurrent calls on
 * one folder, and left at once by a cancelled fetch, which gives the project's lock back.
 * The walk is a stand-in; the folders and Git are real and temporary.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { type Project, ProjectId } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { cleanUp, isolateGit, restoreGit, twoMachines } from "../handoff/extrasTestKit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as HandoffGit from "./handoffGit.ts";
import { HandoffGitError } from "./handoffGitTypes.ts";
import * as ProjectSync from "./ProjectSync.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const projectA = ProjectId.make("project-scan");
const one = { projectId: projectA };

/** The walk as a test drives it: counted, and it says when it has started. */
interface Walk {
  calls: number;
  readonly started: Deferred.Deferred<void>;
  readonly body: Effect.Effect<ReadonlyArray<string>, HandoffGitError>;
}

const withSync = <A, E>(
  walk: Walk,
  body: (
    sync: ProjectSync.ProjectSync["Service"],
    admission: ProjectAdmission.ProjectAdmission["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const f = twoMachines();
    return yield* Effect.gen(function* () {
      return yield* body(yield* ProjectSync.ProjectSync, yield* ProjectAdmission.ProjectAdmission);
    }).pipe(
      Effect.provide(
        ProjectSync.layerOnServices.pipe(
          Layer.provideMerge(ProjectAdmission.layer),
          Layer.provide(
            Layer.mock(HandoffGit.HandoffGit)({
              discover: () =>
                Effect.suspend(() => {
                  walk.calls += 1;
                  return Deferred.succeed(walk.started, undefined).pipe(Effect.andThen(walk.body));
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              snapshot: Effect.succeed({
                projects: [
                  {
                    id: projectA,
                    title: "App",
                    workspaceRoot: f.b,
                    workspaceSettings: {},
                  } as unknown as Project,
                ],
                updatedAt: "2026-11-24T00:00:00.000Z",
              }),
            }),
          ),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

const walk = (body: Walk["body"]) =>
  Deferred.make<void>().pipe(Effect.map((started): Walk => ({ calls: 0, started, body })));

describe("the walk's budget (AC-02)", () => {
  it.effect(
    "a walk past its budget ends as the root alone, and the fetch gives the lock back",
    () =>
      Effect.gen(function* () {
        const stuck = yield* walk(Effect.never);
        yield* withSync(stuck, (sync, admission) =>
          Effect.gen(function* () {
            const fetching = yield* sync.fetch(one).pipe(Effect.forkChild);
            yield* Deferred.await(stuck.started);
            expect(yield* admission.activeKeys).toEqual([projectA]);
            yield* TestClock.adjust(ProjectSync.SYNC_SCAN_BUDGET);
            const fetched = yield* Fiber.join(fetching);
            expect(fetched.scanLimited).toBe(true);
            expect(fetched.repositories.map((row) => row.path)).toEqual(["."]);
            expect(yield* admission.activeKeys).toEqual([]);
          }),
        );
      }),
  );

  it.effect("a walk that fails closed is the same root-only result", () =>
    Effect.gen(function* () {
      const refused = yield* walk(
        Effect.fail(new HandoffGitError({ stage: "inspect", reason: "scan-limit" })),
      );
      yield* withSync(refused, (sync) =>
        Effect.gen(function* () {
          const status = yield* sync.status(one);
          expect(status.scanLimited).toBe(true);
          expect(status.repositories.map((row) => row.path)).toEqual(["."]);
        }),
      );
    }),
  );
});

describe("one walk per folder (AC-03)", () => {
  it.effect("concurrent calls share one walk, reuse it briefly, and a run forgets it", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<ReadonlyArray<string>>();
      const gated = yield* walk(Deferred.await(release));
      yield* withSync(gated, (sync) =>
        Effect.gen(function* () {
          const calls = yield* Effect.all(
            [
              sync.status(one).pipe(Effect.map((result) => result.scanLimited)),
              sync.fetch(one).pipe(Effect.map((result) => result.scanLimited)),
              sync.repositories(projectA).pipe(Effect.map((result) => result.scanLimited)),
              sync.status(one).pipe(Effect.map((result) => result.scanLimited)),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Deferred.await(gated.started);
          yield* Deferred.succeed(release, ["."]);
          expect(yield* Fiber.join(calls)).toEqual([false, false, false, false]);
          expect(gated.calls).toBe(1);
          // A walk that finished a moment ago is reused...
          yield* sync.status(one);
          expect(gated.calls).toBe(1);
          // ...for a few seconds only.
          yield* TestClock.adjust(ProjectSync.SYNC_SCAN_REUSE);
          yield* sync.status(one);
          expect(gated.calls).toBe(2);
          // A run can clone a repository: the next call walks again.
          yield* sync.run({ projectId: projectA, fetchId: "none", fastForward: [], clone: [] });
          yield* sync.status(one);
          expect(gated.calls).toBe(3);
        }),
      );
    }),
  );

  it.effect("a failed walk is not kept", () =>
    Effect.gen(function* () {
      const broken = yield* walk(Effect.never);
      yield* withSync(broken, (sync) =>
        Effect.gen(function* () {
          const first = yield* sync.status(one).pipe(Effect.forkChild);
          yield* Deferred.await(broken.started);
          yield* TestClock.adjust(ProjectSync.SYNC_SCAN_BUDGET);
          expect((yield* Fiber.join(first)).scanLimited).toBe(true);
          // A root-only answer after a budget is a success, kept briefly like any other.
          yield* sync.status(one);
          expect(broken.calls).toBe(1);
        }),
      );
    }),
  );
});

describe("a cancelled fetch (AC-06)", () => {
  it.effect("an interrupted fetch leaves at once and releases the project's lock", () =>
    Effect.gen(function* () {
      const stuck = yield* walk(Effect.never);
      yield* withSync(stuck, (sync, admission) =>
        Effect.gen(function* () {
          const fetching = yield* sync.fetch(one).pipe(Effect.forkChild);
          yield* Deferred.await(stuck.started);
          expect(yield* admission.activeKeys).toEqual([projectA]);
          // The window's Cancel: the RPC server interrupts the handler's fiber.
          yield* Fiber.interrupt(fetching);
          expect(yield* admission.activeKeys).toEqual([]);
          // Project Link and handoff take the lock right away, though the walk still runs.
          expect(yield* admission.withLock(projectA, Effect.succeed("taken"))).toBe("taken");
          expect(stuck.calls).toBe(1);
        }),
      );
    }),
  );
});
