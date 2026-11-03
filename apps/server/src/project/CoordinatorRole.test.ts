import { EnvironmentId, type Project, ProjectId } from "@specweave-studio/contracts";
import type { StudioWorkGrantProjects } from "@specweave-studio/contracts/studioFleet";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { COORDINATOR_LEASE_PROTOCOL_VERSION } from "../handoff/handoffWire.ts";
import * as CoordinatorLeaseRoute from "./CoordinatorLeaseRoute.ts";
import {
  CoordinatorRole,
  type CoordinatorRoleChange,
  coordinatorRoleOf,
  layer as CoordinatorRoleLayer,
} from "./CoordinatorRole.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectLink from "./ProjectLink.ts";
import { legacyPair, link, removeCheckouts } from "./ProjectLink.testkit.ts";
import * as ProjectService from "./ProjectService.ts";

afterEach(removeCheckouts);

const standbyId = "55555555-5555-4555-8555-555555555555";
const takeoverId = "66666666-6666-4666-8666-666666666666";

const project = (settings?: Partial<NonNullable<Project["workspaceSettings"]>>) =>
  ({
    id: ProjectId.make("easychamp"),
    deletedAt: null,
    workspaceSettings: settings,
  }) as unknown as Project;

describe("coordinatorRoleOf", () => {
  it("counts a copy with no binding, linked or not, as active at epoch 0", () => {
    expect(coordinatorRoleOf(project())).toEqual({
      projectId: "easychamp",
      logicalProjectId: null,
      active: true,
      epoch: 0,
      state: "active",
    });
  });

  it("follows the copy's own binding", () => {
    const linked = { id: "logical:easychamp", members: [] } as never;
    expect(
      coordinatorRoleOf(
        project({ logicalProject: linked, coordinatorBinding: { epoch: 3, state: "active" } }),
      ),
    ).toMatchObject({ logicalProjectId: "logical:easychamp", active: true, epoch: 3 });
    expect(
      coordinatorRoleOf(
        project({ logicalProject: linked, coordinatorBinding: { epoch: 4, state: "transferred" } }),
      ),
    ).toMatchObject({ active: false, epoch: 4, state: "transferred" });
    expect(
      coordinatorRoleOf(project({ coordinatorBinding: { epoch: 2, state: "transferring" } })),
    ).toMatchObject({ active: false, state: "transferring" });
  });
});

describe("CoordinatorRole", () => {
  it.effect("reads no role for a project this machine lacks or deleted", () =>
    Effect.gen(function* () {
      const role = yield* CoordinatorRole;
      expect(Option.getOrUndefined(yield* role.roleOf(ProjectId.make("easychamp")))).toMatchObject({
        active: true,
        epoch: 0,
      });
      expect(Option.isNone(yield* role.roleOf(ProjectId.make("gone")))).toBe(true);
      expect(Option.isNone(yield* role.roleOf(ProjectId.make("missing")))).toBe(true);
    }).pipe(
      Effect.provide(
        CoordinatorRoleLayer.pipe(
          Layer.provide(
            Layer.succeed(ProjectService.ProjectService, {
              getById: (projectId: ProjectId) =>
                Effect.succeed(
                  projectId === "easychamp"
                    ? Option.some(project())
                    : projectId === "gone"
                      ? Option.some({ ...project(), deletedAt: "2026-10-26T00:00:00.000Z" })
                      : Option.none(),
                ),
            } as unknown as ProjectService.ProjectService["Service"]),
          ),
        ),
      ),
    ),
  );

  it.effect("publishes what ProjectLink and the lease receiver write, where they write it", () =>
    Effect.gen(function* () {
      const pair = legacyPair();
      const { prepared } = yield* Effect.promise(() => link(pair));
      const logicalProjectId = prepared.logicalProject.id;
      // Each machine's server: its ProjectLink, lease receiver and role, built once.
      const m4 = yield* Layer.build(pair.m4.layer);
      const m3 = yield* Layer.build(
        Layer.mergeAll(CoordinatorLeaseRoute.layer, ProjectAdmission.layer).pipe(
          Layer.provideMerge(pair.m3.layer),
        ),
      );
      const on4 = <A, E>(effect: Effect.Effect<A, E, ProjectLink.ProjectLink | CoordinatorRole>) =>
        Effect.provideContext(effect, m4);
      const on3 = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          ProjectLink.ProjectLink | CoordinatorRole | CoordinatorLeaseRoute.CoordinatorLeaseReceiver
        >,
      ) => Effect.provideContext(effect, m3);
      const listen = (count: number) =>
        Effect.gen(function* () {
          const role = yield* CoordinatorRole;
          const fiber = yield* role.changes.pipe(
            Stream.take(count),
            Stream.runCollect,
            Effect.forkChild,
          );
          for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow;
          return fiber;
        });
      const heard = (fiber: Fiber.Fiber<ReadonlyArray<CoordinatorRoleChange>>) =>
        Effect.map(Fiber.join(fiber), (changes) => changes.map(({ at: _at, ...change }) => change));
      const on3Changes = yield* on3(listen(4));
      const on4Changes = yield* on4(listen(1));

      const arm = Effect.gen(function* () {
        yield* on4(
          Effect.flatMap(ProjectLink.ProjectLink, (service) =>
            service.setStandby({
              operationId: standbyId,
              projectId: pair.kept.projectId,
              standby: { member: pair.joining, afterMinutes: 15 },
            }),
          ),
        );
        yield* on3(
          Effect.flatMap(ProjectLink.ProjectLink, (service) =>
            service.acceptStandby({
              projectId: pair.joining.projectId,
              logicalProjectId,
              standby: { coordinator: pair.kept, epoch: 0, afterMinutes: 15 },
            }),
          ),
        );
      });
      // Armed, then released by M4 through the lease route, then armed again.
      yield* arm;
      yield* on3(
        Effect.flatMap(CoordinatorLeaseRoute.CoordinatorLeaseReceiver, (receiver) =>
          receiver.lease(
            {
              sourceEnvironmentId: EnvironmentId.make("m4"),
              grant: {
                coordinatorEnvironmentId: EnvironmentId.make("m4"),
                projects: {
                  kind: "listed",
                  projectIds: [pair.joining.projectId],
                } as StudioWorkGrantProjects,
                hopLimit: 1,
                revoked: false,
              } as unknown as EffectiveWorkGrant,
            },
            {
              protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
              kind: "release",
              logicalProjectId,
              epoch: 0,
              seq: 1,
              afterMinutes: 15,
              contentDigest: "digest",
              runningThreads: [],
              workers: [],
            },
          ),
        ),
      );
      yield* arm;
      expect(
        Option.getOrUndefined(
          yield* on3(
            Effect.flatMap(CoordinatorRole, (role) => role.roleOf(pair.joining.projectId)),
          ),
        ),
      ).toMatchObject({ active: false, epoch: 0, state: "transferred", logicalProjectId });

      // M3 takes over by hand; M4 gives way.
      const taken = yield* on3(
        Effect.flatMap(ProjectLink.ProjectLink, (service) =>
          service.takeover({
            operationId: takeoverId,
            projectId: pair.joining.projectId,
            knownEpoch: 0,
            predecessor: pair.kept,
          }),
        ),
      );
      yield* on4(
        Effect.flatMap(ProjectLink.ProjectLink, (service) =>
          service.supersede({
            projectId: pair.kept.projectId,
            logicalProjectId,
            successor: pair.joining,
            coordinatorBinding: taken.coordinatorBinding,
          }),
        ),
      );

      const projectId3 = pair.joining.projectId;
      expect(yield* heard(on3Changes)).toEqual([
        {
          kind: "standby-armed",
          projectId: projectId3,
          logicalProjectId,
          coordinator: pair.kept,
          epoch: 0,
          afterMinutes: 15,
        },
        { kind: "standby-released", projectId: projectId3, logicalProjectId, reason: "released" },
        {
          kind: "standby-armed",
          projectId: projectId3,
          logicalProjectId,
          coordinator: pair.kept,
          epoch: 0,
          afterMinutes: 15,
        },
        {
          kind: "took-over",
          projectId: projectId3,
          logicalProjectId,
          epoch: 1,
          predecessor: pair.kept,
          takenOverBy: "person",
        },
      ]);
      expect(yield* heard(on4Changes)).toEqual([
        {
          kind: "gave-way",
          projectId: pair.kept.projectId,
          logicalProjectId,
          epoch: 1,
          successor: pair.joining,
        },
      ]);
      expect(
        Option.getOrUndefined(
          yield* on3(Effect.flatMap(CoordinatorRole, (role) => role.roleOf(projectId3))),
        ),
      ).toMatchObject({ active: true, epoch: 1 });
      expect(
        Option.getOrUndefined(
          yield* on4(Effect.flatMap(CoordinatorRole, (role) => role.roleOf(pair.kept.projectId))),
        ),
      ).toMatchObject({ active: false, epoch: 1, state: "transferred" });
    }).pipe(Effect.scoped),
  );
});
