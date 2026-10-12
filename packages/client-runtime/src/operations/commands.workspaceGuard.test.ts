import {
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { updateThreadMetadata } from "./commands.ts";

const layerCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
  }),
);
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("workspace-guard"),
  label: "Workspace guard",
  httpBaseUrl: "https://guard.example.test",
  wsBaseUrl: "wss://guard.example.test",
});

const makeSupervisor = Effect.fn(function* (commands: OrchestrationV2Command[]) {
  // Only the command transport is exercised; no native or browser connection exists.
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({} as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
});

describe("thread workspace command guards", () => {
  for (const observedPath of [null, "/repo/observed-worktree"]) {
    it.effect(
      `forwards the actual ${observedPath === null ? "null" : "non-null"} observation and empty guard`,
      () =>
        Effect.gen(function* () {
          const commands: OrchestrationV2Command[] = [];
          const supervisor = yield* makeSupervisor(commands);
          yield* updateThreadMetadata({
            threadId: ThreadId.make("thread"),
            branch: "main",
            worktreePath: null,
            expectedWorktreePath: observedPath,
            expectedEmpty: true,
          }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
          expect(commands).toHaveLength(1);
          expect(commands[0]).toMatchObject({
            type: "thread.metadata.update",
            branch: "main",
            worktreePath: null,
            expectedWorktreePath: observedPath,
            expectedEmpty: true,
          });
        }).pipe(Effect.provide(layerCrypto)),
    );
  }
  it.effect("keeps explicit manual updates unqualified", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      yield* updateThreadMetadata({
        threadId: ThreadId.make("thread"),
        branch: "manual",
        worktreePath: "/repo/manual",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(commands[0]).toMatchObject({
        type: "thread.metadata.update",
        branch: "manual",
        worktreePath: "/repo/manual",
      });
      expect(commands[0]).not.toHaveProperty("expectedEmpty");
      expect(commands[0]).not.toHaveProperty("expectedWorktreePath");
    }).pipe(Effect.provide(layerCrypto)),
  );
});
