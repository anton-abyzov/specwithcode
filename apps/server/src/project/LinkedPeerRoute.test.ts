import { EnvironmentId, ProjectId, ProjectPlanError, ThreadId } from "@specweave-studio/contracts";
import type { StudioWorkGrantProjects } from "@specweave-studio/contracts/studioFleet";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedDigestResponse,
} from "../handoff/linkedSyncWire.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import * as LinkedPeerRoute from "./LinkedPeerRoute.ts";
import { legacyPair, link, removeCheckouts } from "./ProjectLink.testkit.ts";
import { ProjectPlanService } from "./ProjectPlanService.ts";

afterEach(removeCheckouts);

const callerFrom = (environment: string, projects: StudioWorkGrantProjects): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects,
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

/** M4 coordinates; its M3 copy answers M4's linked sync through the peer route. */
const linked = (
  /** What the copy that took over answers when M3 asks it to confirm; unset: no peer route. */
  successorDigest?: () => Effect.Effect<LinkedDigestResponse, HandoffPeerError>,
) =>
  Effect.gen(function* () {
    const pair = legacyPair();
    const { prepared } = yield* Effect.promise(() => link(pair));
    const logicalProjectId = prepared.logicalProject.id;
    const m4 = callerFrom("m4", { kind: "listed", projectIds: [pair.joining.projectId] });
    const ref = {
      protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
      logicalProjectId,
      projectId: pair.joining.projectId,
    };
    const services = Layer.mergeAll(
      Layer.succeed(LinkedMemorySync, {
        memoryExport: () => Effect.succeed({ digest: "a".repeat(64) }),
      } as unknown as LinkedMemorySync["Service"]),
      Layer.succeed(ProjectPlanService, {
        exportLinked: ({ projectId }: { projectId: ProjectId }) =>
          Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
      } as unknown as ProjectPlanService["Service"]),
      successorDigest === undefined
        ? Layer.empty
        : Layer.succeed(HandoffPeers, {
            linkedDigest: () => successorDigest(),
          } as unknown as HandoffPeers["Service"]),
    );
    /** Runs one call on the M3 receiver; a refusal comes back as the value. */
    const onM3 = <A>(
      use: (
        receiver: LinkedPeerRoute.LinkedPeerReceiver["Service"],
      ) => Effect.Effect<A, HandoffRefusal>,
    ) =>
      Effect.gen(function* () {
        return yield* use(yield* LinkedPeerRoute.LinkedPeerReceiver);
      }).pipe(
        Effect.provide(
          LinkedPeerRoute.layer.pipe(Layer.provideMerge(Layer.merge(pair.m3.layer, services))),
        ),
        Effect.result,
        Effect.map((result) =>
          Result.isSuccess(result)
            ? { ok: true as const, value: result.success }
            : { ok: false as const, refusal: result.failure },
        ),
      );
    const refused = <A>(
      use: (
        receiver: LinkedPeerRoute.LinkedPeerReceiver["Service"],
      ) => Effect.Effect<A, HandoffRefusal>,
    ) =>
      onM3(use).pipe(
        Effect.flatMap((answer) =>
          answer.ok ? Effect.die("The call was answered.") : Effect.succeed(answer.refusal),
        ),
      );
    return { pair, logicalProjectId, m4, ref, onM3, refused };
  });

describe("LinkedPeerReceiver", () => {
  it.effect(
    "does not give way to an old peer that reconnects with a takeover it confirms (AC-35)",
    () =>
      Effect.gen(function* () {
        // The binding a peer from before equal coordinators holds after it took over from M3.
        const takeover = (pair: ReturnType<typeof legacyPair>) => ({
          epoch: 1,
          state: "active" as const,
          operationId: "takeover:1",
          predecessor: pair.joining,
          takenOverAt: "2026-11-03T00:00:00.000Z",
        });
        let pairNow: ReturnType<typeof legacyPair> | undefined;
        // M4 answers the confirmation exactly as claimed: nothing about the claim is wrong.
        const { pair, m4, ref, refused } = yield* linked(() =>
          Effect.succeed({
            protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
            member: pairNow!.kept,
            binding: takeover(pairNow!),
            coordinatorDigest: "0".repeat(64),
            replica: null,
            memoryDigest: null,
            planDigest: null,
          }),
        );
        pairNow = pair;
        const before = pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings;
        expect(before?.coordinatorBinding?.state).toBe("active");
        const refusal = yield* refused((receiver) =>
          receiver.supersede(m4, {
            ...ref,
            successor: pair.kept,
            coordinatorBinding: takeover(pair),
          }),
        );
        // A plain refusal: the older peer asks again on its own backoff and is refused again.
        expect(refusal).toMatchObject({ status: 409, code: "invalid" });
        expect(refusal.message).toContain("Every machine runs its own coordinator");
        expect(pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings).toEqual(before);
        expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
      }),
  );

  it.effect("answers a listed copy's digest exchange with this copy's state", () =>
    Effect.gen(function* () {
      const { pair, m4, ref, onM3 } = yield* linked();
      const answer = yield* onM3((receiver) => receiver.digest(m4, ref));
      if (!answer.ok) return yield* Effect.die(answer.refusal);
      expect(answer.value).toMatchObject({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        member: { environmentId: pair.joining.environmentId, projectId: pair.joining.projectId },
        binding: { state: "active" },
        replica: null,
        memoryDigest: "a".repeat(64),
        planDigest: null,
      });
    }),
  );

  it.effect(
    "refuses its own machine, a machine the project does not list, and another identity",
    () =>
      Effect.gen(function* () {
        const { m4, ref, refused } = yield* linked();
        expect(
          yield* refused((receiver) => receiver.digest(callerFrom("m3", { kind: "all" }), ref)),
        ).toMatchObject({ status: 403, code: "needs_grant" });
        expect(
          yield* refused((receiver) => receiver.digest(callerFrom("m1", { kind: "all" }), ref)),
        ).toMatchObject({ status: 403, code: "needs_grant" });
        expect(
          yield* refused((receiver) =>
            receiver.digest(m4, { ...ref, logicalProjectId: "another" }),
          ),
        ).toMatchObject({ status: 409, code: "invalid" });
        // A machine outside the project cannot tell that the copy belongs to another project.
        expect(
          yield* refused((receiver) =>
            receiver.digest(callerFrom("m1", { kind: "all" }), {
              ...ref,
              logicalProjectId: "another",
            }),
          ),
        ).toMatchObject({ status: 403, code: "needs_grant" });
        expect(
          yield* refused((receiver) =>
            receiver.digest(m4, { ...ref, projectId: ProjectId.make("elsewhere") }),
          ),
        ).toMatchObject({ status: 404, code: "not_found" });
      }),
  );

  it.effect(
    "refuses a grant whose project list leaves this copy out, and another protocol version",
    () =>
      Effect.gen(function* () {
        const { ref, refused } = yield* linked();
        const narrow = callerFrom("m4", { kind: "listed", projectIds: [ProjectId.make("other")] });
        expect(yield* refused((receiver) => receiver.digest(narrow, ref))).toMatchObject({
          status: 403,
          code: "needs_grant",
        });
        const { m4 } = yield* linked();
        expect(
          yield* refused((receiver) =>
            receiver.digest(m4, { ...ref, protocolVersion: LINKED_SYNC_PROTOCOL_VERSION + 1 }),
          ),
        ).toMatchObject({ status: 409, code: "invalid", check: "version" });
      }),
  );

  it.effect("lets only the copy that took over ask this one to give way", () =>
    Effect.gen(function* () {
      const { pair, m4, ref, refused } = yield* linked();
      const binding = {
        epoch: 1,
        state: "active" as const,
        operationId: "takeover:1",
        predecessor: pair.joining,
        takenOverAt: "2026-11-03T00:00:00.000Z",
      };
      expect(
        yield* refused((receiver) =>
          receiver.supersede(m4, { ...ref, successor: pair.joining, coordinatorBinding: binding }),
        ),
      ).toMatchObject({ code: "needs_grant" });
    }),
  );

  describe("member lists", () => {
    const later = {
      environmentId: EnvironmentId.make("m1"),
      projectId: ProjectId.make("easychamp-m1"),
      coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m1"),
    };

    it.effect("reports the members this copy lists in its digest", () =>
      Effect.gen(function* () {
        const { pair, m4, ref, onM3 } = yield* linked();
        const answer = yield* onM3((receiver) => receiver.digest(m4, ref));
        if (!answer.ok) return yield* Effect.die(answer.refusal);
        expect(answer.value.members?.map((member) => member.environmentId).toSorted()).toEqual([
          pair.joining.environmentId,
          pair.kept.environmentId,
        ]);
      }),
    );

    it.effect("adopts the list the copy it gave way to sends", () =>
      Effect.gen(function* () {
        const { pair, m4, ref, onM3 } = yield* linked();
        const answer = yield* onM3((receiver) =>
          receiver.members(m4, {
            ...ref,
            from: pair.kept,
            fromEpoch: 0,
            members: [pair.kept, pair.joining, later],
          }),
        );
        if (!answer.ok) return yield* Effect.die(answer.refusal);
        expect(answer.value).toEqual({ replayed: false, changed: true });
        expect(
          pair.m3.projects
            .get(pair.joining.projectId)!
            .workspaceSettings!.logicalProject!.members.map((member) => member.environmentId)
            .toSorted(),
        ).toEqual(["m1", "m3", "m4"]);
      }),
    );
  });

  describe("personal assistant sync gating", () => {
    it.effect("allows digest for own linked personal assistant and refuses non-memory routes", () =>
      Effect.gen(function* () {
        const { pair, ref, onM3 } = yield* linked();
        const current = pair.m3.projects.get(pair.joining.projectId)!;
        pair.m3.projects.set(pair.joining.projectId, {
          ...current,
          workspaceSettings: {
            ...current.workspaceSettings!,
            kind: "personal",
          },
        });
        const ownCaller: ReceiverCaller = {
          sourceEnvironmentId: pair.kept.environmentId,
          grant: {
            coordinatorEnvironmentId: pair.kept.environmentId,
            kind: "own",
            owner: "self",
            legacy: false,
            revoked: false,
            maxRuntimeMode: "full-access",
            projects: { kind: "none" },
            accounts: { kind: "all" },
          } as unknown as EffectiveWorkGrant,
          runtimeCeiling: "full-access",
          cloudUserId: "user_anton_123",
        };
        // Without a local CloudLink in context, localCloudUserId is null -> refused
        const withoutCloud = yield* onM3((receiver) => receiver.digest(ownCaller, ref));
        expect(withoutCloud.ok).toBe(false);
        if (!withoutCloud.ok) expect(withoutCloud.refusal.code).toBe("needs_grant");

        // Team grant is always refused
        const teamCaller: ReceiverCaller = {
          ...ownCaller,
          grant: {
            ...(ownCaller.grant as unknown as Record<string, unknown>),
            kind: "team",
            owner: "member",
          } as unknown as EffectiveWorkGrant,
        };
        const teamResult = yield* onM3((receiver) => receiver.digest(teamCaller, ref));
        expect(teamResult.ok).toBe(false);
        if (!teamResult.ok) expect(teamResult.refusal.code).toBe("needs_grant");
      }),
    );
  });
});
