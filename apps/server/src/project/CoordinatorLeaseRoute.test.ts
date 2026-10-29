import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type { StudioWorkGrantProjects } from "@specweave-studio/contracts/studioFleet";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  COORDINATOR_LEASE_PROTOCOL_VERSION,
  type CoordinatorLeaseRequest,
} from "../handoff/handoffWire.ts";
import * as CoordinatorLeaseRoute from "./CoordinatorLeaseRoute.ts";
import { coordinatorContentDigest } from "./ProjectLink.ts";
import { legacyPair, link, removeCheckouts } from "./ProjectLink.testkit.ts";

afterEach(removeCheckouts);

const standbyId = "55555555-5555-4555-8555-555555555555";

const callerFrom = (environment: string, projects: StudioWorkGrantProjects): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects,
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

/** M4 coordinates; its M3 copy is armed as the standby, with a grant listing that copy. */
const armed = async () => {
  const pair = legacyPair();
  const { prepared } = await link(pair);
  const logicalProjectId = prepared.logicalProject.id;
  await pair.m4.run((service) =>
    service.setStandby({
      operationId: standbyId,
      projectId: pair.kept.projectId,
      standby: { member: pair.joining, afterMinutes: 15 },
    }),
  );
  await pair.m3.run((service) =>
    service.acceptStandby({
      projectId: pair.joining.projectId,
      logicalProjectId,
      standby: { coordinator: pair.kept, epoch: 0, afterMinutes: 15 },
    }),
  );
  const { digest } = await pair.m4.run((service) =>
    service.digest({ projectId: pair.kept.projectId }),
  );
  const m4 = callerFrom("m4", { kind: "listed", projectIds: [pair.joining.projectId] });
  const request = (patch: Partial<CoordinatorLeaseRequest> = {}): CoordinatorLeaseRequest => ({
    protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
    kind: "lease",
    logicalProjectId,
    epoch: 0,
    seq: 1,
    afterMinutes: 15,
    contentDigest: digest,
    runningThreads: [{ threadId: pair.kept.coordinatorThreadId, title: "Coordinator" }],
    workers: [],
    ...patch,
  });
  /** Runs one call on the M3 receiver; a refusal comes back as the value. */
  const onM3 = <A>(
    use: (
      receiver: CoordinatorLeaseRoute.CoordinatorLeaseReceiver["Service"],
    ) => Effect.Effect<A, HandoffRefusal>,
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* use(yield* CoordinatorLeaseRoute.CoordinatorLeaseReceiver);
      }).pipe(Effect.provide(CoordinatorLeaseRoute.layer.pipe(Layer.provideMerge(pair.m3.layer)))),
    ).then((exit) => {
      if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      if (failure === undefined) throw new Error("The receiver died.");
      return { ok: false as const, refusal: failure.error as HandoffRefusal };
    });
  const record = () => pair.m3.standby.get(logicalProjectId);
  return { pair, logicalProjectId, digest, m4, request, onM3, record };
};

describe("CoordinatorLeaseReceiver", () => {
  it("accepts a lease only from the registered coordinator, in its scope, epoch and order", async () => {
    const { pair, m4, request, onM3, record } = await armed();
    const before = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const first = await onM3((receiver) => receiver.lease(m4, request({ seq: 5 })));
    if (!first.ok) throw first.refusal;
    expect(first.value).toMatchObject({
      takenOver: null,
      wantsContent: true,
      standbySleeping: false,
    });
    // The receive time is the standby's own, and the lease starts the watch.
    expect(Date.parse(first.value.receivedAt)).toBeGreaterThanOrEqual(before);
    expect(record()).toMatchObject({
      lastLeaseAt: first.value.receivedAt,
      lastSeq: 5,
      leaseSinceWatching: true,
      runningThreads: [{ threadId: pair.kept.coordinatorThreadId, title: "Coordinator" }],
    });

    const ignored = async (caller: ReceiverCaller, lease: CoordinatorLeaseRequest) => {
      const answer = await onM3((receiver) => receiver.lease(caller, lease));
      if (answer.ok) throw new Error("The lease was accepted.");
      return answer.refusal;
    };
    // Another machine with a broad grant is not the registered coordinator.
    const other = await ignored(callerFrom("m1", { kind: "all" }), request({ seq: 6 }));
    expect(other).toMatchObject({ status: 409, code: "invalid" });
    expect(record()?.lastRefusal?.reason).toBe("not-registered-coordinator");
    // An inflated epoch and a replayed sequence are ignored too.
    await ignored(m4, request({ epoch: 3, seq: 7 }));
    expect(record()?.lastRefusal?.reason).toBe("wrong-epoch");
    await ignored(m4, request({ seq: 5 }));
    expect(record()?.lastRefusal?.reason).toBe("stale-seq");
    expect(record()).toMatchObject({ lastSeq: 5, lastLeaseAt: first.value.receivedAt });
    // Another protocol version, or a pause that says nothing, is refused outright.
    expect(
      await ignored(m4, request({ protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION + 1 })),
    ).toMatchObject({ status: 409, check: "version" });
    expect(await ignored(m4, request({ kind: "pause", seq: 8 }))).toMatchObject({ status: 400 });

    // A planned pause is capped at 30 minutes from receipt.
    const paused = await onM3((receiver) =>
      receiver.lease(
        m4,
        request({ kind: "pause", seq: 9, pausedUntil: "2999-01-01T00:00:00.000Z" }),
      ),
    );
    if (!paused.ok) throw paused.refusal;
    expect(Date.parse(record()!.pausedUntil!) - Date.parse(paused.value.receivedAt)).toBe(
      30 * 60_000,
    );
  });

  it("asks for the content until it holds the coordinator's own copy", async () => {
    const { pair, m4, request, onM3, logicalProjectId, digest } = await armed();
    pair.m4.notes(pair.kept.projectId).set("decisions.md", { content: "Ship 2.0", revision: 1 });
    const owner = await pair.m4.run((service) =>
      service.preview({ projectId: pair.kept.projectId }),
    );
    const content = {
      goal: owner.goal,
      instructions: owner.instructions,
      notes: owner.notes,
      notesTruncated: owner.notesTruncated,
    };
    const contentDigest = coordinatorContentDigest(content);
    expect(contentDigest).not.toBe(digest);
    const push = (caller: ReceiverCaller) =>
      onM3((receiver) =>
        receiver.replica(caller, {
          protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
          logicalProjectId,
          epoch: 0,
          digest: contentDigest,
          ...content,
        }),
      );
    const stranger = await push(callerFrom("m1", { kind: "all" }));
    expect(stranger.ok).toBe(false);
    expect(pair.m3.replicas.size).toBe(0);
    const pushed = await push(m4);
    expect(pushed).toMatchObject({ ok: true, value: { replayed: false } });
    expect(pair.m3.replicas.get(pair.joining.projectId)).toMatchObject({
      from: pair.kept,
      digest: contentDigest,
      peer: { clientGoalDigest: null, instructionsChangedAt: null },
    });
    const lease = await onM3((receiver) => receiver.lease(m4, request({ contentDigest })));
    expect(lease).toMatchObject({ ok: true, value: { wantsContent: false } });
  });

  it("disarms on release, on a grant that no longer covers it, and on a revoked grant", async () => {
    const released = await armed();
    // A release at another epoch is ignored; at the registered one it disarms.
    expect(
      (
        await released.onM3((receiver) =>
          receiver.lease(released.m4, released.request({ kind: "release", epoch: 2 })),
        )
      ).ok,
    ).toBe(false);
    expect(released.record()).toBeDefined();
    const release = await released.onM3((receiver) =>
      receiver.lease(released.m4, released.request({ kind: "release" })),
    );
    expect(release).toMatchObject({ ok: true, value: { takenOver: null } });
    expect(released.record()).toBeUndefined();
    // Not armed any more: the coordinator hears the feature is gone here.
    expect(
      await released.onM3((receiver) => receiver.lease(released.m4, released.request())),
    ).toMatchObject({ ok: false, refusal: { status: 404, code: "not_found" } });

    const narrowed = await armed();
    const elsewhere = callerFrom("m4", {
      kind: "listed",
      projectIds: [ProjectId.make("another-project")],
    });
    expect(
      await narrowed.onM3((receiver) => receiver.lease(elsewhere, narrowed.request())),
    ).toMatchObject({ ok: false, refusal: { status: 403, code: "needs_grant" } });
    expect(narrowed.record()).toBeUndefined();

    const revoked = await armed();
    // Another machine's refused grant leaves this standby armed.
    await revoked.onM3((receiver) => receiver.grantRefused("m1"));
    expect(revoked.record()).toBeDefined();
    await revoked.onM3((receiver) => receiver.grantRefused("m4"));
    expect(revoked.record()).toBeUndefined();
  });

  it("answers the old coordinator with the new binding once it took over, and no one else", async () => {
    const { pair, m4, request, onM3, logicalProjectId, record } = await armed();
    const at = DateTime.toEpochMillis(DateTime.nowUnsafe()) - 20 * 60_000;
    const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
    pair.m3.standby.set(logicalProjectId, {
      ...record()!,
      lastLeaseAt: iso(at),
      lastSeq: 1,
      watchingSince: iso(at - 60_000),
      leaseSinceWatching: true,
    });
    const taken = await pair.m3.run((service) => service.autoTakeover({ logicalProjectId }));
    if (taken.outcome !== "taken-over") throw new Error(taken.outcome);
    const answer = await onM3((receiver) => receiver.lease(m4, request({ seq: 2 })));
    expect(answer).toMatchObject({
      ok: true,
      value: {
        takenOver: {
          coordinatorBinding: taken.result.coordinatorBinding,
          successor: { environmentId: "m3", projectId: pair.joining.projectId },
        },
      },
    });
    // A replayed or older lease still learns of it.
    expect(await onM3((receiver) => receiver.lease(m4, request({ seq: 1 })))).toMatchObject({
      ok: true,
      value: { takenOver: { coordinatorBinding: { takenOverBy: "auto" } } },
    });
    expect(
      await onM3((receiver) => receiver.lease(callerFrom("m1", { kind: "all" }), request())),
    ).toMatchObject({ ok: false, refusal: { status: 409 } });
  });
});
