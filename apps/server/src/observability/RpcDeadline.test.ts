import { assert, describe, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RPC_DEADLINE, RpcDeadline, rpcDeadlineLayer } from "./RpcDeadline.ts";

type WsRpcMethod = keyof typeof RPC_REQUIRED_SCOPES;

/** The server group narrowed to `tags`, with the deadline installed as ws.ts installs it. */
const groupOf = <const Tags extends ReadonlyArray<WsRpcMethod>>(...tags: Tags) =>
  WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsRpcMethod, Tags[number]> =>
        !(tags as ReadonlyArray<string>).includes(tag),
    ),
  ).middleware(RpcDeadline);

const projectId = ProjectId.make("project-deadline");
const connection = Layer.merge(
  RpcAuthorization.layer([AuthOrchestrationReadScope, AuthFilesystemReadScope]),
  rpcDeadlineLayer,
);

/** The failure must encode with the RPC's own exit schema, or a real client could not decode it. */
const encodesForClient = (tag: WsRpcMethod, exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeUnknownSync(Rpc.exitSchema(WsRpcGroup.requests.get(tag)!))(exit);

/** A typed failure as plain fields, or null for a success. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return null;
  const error = Exit.findErrorOption(exit);
  return error._tag === "Some" ? { ...(error.value as object) } : "not a typed failure";
};

describe("WS RPC deadline middleware", () => {
  it.effect("answers a stalled idempotent read at the deadline and leaves other calls alone", () =>
    Effect.gen(function* () {
      const group = groupOf(
        WS_METHODS.projectsThreadIncrementProgressRead,
        WS_METHODS.projectsWorkspaceRead,
        WS_METHODS.pullRequestsLinkedThreads,
        WS_METHODS.serverReportClientActivity,
        WS_METHODS.serverProbe,
      );
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(
              WS_METHODS.projectsThreadIncrementProgressRead,
              () => Effect.never,
            ),
            group.toLayerHandler(WS_METHODS.projectsWorkspaceRead, () => Effect.never),
            group.toLayerHandler(WS_METHODS.pullRequestsLinkedThreads, () => Effect.never),
            group.toLayerHandler(WS_METHODS.serverReportClientActivity, () => Effect.never),
            // Not listed: it may take as long as it takes.
            group.toLayerHandler(WS_METHODS.serverProbe, () =>
              Effect.sleep(Duration.minutes(5)).pipe(Effect.as({})),
            ),
            connection,
          ),
        ),
      );

      const progress = yield* client[WS_METHODS.projectsThreadIncrementProgressRead]({
        projectId,
        threadIds: [ThreadId.make("thread-a")],
      }).pipe(Effect.exit, Effect.forkChild);
      const workspace = yield* client[WS_METHODS.projectsWorkspaceRead]({ projectId }).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      const linked = yield* client[WS_METHODS.pullRequestsLinkedThreads]({
        projectId,
        repository: "acme/app",
        number: 7,
      }).pipe(Effect.exit, Effect.forkChild);
      const activity = yield* client[WS_METHODS.serverReportClientActivity]({
        clientId: "client-deadline",
        clientKind: "web",
        visible: true,
        focused: true,
        recentlyInteracted: false,
        scopes: [],
        observedAt: yield* DateTime.now,
      }).pipe(Effect.exit, Effect.forkChild);
      const probe = yield* client[WS_METHODS.serverProbe]({}).pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.subtract(RPC_DEADLINE, Duration.millis(1)));
      for (const [index, fiber] of [progress, workspace, linked, activity, probe].entries()) {
        assert.isUndefined(fiber.pollUnsafe(), `call ${index} answered before the deadline`);
      }

      yield* TestClock.adjust(Duration.millis(1));
      const answered: ReadonlyArray<readonly [WsRpcMethod, Exit.Exit<unknown, unknown>]> = [
        [WS_METHODS.projectsThreadIncrementProgressRead, yield* Fiber.join(progress)],
        [WS_METHODS.projectsWorkspaceRead, yield* Fiber.join(workspace)],
        [WS_METHODS.pullRequestsLinkedThreads, yield* Fiber.join(linked)],
        [WS_METHODS.serverReportClientActivity, yield* Fiber.join(activity)],
      ];
      assert.deepStrictEqual(
        answered.map(([tag, exit]) => [tag, failureOf(exit)]),
        [
          [
            WS_METHODS.projectsThreadIncrementProgressRead,
            { _tag: "ProjectWorkspaceError", code: "operation_failed", projectId },
          ],
          [
            WS_METHODS.projectsWorkspaceRead,
            { _tag: "ProjectWorkspaceError", code: "operation_failed", projectId },
          ],
          [
            WS_METHODS.pullRequestsLinkedThreads,
            {
              _tag: "PullRequestOperationError",
              operation: "linkedThreads",
              detail: "Reading the linked threads took too long. Try again.",
            },
          ],
          // A report just succeeds.
          [WS_METHODS.serverReportClientActivity, null],
        ],
      );
      for (const [tag, exit] of answered) encodesForClient(tag, exit);

      // The unlisted call is still running, and finishes on its own time.
      assert.isUndefined(probe.pollUnsafe());
      yield* TestClock.adjust(Duration.minutes(5));
      assert.deepStrictEqual(yield* Fiber.join(probe), Exit.succeed({}));
    }).pipe(Effect.scoped),
  );

  it.effect("passes through a listed read that answers in time", () =>
    Effect.gen(function* () {
      const group = groupOf(WS_METHODS.projectsWorkspaceRead);
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.projectsWorkspaceRead, () =>
              Effect.sleep(Duration.seconds(5)).pipe(
                Effect.andThen(Effect.die("reached the handler result")),
              ),
            ),
            connection,
          ),
        ),
      );
      const read = yield* client[WS_METHODS.projectsWorkspaceRead]({ projectId }).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      // The handler's own outcome reaches the caller, not the deadline's answer.
      assert.isTrue(Exit.hasDies(yield* Fiber.join(read)));
    }).pipe(Effect.scoped),
  );
});
