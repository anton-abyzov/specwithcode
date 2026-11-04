import {
  EnvironmentId,
  type Project,
  ProjectId,
  ProjectPlanError,
  ThreadId,
} from "@specweave-studio/contracts";
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
import { coordinatorContentDigest } from "./ProjectLink.ts";
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
  it.effect("answers a listed copy's digest exchange with this copy's state", () =>
    Effect.gen(function* () {
      const { pair, m4, ref, onM3 } = yield* linked();
      const answer = yield* onM3((receiver) => receiver.digest(m4, ref));
      if (!answer.ok) return yield* Effect.die(answer.refusal);
      expect(answer.value).toMatchObject({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        member: { environmentId: pair.joining.environmentId, projectId: pair.joining.projectId },
        binding: { state: "transferred" },
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

  it.effect(
    "keeps the coordinator's pushed content, marked as a peer's copy, and only from that machine",
    () =>
      Effect.gen(function* () {
        const { pair, m4, ref, onM3, refused } = yield* linked();
        const content = {
          goal: "Ship",
          instructions: "Carefully",
          notes: [],
          notesTruncated: false,
        };
        const push = {
          ...ref,
          ...content,
          digest: coordinatorContentDigest(content),
          from: pair.kept,
          fromEpoch: 0,
        };
        // Another member may not push the coordinator's content in its name.
        expect(
          yield* refused((receiver) => receiver.replica(callerFrom("m3", { kind: "all" }), push)),
        ).toMatchObject({ code: "needs_grant" });
        expect(
          yield* refused((receiver) => receiver.replica(m4, { ...push, from: pair.joining })),
        ).toMatchObject({ code: "needs_grant" });
        expect(
          yield* refused((receiver) => receiver.replica(m4, { ...push, digest: "0".repeat(64) })),
        ).toMatchObject({ status: 409, code: "invalid" });
        const answer = yield* onM3((receiver) => receiver.replica(m4, push));
        if (!answer.ok) return yield* Effect.die(answer.refusal);
        expect(answer.value.replayed).toBe(false);
        expect(pair.m3.replicas.get(pair.joining.projectId)).toMatchObject({
          from: { environmentId: pair.kept.environmentId, projectId: pair.kept.projectId },
          fromEpoch: 0,
          goal: "Ship",
          peer: { clientGoalDigest: null, instructionsChangedAt: null },
        });
        const again = yield* onM3((receiver) => receiver.replica(m4, push));
        if (!again.ok) return yield* Effect.die(again.refusal);
        expect(again.value.replayed).toBe(true);
      }),
  );

  it.effect("serves the coordinator's content only from a copy that coordinates", () =>
    Effect.gen(function* () {
      const { m4, ref, refused } = yield* linked();
      expect(yield* refused((receiver) => receiver.content(m4, ref))).toMatchObject({
        status: 409,
        code: "invalid",
      });
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

  it.effect("takes a replica from another member only one epoch past the copy it gave way to", () =>
    Effect.gen(function* () {
      const { pair, ref, onM3, refused } = yield* linked();
      const m1 = {
        environmentId: EnvironmentId.make("m1"),
        projectId: ProjectId.make("easychamp-m1"),
        coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m1"),
      };
      const held = pair.m3.projects.get(pair.joining.projectId)!;
      const settings = held.workspaceSettings!;
      pair.m3.projects.set(pair.joining.projectId, {
        ...held,
        workspaceSettings: {
          ...settings,
          logicalProject: {
            ...settings.logicalProject!,
            members: [...settings.logicalProject!.members, m1],
          },
        },
      } as Project);
      const epoch = settings.coordinatorBinding!.epoch;
      const content = { goal: "Mine", instructions: "", notes: [], notesTruncated: false };
      const push = (fromEpoch: number) => ({
        ...ref,
        ...content,
        digest: coordinatorContentDigest(content),
        from: m1,
        fromEpoch,
      });
      const asM1 = callerFrom("m1", { kind: "all" });
      // Its own claim of a takeover far ahead, or at the known epoch, is not taken.
      expect(
        yield* refused((receiver) => receiver.replica(asM1, push(epoch + 1000))),
      ).toMatchObject({ status: 409, code: "invalid" });
      expect(yield* refused((receiver) => receiver.replica(asM1, push(epoch)))).toMatchObject({
        status: 409,
        code: "invalid",
      });
      expect(pair.m3.replicas.get(pair.joining.projectId)).toBeUndefined();
      const answer = yield* onM3((receiver) => receiver.replica(asM1, push(epoch + 1)));
      if (!answer.ok) return yield* Effect.die(answer.refusal);
      expect(pair.m3.replicas.get(pair.joining.projectId)).toMatchObject({
        goal: "Mine",
        fromEpoch: epoch + 1,
      });
    }),
  );

  it.effect("gives way only after the copy that took over confirms the takeover", () =>
    Effect.gen(function* () {
      const takeover = (pair: ReturnType<typeof legacyPair>) => ({
        epoch: 1,
        state: "active" as const,
        operationId: "takeover:1",
        predecessor: pair.joining,
        takenOverAt: "2026-11-03T00:00:00.000Z",
      });
      /** M3 coordinates again, as before M4 took over from it. */
      const coordinating = (pair: ReturnType<typeof legacyPair>) => {
        const held = pair.m3.projects.get(pair.joining.projectId)!;
        pair.m3.projects.set(pair.joining.projectId, {
          ...held,
          workspaceSettings: {
            ...held.workspaceSettings!,
            coordinatorBinding: { epoch: 0, state: "active" },
          },
        } as Project);
      };
      let answer: (pair: ReturnType<typeof legacyPair>) => LinkedDigestResponse;
      let current: ReturnType<typeof legacyPair> | undefined;
      const fromM4 = () =>
        current === undefined
          ? Effect.fail(
              new HandoffPeerError({ code: "unreachable", message: "No.", uncertain: false }),
            )
          : Effect.succeed(answer(current));
      const describedAs = (
        pair: ReturnType<typeof legacyPair>,
        binding: LinkedDigestResponse["binding"],
      ): LinkedDigestResponse => ({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        member: pair.kept,
        binding,
        coordinatorDigest: "0".repeat(64),
        replica: null,
        memoryDigest: null,
        planDigest: null,
      });

      // No route to confirm it: this copy keeps coordinating.
      const unconfirmed = yield* linked();
      coordinating(unconfirmed.pair);
      expect(
        yield* unconfirmed.refused((receiver) =>
          receiver.supersede(unconfirmed.m4, {
            ...unconfirmed.ref,
            successor: unconfirmed.pair.kept,
            coordinatorBinding: takeover(unconfirmed.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });

      // M4 holds another binding than the one it claims.
      const forged = yield* linked(fromM4);
      current = forged.pair;
      coordinating(forged.pair);
      answer = (pair) => describedAs(pair, { epoch: 0, state: "transferred" });
      expect(
        yield* forged.refused((receiver) =>
          receiver.supersede(forged.m4, {
            ...forged.ref,
            successor: forged.pair.kept,
            coordinatorBinding: takeover(forged.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });
      expect(
        forged.pair.m3.projects.get(forged.pair.joining.projectId)?.workspaceSettings
          ?.coordinatorBinding?.state,
      ).toBe("active");

      // M4 really took over: M3 gives way.
      const confirmed = yield* linked(fromM4);
      current = confirmed.pair;
      coordinating(confirmed.pair);
      answer = (pair) => describedAs(pair, takeover(pair));
      const result = yield* confirmed.onM3((receiver) =>
        receiver.supersede(confirmed.m4, {
          ...confirmed.ref,
          successor: confirmed.pair.kept,
          coordinatorBinding: takeover(confirmed.pair),
        }),
      );
      if (!result.ok) return yield* Effect.die(result.refusal);
      expect(result.value.coordinatorBinding).toMatchObject({ state: "transferred", epoch: 1 });
      // The copy that took over learns the members this one lists.
      expect(result.value.members?.map((member) => member.environmentId).toSorted()).toEqual([
        "m3",
        "m4",
      ]);

      // Only M4 holds a grant (on M3): M3 cannot ask M4 back, so M4's own word, sent with
      // its grant here, stands, and M3 gives way instead of coordinating beside it.
      const withoutGrant = (grant: "none" | "revoked" | "expired") => () =>
        Effect.fail(
          new HandoffPeerError({
            code: "needs_grant",
            message: "M4: this machine has no work grant there",
            check: "grant",
            uncertain: false,
            local: true,
            grant,
          }),
        );
      const noGrant = withoutGrant("none");
      const oneWay = yield* linked(noGrant);
      coordinating(oneWay.pair);
      const gaveWay = yield* oneWay.onM3((receiver) =>
        receiver.supersede(oneWay.m4, {
          ...oneWay.ref,
          successor: oneWay.pair.kept,
          coordinatorBinding: takeover(oneWay.pair),
        }),
      );
      if (!gaveWay.ok) return yield* Effect.die(gaveWay.refusal);
      expect(gaveWay.value.coordinatorBinding).toMatchObject({ state: "transferred", epoch: 1 });

      // A missing grant never lets another machine claim a takeover for a third copy.
      const thirdParty = yield* linked(noGrant);
      coordinating(thirdParty.pair);
      expect(
        yield* thirdParty.refused((receiver) =>
          receiver.supersede(thirdParty.m4, {
            ...thirdParty.ref,
            successor: thirdParty.pair.kept,
            coordinatorBinding: { ...takeover(thirdParty.pair), predecessor: thirdParty.pair.kept },
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });

      // Whatever keeps M3 from ever asking M4 back (its grant there revoked or expired, M4 not
      // in its fleet, M4 refusing M3's grant), M4's own word, sent with the grant M3 issued to
      // it, stands: two coordinators never stay active for want of a callback.
      const cannotAsk: ReadonlyArray<HandoffPeerError> = [
        ...(["revoked", "expired"] as const).map(
          (grant) =>
            new HandoffPeerError({
              code: "needs_grant",
              message: "M4: no grant",
              check: "grant",
              uncertain: false,
              local: true,
              grant,
            }),
        ),
        new HandoffPeerError({
          code: "invalid",
          message: "That machine is not one of your private machines.",
          uncertain: false,
          local: true,
        }),
        new HandoffPeerError({ code: "needs_grant", message: "Refused.", uncertain: false }),
      ];
      for (const error of cannotAsk) {
        const cut = yield* linked(() => Effect.fail(error));
        coordinating(cut.pair);
        const result = yield* cut.onM3((receiver) =>
          receiver.supersede(cut.m4, {
            ...cut.ref,
            successor: cut.pair.kept,
            coordinatorBinding: takeover(cut.pair),
          }),
        );
        if (!result.ok) return yield* Effect.die(result.refusal);
        expect(result.value.coordinatorBinding).toMatchObject({ state: "transferred", epoch: 1 });
      }

      // No answer, or an answer M3 cannot read, may come from a live M4 that would answer
      // otherwise: M3 refuses for now and M4 tries again, rather than taking its word.
      for (const error of [
        new HandoffPeerError({ code: "unreachable", message: "No answer.", uncertain: true }),
        new HandoffPeerError({ code: "unreachable", message: "No answer.", uncertain: false }),
      ]) {
        const silent = yield* linked(() => Effect.fail(error));
        coordinating(silent.pair);
        expect(
          yield* silent.refused((receiver) =>
            receiver.supersede(silent.m4, {
              ...silent.ref,
              successor: silent.pair.kept,
              coordinatorBinding: takeover(silent.pair),
            }),
          ),
        ).toMatchObject({ status: 409, code: "busy" });
        expect(
          silent.pair.m3.projects.get(silent.pair.joining.projectId)?.workspaceSettings
            ?.coordinatorBinding?.state,
        ).toBe("active");
      }

      // A copy that already gave way to another copy never moves to M4 on M4's word alone.
      const elsewhere = yield* linked(noGrant);
      const elsewhereHeld = elsewhere.pair.m3.projects.get(elsewhere.pair.joining.projectId)!;
      elsewhere.pair.m3.projects.set(elsewhere.pair.joining.projectId, {
        ...elsewhereHeld,
        workspaceSettings: {
          ...elsewhereHeld.workspaceSettings!,
          coordinatorBinding: {
            epoch: 0,
            state: "transferred",
            successor: {
              environmentId: EnvironmentId.make("m1"),
              projectId: ProjectId.make("easychamp-m1"),
            },
          },
        },
      } as Project);
      expect(
        yield* elsewhere.refused((receiver) =>
          receiver.supersede(elsewhere.m4, {
            ...elsewhere.ref,
            successor: elsewhere.pair.kept,
            coordinatorBinding: takeover(elsewhere.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });

      // M4 answers, but refuses the copy outright: that is not taken as its word.
      const contradicted = yield* linked(() =>
        Effect.fail(new HandoffPeerError({ code: "failed", message: "No.", uncertain: false })),
      );
      coordinating(contradicted.pair);
      expect(
        yield* contradicted.refused((receiver) =>
          receiver.supersede(contradicted.m4, {
            ...contradicted.ref,
            successor: contradicted.pair.kept,
            coordinatorBinding: takeover(contradicted.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "busy" });

      // Unconfirmed, forged or replayed claims are refused: an epoch not above this copy's,
      // a successor this copy does not list, and a claim sent for another copy than the caller's.
      const notHigher = yield* linked(noGrant);
      coordinating(notHigher.pair);
      const notHigherHeld = notHigher.pair.m3.projects.get(notHigher.pair.joining.projectId)!;
      notHigher.pair.m3.projects.set(notHigher.pair.joining.projectId, {
        ...notHigherHeld,
        workspaceSettings: {
          ...notHigherHeld.workspaceSettings!,
          coordinatorBinding: { epoch: 1, state: "active" },
        },
      } as Project);
      expect(
        yield* notHigher.refused((receiver) =>
          receiver.supersede(notHigher.m4, {
            ...notHigher.ref,
            successor: notHigher.pair.kept,
            coordinatorBinding: takeover(notHigher.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });
      const unlisted = yield* linked(noGrant);
      coordinating(unlisted.pair);
      const stranger = { ...unlisted.pair.kept, projectId: ProjectId.make("not-listed") };
      expect(
        yield* unlisted.refused((receiver) =>
          receiver.supersede(unlisted.m4, {
            ...unlisted.ref,
            successor: stranger,
            coordinatorBinding: takeover(unlisted.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });
      const impostor = yield* linked(noGrant);
      coordinating(impostor.pair);
      expect(
        yield* impostor.refused((receiver) =>
          receiver.supersede(callerFrom("m1", { kind: "all" }), {
            ...impostor.ref,
            successor: impostor.pair.kept,
            coordinatorBinding: takeover(impostor.pair),
          }),
        ),
      ).toMatchObject({ status: 403, code: "needs_grant" });

      // Unconfirmed, a claim must be a whole takeover made after this copy's own one began.
      const stale = yield* linked(noGrant);
      coordinating(stale.pair);
      const staleHeld = stale.pair.m3.projects.get(stale.pair.joining.projectId)!;
      stale.pair.m3.projects.set(stale.pair.joining.projectId, {
        ...staleHeld,
        workspaceSettings: {
          ...staleHeld.workspaceSettings!,
          coordinatorBinding: {
            epoch: 0,
            state: "active",
            takenOverAt: "2026-11-03T01:00:00.000Z",
          },
        },
      } as Project);
      expect(
        yield* stale.refused((receiver) =>
          receiver.supersede(stale.m4, {
            ...stale.ref,
            successor: stale.pair.kept,
            coordinatorBinding: takeover(stale.pair),
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });
      const partial = yield* linked(noGrant);
      coordinating(partial.pair);
      const { operationId: _dropped, ...withoutOperation } = takeover(partial.pair);
      expect(
        yield* partial.refused((receiver) =>
          receiver.supersede(partial.m4, {
            ...partial.ref,
            successor: partial.pair.kept,
            coordinatorBinding: withoutOperation,
          }),
        ),
      ).toMatchObject({ status: 409, code: "invalid" });
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

    it.effect(
      "refuses an unlisted caller, a list in another machine's name and another version",
      () =>
        Effect.gen(function* () {
          const { pair, m4, ref, refused } = yield* linked();
          const request = {
            ...ref,
            from: pair.kept,
            fromEpoch: 0,
            members: [pair.kept, pair.joining, later],
          };
          expect(
            yield* refused((receiver) =>
              receiver.members(callerFrom("m1", { kind: "all" }), { ...request, from: later }),
            ),
          ).toMatchObject({ status: 403, code: "needs_grant" });
          expect(
            yield* refused((receiver) => receiver.members(m4, { ...request, from: later })),
          ).toMatchObject({ status: 403, code: "needs_grant" });
          expect(
            yield* refused((receiver) =>
              receiver.members(m4, {
                ...request,
                protocolVersion: LINKED_SYNC_PROTOCOL_VERSION + 1,
              }),
            ),
          ).toMatchObject({ status: 409, check: "version" });
          // A list that leaves this copy out is refused, and nothing changes.
          expect(
            yield* refused((receiver) =>
              receiver.members(m4, { ...request, members: [pair.kept, later] }),
            ),
          ).toMatchObject({ status: 409, code: "invalid" });
          expect(
            pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings!.logicalProject!
              .members,
          ).toHaveLength(2);
        }),
    );
  });
});
