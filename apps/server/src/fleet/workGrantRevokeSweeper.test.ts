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

const setup = () => {
  const interrupted: Array<{ threadId: string; commandId: string }> = [];
  const shells = new Map([
    ["from-m4-running", shell("from-m4-running", true)],
    ["from-m4-idle", shell("from-m4-idle", false)],
    ["from-m1-running", shell("from-m1-running", true)],
  ]);
  const layer = WorkGrants.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          listSessions: () =>
            Effect.succeed(
              [M4, M1].map((coordinator) => ({
                sessionId: AuthSessionId.make(`session-${coordinator}`),
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
});
