import {
  ORCHESTRATION_V2_WS_METHODS,
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { SHELL_RESUME_COMPLETION_TIMEOUT_MS, makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const HTTP_SNAPSHOT: OrchestrationV2ShellSnapshot = { ...v2ShellSnapshot, snapshotSequence: 9 };

const CACHE = Persistence.EnvironmentCacheStore.of({
  loadShell: () => Effect.succeedNone,
  saveShell: () => Effect.void,
  loadThread: () => Effect.succeedNone,
  saveThread: () => Effect.void,
  removeThread: () => Effect.void,
  loadServerConfig: () => Effect.succeedNone,
  saveServerConfig: () => Effect.void,
  loadVcsRefs: () => Effect.succeedNone,
  saveVcsRefs: () => Effect.void,
  removeVcsRefs: () => Effect.void,
  clearVcsRefs: () => Effect.void,
  clear: () => Effect.void,
});

/** A connected machine whose list stream advertises the completion marker. */
const makeResumingShell = Effect.fn("makeResumingShell")(function* () {
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const subscribed = yield* SubscriptionRef.make(0);
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
      Stream.unwrap(
        SubscriptionRef.update(subscribed, (count) => count + 1).pipe(
          Effect.as(Stream.fromQueue(events)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const shellState = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, CACHE),
    Effect.provideService(
      ShellSnapshotLoader.ShellSnapshotLoader,
      ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeedSome(HTTP_SNAPSHOT),
      }),
    ),
  );
  yield* SubscriptionRef.changes(subscribed).pipe(
    Stream.filter((count) => count > 0),
    Stream.runHead,
  );
  return { events, shellState };
});

describe("environment shell resync limit", () => {
  it.effect("reads live once the stream stays quiet without the completion marker", () =>
    Effect.gen(function* () {
      const { shellState } = yield* makeResumingShell();
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");

      yield* TestClock.adjust(SHELL_RESUME_COMPLETION_TIMEOUT_MS - 1);
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");

      yield* TestClock.adjust(1);
      const settled = yield* SubscriptionRef.get(shellState);
      expect(settled.status).toBe("live");
      expect(Option.getOrThrow(settled.snapshot)).toEqual(HTTP_SNAPSHOT);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps waiting while the machine is still replaying events", () =>
    Effect.gen(function* () {
      const { events, shellState } = yield* makeResumingShell();
      yield* TestClock.adjust(SHELL_RESUME_COMPLETION_TIMEOUT_MS - 1_000);
      yield* Queue.offer(events, {
        kind: "thread.updated",
        sequence: 10,
        location: "active",
        thread: { ...v2ShellSnapshot.threads[0]!, id: "thread-replayed" } as never,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 10,
        ),
        Stream.runHead,
      );

      // The replayed event restarted the wait, so the first deadline passes.
      yield* TestClock.adjust(2_000);
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");

      yield* TestClock.adjust(SHELL_RESUME_COMPLETION_TIMEOUT_MS);
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("live");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a list the marker already confirmed alone", () =>
    Effect.gen(function* () {
      const { events, shellState } = yield* makeResumingShell();
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );
      const live = yield* SubscriptionRef.get(shellState);
      yield* TestClock.adjust(SHELL_RESUME_COMPLETION_TIMEOUT_MS * 2);
      expect(yield* SubscriptionRef.get(shellState)).toBe(live);
    }).pipe(Effect.scoped),
  );
});
