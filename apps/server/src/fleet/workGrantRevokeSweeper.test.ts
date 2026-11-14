import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { continuationThreadId } from "../handoff/HandoffReceiver.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { workerClientName } from "./workerGrantMint.ts";
import { sweepRevoked } from "./workGrantRevokeSweeper.ts";
import * as WorkGrants from "./WorkGrants.ts";

const M4 = EnvironmentId.make("env-m4");
const M1 = EnvironmentId.make("env-m1");

const shell = (id: string, running: boolean) =>
  ({
    id: ThreadId.make(id),
    projectId: "project",
    activeRunId: running ? "run" : null,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

/** The thread a handoff from M4 continues here, at the id the receiver gives it. */
const CONTINUATION = continuationThreadId(M4, "thread-on-m4", 2);

const setup = (
  principal: {
    /** Each setPrincipalRevoked call's revoked value, in order. */
    readonly calls: Array<boolean>;
    /** Fails the call when true. */
    readonly fail?: () => boolean;
  } = { calls: [] },
) => {
  const interrupted: Array<{ threadId: string; commandId: string }> = [];
  const shells = new Map([
    [CONTINUATION as string, shell(CONTINUATION, true)],
    ["from-m4-running", shell("from-m4-running", true)],
    ["from-m4-idle", shell("from-m4-idle", false)],
    ["from-m1-running", shell("from-m1-running", true)],
  ]);
  const layer = WorkGrants.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          setPrincipalRevoked: (_principal, revoked) =>
            Effect.yieldNow.pipe(
              Effect.andThen(() => {
                principal.calls.push(revoked);
                return principal.fail?.() === true
                  ? Effect.fail(new Error("store unavailable") as never)
                  : Effect.void;
              }),
            ),
          listSessions: () =>
            Effect.succeed(
              [M4, M1].map((coordinator) => ({
                sessionId: AuthSessionId.make(`session-${coordinator}`),
                principal: { kind: "coordinator", environmentId: coordinator },
                subject: EnvironmentAuth.MCP_CLIENT_SUBJECT,
                client: { label: workerClientName(coordinator), deviceType: "bot" },
              })) as never,
            ),
          revokeSession: () => Effect.succeed(true),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
          interruptThread: (input) =>
            Effect.sync(() => {
              interrupted.push({ threadId: input.threadId, commandId: input.commandId });
              return { type: "no_active_run" as const };
            }),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "studio-work-grant-sweep-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  );
  return { layer, interrupted };
};

describe("revoking a machine's work", () => {
  it.effect("interrupts only that machine's running threads, and only after the grace", () => {
    const { layer, interrupted } = setup();
    return Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      for (const [threadId, coordinator] of [
        ["from-m4-running", M4],
        ["from-m4-idle", M4],
        ["from-m1-running", M1],
      ] as const)
        yield* grants.recordOrigin(ThreadId.make(threadId), {
          coordinatorEnvironmentId: coordinator,
          path: [coordinator],
          hops: 1,
        });
      yield* grants.revoke(M4);
      // During the grace the work keeps running.
      yield* TestClock.adjust("119 seconds");
      expect(yield* sweepRevoked).toBe(0);
      expect(interrupted).toEqual([]);
      yield* TestClock.adjust("2 seconds");
      expect(yield* sweepRevoked).toBe(1);
      expect(interrupted.map((entry) => entry.threadId)).toEqual(["from-m4-running"]);
      // Done once: a later sweep (or one after a restart) does not repeat it.
      expect(yield* sweepRevoked).toBe(0);
      expect(
        (yield* grants.policies).find((policy) => policy.coordinatorEnvironmentId === M4)
          ?.interruptedAt,
      ).not.toBeNull();
      // Restoring and revoking again starts a new grace.
      yield* grants.restore(M4);
      yield* grants.revoke(M4);
      expect(yield* sweepRevoked).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("interrupts a continuation handed off from the revoked machine", () => {
    const { layer, interrupted } = setup();
    return Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      // What the receiver records for a takeover under M4's grant.
      yield* grants.recordOrigin(CONTINUATION, {
        coordinatorEnvironmentId: M4,
        path: [M4],
        hops: 1,
      });
      yield* grants.revoke(M4);
      yield* TestClock.adjust("119 seconds");
      expect(yield* sweepRevoked).toBe(0);
      yield* TestClock.adjust("2 seconds");
      expect(yield* sweepRevoked).toBe(1);
      expect(interrupted.map((entry) => entry.threadId)).toEqual([CONTINUATION]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ends a grant at its time limit like a Stop, and Allow starts a fresh period", () => {
    const { layer, interrupted } = setup();
    return Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      yield* grants.recordOrigin(ThreadId.make("from-m4-running"), {
        coordinatorEnvironmentId: M4,
        path: [M4],
        hops: 1,
      });
      yield* grants.update({ coordinatorEnvironmentId: M4, duration: "1h" });
      expect((yield* grants.forCoordinator(M4)).revoked).toBe(false);
      yield* TestClock.adjust("59 minutes");
      expect(yield* sweepRevoked).toBe(0);
      expect((yield* grants.forCoordinator(M4)).revoked).toBe(false);
      // Past the limit it is refused at once, before any sweep records it.
      yield* TestClock.adjust("1 minute");
      expect((yield* grants.forCoordinator(M4)).revoked).toBe(true);
      // The sweep turns it into a revoke; its threads stop after the usual grace.
      expect(yield* sweepRevoked).toBe(0);
      const policy = (yield* grants.policies).find(
        (entry) => entry.coordinatorEnvironmentId === M4,
      );
      expect(policy?.revokedAt).not.toBeNull();
      expect(policy?.interruptAt).not.toBeNull();
      yield* TestClock.adjust("121 seconds");
      expect(yield* sweepRevoked).toBe(1);
      expect(interrupted.map((entry) => entry.threadId)).toEqual(["from-m4-running"]);
      // M1 had no limit and is untouched.
      expect((yield* grants.forCoordinator(M1)).revoked).toBe(false);
      // Restore lifts a Stop only; an ended grant needs a new limit.
      const restored = yield* grants.restore(M4).pipe(Effect.flip);
      expect(restored.reason).toBe("ended");
      yield* grants.update({ coordinatorEnvironmentId: M4, duration: "1d" });
      expect((yield* grants.forCoordinator(M4)).revoked).toBe(false);
      yield* grants.update({ coordinatorEnvironmentId: M4, duration: "until-stopped" });
      yield* TestClock.adjust("30 days");
      expect(yield* sweepRevoked).toBe(0);
      expect((yield* grants.forCoordinator(M4)).revoked).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retries the sign-in revoke a failed sweep left behind", () => {
    let failing = true;
    const principal = { calls: [] as Array<boolean>, fail: () => failing };
    const { layer } = setup(principal);
    return Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      failing = false;
      yield* grants.update({ coordinatorEnvironmentId: M4, duration: "1h" });
      failing = true;
      yield* TestClock.adjust("61 minutes");
      yield* sweepRevoked;
      const pendingAfterFailure = (yield* grants.policies).find(
        (entry) => entry.coordinatorEnvironmentId === M4,
      );
      expect(pendingAfterFailure?.revokedAt).not.toBeNull();
      expect(pendingAfterFailure?.principalPending).toBe(true);
      failing = false;
      yield* sweepRevoked;
      expect(principal.calls.at(-1)).toBe(true);
      const settled = (yield* grants.policies).find(
        (entry) => entry.coordinatorEnvironmentId === M4,
      );
      expect(settled?.principalPending).toBeUndefined();
      const before = principal.calls.length;
      yield* sweepRevoked;
      // Settled: later sweeps leave the sign-ins alone.
      expect(principal.calls.length).toBe(before);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never leaves a fresh Allow's sign-ins revoked when it races the expiry sweep", () => {
    const principal = { calls: [] as Array<boolean> };
    const { layer } = setup(principal);
    return Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      yield* grants.update({ coordinatorEnvironmentId: M4, duration: "1h" });
      yield* TestClock.adjust("61 minutes");
      yield* Effect.all(
        [sweepRevoked, grants.update({ coordinatorEnvironmentId: M4, duration: "1d" })],
        { concurrency: "unbounded" },
      );
      const policy = (yield* grants.policies).find(
        (entry) => entry.coordinatorEnvironmentId === M4,
      );
      expect(policy?.revokedAt).toBeNull();
      expect(policy?.principalPending).toBeUndefined();
      expect(principal.calls.at(-1)).toBe(false);
      expect((yield* grants.forCoordinator(M4)).revoked).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
