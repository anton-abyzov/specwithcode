/**
 * `linkedCopyFor` for a linked personal assistant (1448): the caller names its
 * own seat, only an own, non-legacy, same-account machine syncs, and a seat
 * removed elsewhere is told so (fenced) only under that same rule.
 */
import { EnvironmentId, type Project, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { linkedCopyFor, PERSONAL_SEAT_REMOVED_MESSAGE } from "./LinkedPeerRoute.ts";
import type * as ProjectService from "./ProjectService.ts";

const SELF = EnvironmentId.make("m3");
const PEER = EnvironmentId.make("m4");
const SELF_SEAT = ProjectId.make("percy-m3");
const PEER_SEAT = ProjectId.make("percy-m4");
const LOGICAL_ID = "logical-percy";
const USER = "user_owner_1";

const member = (environmentId: EnvironmentId, projectId: ProjectId) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});

const personalCopy = (options: {
  readonly members: ReadonlyArray<ReturnType<typeof member>>;
  readonly removedMembers?: ReadonlyArray<{ environmentId: EnvironmentId; projectId: ProjectId }>;
}): Project =>
  ({
    id: SELF_SEAT,
    title: "Percy",
    deletedAt: null,
    workspaceSettings: {
      kind: "personal",
      logicalProject: {
        id: LOGICAL_ID,
        coordinatorId: `project-coordinator:${SELF_SEAT}`,
        members: options.members,
      },
      ...(options.removedMembers === undefined
        ? {}
        : {
            coordinatorBinding: {
              epoch: 0,
              state: "active",
              removedMembers: options.removedMembers,
            },
          }),
    },
  }) as unknown as Project;

const projectsWith = (project: Project) =>
  ({
    getById: (id: ProjectId) =>
      Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
  }) as unknown as ProjectService.ProjectService["Service"];

const grant = (overrides: Record<string, unknown> = {}) =>
  ({
    coordinatorEnvironmentId: PEER,
    kind: "own",
    owner: "self",
    legacy: false,
    revoked: false,
    maxRuntimeMode: "full-access",
    projects: { kind: "none" },
    accounts: { kind: "all" },
    ...overrides,
  }) as unknown as EffectiveWorkGrant;

const ownCaller = (overrides: Partial<ReceiverCaller> = {}): ReceiverCaller => ({
  sourceEnvironmentId: PEER,
  grant: grant(),
  runtimeCeiling: "full-access",
  cloudUserId: USER,
  ...overrides,
});

const linkedPair = () =>
  personalCopy({ members: [member(SELF, SELF_SEAT), member(PEER, PEER_SEAT)] });

/** The removed peer seat: this copy lists only itself and remembers M4's seat as removed. */
const removedPeer = () =>
  personalCopy({
    members: [member(SELF, SELF_SEAT)],
    removedMembers: [{ environmentId: PEER, projectId: PEER_SEAT }],
  });

/** Runs `linkedCopyFor` on M3; a refusal comes back as the value. */
const answer = (
  project: Project,
  caller: ReceiverCaller,
  forProjectId: ProjectId | undefined,
  localCloudUserId: string | null = USER,
) =>
  linkedCopyFor(
    projectsWith(project),
    SELF,
    caller,
    project.id,
    LOGICAL_ID,
    localCloudUserId,
    forProjectId,
  ).pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result)
        ? { ok: true as const, project: result.success }
        : { ok: false as const, refusal: result.failure as HandoffRefusal },
    ),
  );

const refusalOf = (
  project: Project,
  caller: ReceiverCaller,
  forProjectId: ProjectId | undefined,
  localCloudUserId: string | null = USER,
) =>
  answer(project, caller, forProjectId, localCloudUserId).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.die("The copy was handed out.") : Effect.succeed(result.refusal),
    ),
  );

describe("linkedCopyFor: linked personal assistant", () => {
  it.effect("hands out the copy to an own, same-account machine naming its listed seat", () =>
    Effect.gen(function* () {
      const project = linkedPair();
      const result = yield* answer(project, ownCaller(), PEER_SEAT);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.project.id).toBe(SELF_SEAT);
    }),
  );

  it.effect("refuses a caller that does not name its own seat", () =>
    Effect.gen(function* () {
      const refusal = yield* refusalOf(linkedPair(), ownCaller(), undefined);
      expect(refusal).toMatchObject({ status: 403, code: "needs_grant" });
      expect(refusal.message).toContain("names the caller's own linked seat");
    }),
  );

  it.effect("refuses a named seat the copy does not list for the caller's machine", () =>
    Effect.gen(function* () {
      const project = linkedPair();
      // Another project on the caller's machine.
      expect(
        yield* refusalOf(project, ownCaller(), ProjectId.make("percy-m4-other")),
      ).toMatchObject({ status: 403, code: "needs_grant" });
      // This machine's own seat: listed, but not the caller's.
      expect(yield* refusalOf(project, ownCaller(), SELF_SEAT)).toMatchObject({
        status: 403,
        code: "needs_grant",
      });
    }),
  );

  it.effect("refuses a listed seat under a team, legacy or revoked grant, or another account", () =>
    Effect.gen(function* () {
      const project = linkedPair();
      for (const caller of [
        ownCaller({ grant: grant({ kind: "team", owner: "member" }) }),
        ownCaller({ grant: grant({ legacy: true }) }),
        ownCaller({ grant: grant({ revoked: true }) }),
        ownCaller({ grant: null }),
        ownCaller({ cloudUserId: "user_someone_else" }),
        ownCaller({ cloudUserId: null }),
      ])
        expect(yield* refusalOf(project, caller, PEER_SEAT)).toMatchObject({
          status: 403,
          code: "needs_grant",
        });
      // This machine signed out of Connect: no account to match.
      expect(yield* refusalOf(project, ownCaller(), PEER_SEAT, null)).toMatchObject({
        status: 403,
        code: "needs_grant",
      });
    }),
  );

  it.effect("refuses a copy of another logical project", () =>
    Effect.gen(function* () {
      const project = linkedPair();
      const result = yield* linkedCopyFor(
        projectsWith(project),
        SELF,
        ownCaller(),
        project.id,
        "another-logical",
        USER,
        PEER_SEAT,
      ).pipe(Effect.flip);
      expect(result).toMatchObject({ status: 409, code: "invalid" });
    }),
  );

  describe("a seat removed elsewhere (AC-07)", () => {
    it.effect("tells an own, same-account removed seat that it was removed", () =>
      Effect.gen(function* () {
        const refusal = yield* refusalOf(removedPeer(), ownCaller(), PEER_SEAT);
        expect(refusal).toMatchObject({
          status: 409,
          code: "fenced",
          check: "project-link",
          message: PERSONAL_SEAT_REMOVED_MESSAGE,
        });
      }),
    );

    it.effect("tells nothing to a removed seat under a team or legacy grant", () =>
      Effect.gen(function* () {
        for (const caller of [
          ownCaller({ grant: grant({ kind: "team", owner: "member" }) }),
          ownCaller({ grant: grant({ legacy: true }) }),
          ownCaller({ grant: grant({ revoked: true }) }),
          ownCaller({ grant: null }),
        ]) {
          const refusal = yield* refusalOf(removedPeer(), caller, PEER_SEAT);
          expect(refusal).toMatchObject({ status: 403, code: "needs_grant" });
          expect(refusal.message).not.toBe(PERSONAL_SEAT_REMOVED_MESSAGE);
        }
      }),
    );

    it.effect("tells nothing to a removed seat signed in to another account", () =>
      Effect.gen(function* () {
        for (const [caller, local] of [
          [ownCaller({ cloudUserId: "user_someone_else" }), USER],
          [ownCaller({ cloudUserId: null }), USER],
          [ownCaller(), null],
        ] as const) {
          const refusal = yield* refusalOf(removedPeer(), caller, PEER_SEAT, local);
          expect(refusal).toMatchObject({ status: 403, code: "needs_grant" });
          expect(refusal.message).not.toBe(PERSONAL_SEAT_REMOVED_MESSAGE);
        }
      }),
    );

    it.effect("tells nothing when the named seat is not the one removed", () =>
      Effect.gen(function* () {
        const refusal = yield* refusalOf(
          removedPeer(),
          ownCaller(),
          ProjectId.make("percy-m4-other"),
        );
        expect(refusal).toMatchObject({ status: 403, code: "needs_grant" });
      }),
    );

    it.effect("tells nothing to a machine that was never a member", () =>
      Effect.gen(function* () {
        const refusal = yield* refusalOf(
          removedPeer(),
          ownCaller({ sourceEnvironmentId: EnvironmentId.make("m1") }),
          PEER_SEAT,
        );
        expect(refusal).toMatchObject({ status: 403, code: "needs_grant" });
      }),
    );
  });
});
