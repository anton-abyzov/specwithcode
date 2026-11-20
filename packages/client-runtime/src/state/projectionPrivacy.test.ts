import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadDetailSnapshot,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Now, v2Projection, v2ShellSnapshot, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { makeEnvironmentShellState } from "./shell.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { makeEnvironmentThreadState } from "./threads.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("privacy-fixture"),
  label: "Fixture",
  httpBaseUrl: "https://fixture.invalid",
  wsBaseUrl: "wss://fixture.invalid",
});
const offline = { ...AVAILABLE_CONNECTION_STATE, phase: "offline" } as const;
const connected = { ...AVAILABLE_CONNECTION_STATE, phase: "connected" } as const;
function blocked(reason: "authentication" | "permission"): SupervisorConnectionState {
  return {
    ...AVAILABLE_CONNECTION_STATE,
    phase: "blocked",
    lastFailure: new ConnectionBlockedError({ reason, detail: "Fixture denied" }),
  };
}
function thread(text: string): OrchestrationV2ThreadDetailSnapshot {
  return {
    snapshotSequence: 3,
    projection: {
      ...v2Projection,
      messages: [
        {
          id: MessageId.make("fixture-message"),
          threadId: v2ThreadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: v2Now,
          updatedAt: v2Now,
        },
      ],
    },
  };
}

const setup = Effect.fn("privacy fixture")(function* (initial: SupervisorConnectionState) {
  const state = yield* SubscriptionRef.make(initial);
  const socket = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const supervisor = EnvironmentSupervisor.of({
    target,
    state,
    session: socket,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const disk = {
    shell: Option.some(v2ShellSnapshot),
    thread: Option.some(thread("previous message")),
    clears: 0,
    reads: 0,
  };
  const cache = EnvironmentCacheStore.of({
    loadShell: () =>
      Effect.sync(() => {
        disk.reads++;
        return disk.shell;
      }),
    saveShell: (_, value) =>
      Effect.sync(() => {
        disk.shell = Option.some(value);
      }),
    loadThread: () =>
      Effect.sync(() => {
        disk.reads++;
        return disk.thread;
      }),
    saveThread: (_, value) =>
      Effect.sync(() => {
        disk.thread = Option.some(value);
      }),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: (id) =>
      Effect.sync(() => {
        expect(id).toEqual(target.environmentId);
        disk.clears++;
        disk.shell = Option.none();
        disk.thread = Option.none();
      }),
  });
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () =>
      Stream.concat(
        Stream.succeed({ kind: "snapshot", ...thread("new session message") }),
        Stream.never,
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
      Stream.concat(
        Stream.succeed({ kind: "snapshot", snapshot: { ...v2ShellSnapshot, snapshotSequence: 9 } }),
        Stream.never,
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({} as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const shell = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor, supervisor),
    Effect.provideService(EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader, {
      load: () => Effect.succeedSome({ ...v2ShellSnapshot, snapshotSequence: 9 }),
    }),
  );
  const detail = yield* makeEnvironmentThreadState(v2ThreadId).pipe(
    Effect.provideService(EnvironmentSupervisor, supervisor),
    Effect.provideService(EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, {
      load: () => Effect.succeed({ _tag: "present", snapshot: thread("new session message") }),
    }),
  );
  const open = SubscriptionRef.set(
    prepared,
    Option.some({
      target,
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
    }),
  ).pipe(
    Effect.andThen(SubscriptionRef.set(socket, Option.some(session))),
    Effect.andThen(SubscriptionRef.set(state, connected)),
  );
  return { shell, detail, disk, state, open, socket };
});

describe("denied environment projections", () => {
  it.effect("blocked startup reveals neither the saved project list nor the saved chat body", () =>
    Effect.gen(function* () {
      const h = yield* setup(blocked("authentication"));
      yield* TestClock.adjust(1);
      expect(Option.isNone((yield* SubscriptionRef.get(h.shell)).snapshot)).toBe(true);
      expect(Option.isNone((yield* SubscriptionRef.get(h.detail)).data)).toBe(true);
      expect(h.disk).toMatchObject({
        reads: 0,
        clears: 1,
        shell: Option.none(),
        thread: Option.none(),
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps ordinary offline data, retires it on denial and reads fresh data after reauthorization",
    () =>
      Effect.gen(function* () {
        const h = yield* setup(offline);
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(h.shell)).snapshot).projects,
        ).toHaveLength(1);
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(h.detail)).data).messages[0]?.text,
        ).toBe("previous message");
        expect(h.disk.clears).toBe(0);
        yield* h.open;
        yield* SubscriptionRef.changes(h.detail).pipe(
          Stream.filter(
            (s) => Option.getOrNull(s.data)?.messages[0]?.text === "new session message",
          ),
          Stream.runHead,
        );
        yield* SubscriptionRef.changes(h.shell).pipe(
          Stream.filter((s) => Option.getOrNull(s.snapshot)?.snapshotSequence === 9),
          Stream.runHead,
        );
        yield* SubscriptionRef.set(h.socket, Option.none());
        yield* SubscriptionRef.set(h.state, blocked("permission"));
        yield* TestClock.adjust("11 seconds");
        expect(Option.isNone((yield* SubscriptionRef.get(h.shell)).snapshot)).toBe(true);
        expect(Option.isNone((yield* SubscriptionRef.get(h.detail)).data)).toBe(true);
        expect(h.disk).toMatchObject({ clears: 1, shell: Option.none(), thread: Option.none() });
        yield* SubscriptionRef.set(h.state, offline);
        yield* TestClock.adjust(1);
        expect(Option.isNone((yield* SubscriptionRef.get(h.detail)).data)).toBe(true);
        yield* h.open;
        yield* SubscriptionRef.changes(h.detail).pipe(
          Stream.filter(
            (s) => Option.getOrNull(s.data)?.messages[0]?.text === "new session message",
          ),
          Stream.runHead,
        );
        yield* SubscriptionRef.changes(h.shell).pipe(
          Stream.filter((s) => Option.getOrNull(s.snapshot)?.snapshotSequence === 9),
          Stream.runHead,
        );
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(h.detail)).data).messages[0]?.text,
        ).toBe("new session message");
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(h.shell)).snapshot).snapshotSequence,
        ).toBe(9);
      }).pipe(Effect.scoped),
  );
});
