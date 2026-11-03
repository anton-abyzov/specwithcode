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
    }),
  );
});
