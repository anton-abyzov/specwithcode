import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as Context from "effect/Context";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Fiber from "effect/Fiber";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import * as Result from "effect/Result";

import * as Scheduler from "effect/Scheduler";

import * as Scope from "effect/Scope";

import * as Stream from "effect/Stream";

import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  PrimaryConnectionRegistration,
  RelayConnectionRegistration,
  type ConnectionCredential,
} from "./catalog.ts";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";

import * as EnvironmentRegistry from "./registry.ts";

import {
  GitHubRoutingPermissions,
  makeGitHubRoutingPermissions,
} from "./githubRoutingPermissions.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";

import { watchDiscoveredCompatibility } from "./layer.ts";

import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";

import type { RelayEnvironmentStatusResponse } from "@specweave-studio/contracts/relay";

import { runDesktopCommitWithReconnectObserver } from "../state/server.ts";

import {
  TARGET,
  SECOND_TARGET,
  RELAY_TARGET,
  SECOND_RELAY_TARGET,
  BEARER_TARGET,
  BEARER_PROFILE,
  BEARER_CREDENTIAL,
  SSH_TARGET,
  SSH_CONNECTION,
  SSH_PROFILE,
  CACHED_SNAPSHOT,
  makeHarness,
  routesOf,
  hasRoutes,
  awaitConnectionState,
} from "./registry.testHarness.ts";

describe("EnvironmentRegistry", () => {
  it.effect("replays connected state when arming a desktop commit observer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const commits = yield* Ref.make(0);
        const result = yield* runDesktopCommitWithReconnectObserver(
          registry.stateChanges(TARGET.environmentId),
          Ref.update(commits, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail("commit refused")),
          ),
        ).pipe(Effect.flip, Effect.timeout("1 second"));

        expect(result).toBe("commit refused");
        expect(yield* Ref.get(commits)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not acquire a session after the registry scope has already closed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      const registryScope = yield* Scope.make();
      const context = yield* Layer.build(harness.layer).pipe(Scope.provide(registryScope));
      const registry = Context.get(context, EnvironmentRegistry.EnvironmentRegistry);
      const dispatcher = new Scheduler.MixedScheduler("sync", () => () => {}).makeDispatcher();
      const scheduler: Scheduler.Scheduler = {
        executionMode: "sync",
        shouldYield: () => false,
        makeDispatcher: () => dispatcher,
      };

      yield* Scope.close(registryScope, Exit.void);
      yield* registry.start.pipe(Effect.provideService(Scheduler.Scheduler, scheduler));
      dispatcher.flush();

      expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
    }),
  );

  it.effect("hydrates connection profiles into catalog entries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          SSH_CONNECTION.environmentId,
        );

        expect(entry?.target).toEqual(SSH_CONNECTION);
        expect(Option.getOrThrow(entry?.profile ?? Option.none())).toEqual(SSH_PROFILE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("publishes network status changes independently of connection state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const offline = yield* Effect.forkChild(
          SubscriptionRef.changes(registry.networkStatus).pipe(
            Stream.filter((status) => status === "offline"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );

        yield* SubscriptionRef.set(harness.networkStatus, "offline");

        expect(yield* Fiber.join(offline)).toBe("offline");
        expect(yield* SubscriptionRef.get(registry.networkStatus)).toBe("offline");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  describe("the primary at a loopback address", () => {
    const LOOPBACK_PRIMARY = new PrimaryConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://127.0.0.1:8319",
      wsBaseUrl: "ws://127.0.0.1:8319",
    });

    it.effect("connects on the desktop while the network reports offline", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([LOOPBACK_PRIMARY], [], [], { surface: "desktop" });
        yield* SubscriptionRef.set(harness.networkStatus, "offline");

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          const state = yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (current) => current.phase === "connected",
          );
          expect(state.network).toBe("offline");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
    );

    // A browser tab opened at http://127.0.0.1:8319 talks to the server on
    // this machine just as the desktop app does.
    it.effect("connects in a browser tab while the network reports offline", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([LOOPBACK_PRIMARY], [], [], { surface: "web" });
        yield* SubscriptionRef.set(harness.networkStatus, "offline");

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          const state = yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (current) => current.phase === "connected",
          );
          expect(state.network).toBe("offline");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
    );
  });

  it.effect("starts persisted environments independently", () =>
    Effect.gen(function* () {
      const bothLoadsStarted = yield* Deferred.make<void>();
      const releaseLoads = yield* Deferred.make<void>();
      const loadCount = yield* Ref.make(0);
      const harness = yield* makeHarness([TARGET, SECOND_TARGET], [], [], {
        beforeSessionConnect: () =>
          Ref.updateAndGet(loadCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothLoadsStarted, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(releaseLoads)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const start = yield* Effect.forkChild(registry.start);

        yield* Deferred.await(bothLoadsStarted).pipe(Effect.timeout("1 second"));
        yield* Deferred.succeed(releaseLoads, undefined);
        yield* Fiber.join(start);

        expect(yield* Ref.get(loadCount)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("exposes the current RPC generation to late query subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const generation = yield* registry
          .runStream(
            TARGET.environmentId,
            Stream.unwrap(
              EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                Effect.map((supervisor) =>
                  Stream.concat(
                    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
                    SubscriptionRef.changes(supervisor.state),
                  ).pipe(
                    Stream.filterMap((state) =>
                      state.phase === "connected"
                        ? Result.succeed(state.generation)
                        : Result.failVoid,
                    ),
                    Stream.changes,
                  ),
                ),
              ),
            ),
          )
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        expect(generation).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("preserves cached data on connection failure and clears it on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const controls = yield* Ref.get(harness.sessions);
        expect(controls).toHaveLength(1);
        const active = controls[0];
        expect(active).toBeDefined();
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        const retryFiber = yield* Effect.forkChild(
          awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "backoff",
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.fail(
          active!.closed,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
          }),
        );
        yield* Fiber.join(retryFiber);
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        yield* registry.remove(TARGET.environmentId);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), TARGET.environmentId)).toBe(false);
        expect((yield* Ref.get(harness.shellCache)).has(TARGET.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
        expect((yield* SubscriptionRef.get(registry.entries)).has(TARGET.environmentId)).toBe(
          false,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("persists and starts a newly registered environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(routesOf(yield* Ref.get(harness.storedTargets), RELAY_TARGET.environmentId)).toEqual(
          [RELAY_TARGET],
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("only a fresh health check for the rejected environment unlocks it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET, SECOND_RELAY_TARGET], [], [], {
        initialDisabled: [RELAY_TARGET.environmentId],
      });
      const descriptor = (environmentId: EnvironmentId): ExecutionEnvironmentDescriptor => ({
        environmentId,
        label: "Server",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1.0.0",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      });
      const discovered = (
        value: ExecutionEnvironmentDescriptor,
        checkedAt = "2026-09-15T00:00:00Z",
      ) => {
        const environment = {
          environmentId: value.environmentId,
          label: value.label,
          endpoint: {
            httpBaseUrl: "https://relay.example.test",
            wsBaseUrl: "wss://relay.example.test",
            providerKind: "manual" as const,
          },
          linkedAt: "2026-09-15T00:00:00Z",
        };
        const status: RelayEnvironmentStatusResponse = {
          environmentId: value.environmentId,
          endpoint: environment.endpoint,
          status: "online",
          checkedAt,
          descriptor: value,
        };
        return {
          environment,
          availability: "online" as const,
          status: Option.some(status),
          error: Option.none(),
        };
      };
      const original = discovered(descriptor(RELAY_TARGET.environmentId));
      const discoveryState =
        yield* SubscriptionRef.make<RelayEnvironmentDiscovery.RelayEnvironmentDiscoveryState>({
          ...RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
          environments: new Map([[RELAY_TARGET.environmentId, original]]),
        });
      const initial = yield* Deferred.make<void>();
      const unrelated = yield* Deferred.make<void>();
      const replayed = yield* Deferred.make<void>();
      const refreshed = yield* Deferred.make<void>();
      let firstEnvironmentCalls = 0;
      let secondEnvironmentCalls = 0;
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* watchDiscoveredCompatibility().pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, {
            ...registry,
            setCompatibility: (environmentId, error) =>
              registry.setCompatibility(environmentId, error).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (environmentId === RELAY_TARGET.environmentId) {
                      firstEnvironmentCalls += 1;
                      yield* Deferred.succeed(
                        firstEnvironmentCalls === 1 ? initial : refreshed,
                        undefined,
                      );
                    } else {
                      secondEnvironmentCalls += 1;
                      yield* Deferred.succeed(
                        secondEnvironmentCalls === 1 ? unrelated : replayed,
                        undefined,
                      );
                    }
                  }),
                ),
              ),
          }),
          Effect.provideService(
            RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
            RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
              state: discoveryState,
              refresh: Effect.void,
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        const error = new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Socket discovered a newer protocol.",
        });
        yield* registry.setCompatibility(RELAY_TARGET.environmentId, error);
        yield* SubscriptionRef.update(discoveryState, (state) => ({
          ...state,
          environments: new Map(state.environments).set(
            SECOND_RELAY_TARGET.environmentId,
            discovered(descriptor(SECOND_RELAY_TARGET.environmentId)),
          ),
        }));
        yield* Deferred.await(unrelated);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId)
            ?.unsupportedReason,
        ).toBe(error.message);
        yield* SubscriptionRef.update(discoveryState, (state) => ({
          ...state,
          refreshing: true,
          environments: new Map(),
        }));
        yield* SubscriptionRef.update(discoveryState, (state) => ({
          ...state,
          refreshing: false,
          environments: new Map([
            [RELAY_TARGET.environmentId, discovered(descriptor(RELAY_TARGET.environmentId))],
            [
              SECOND_RELAY_TARGET.environmentId,
              discovered(descriptor(SECOND_RELAY_TARGET.environmentId), "2026-09-15T00:01:00Z"),
            ],
          ]),
        }));
        yield* Deferred.await(replayed);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId)
            ?.unsupportedReason,
        ).toBe(error.message);
        yield* SubscriptionRef.update(discoveryState, (state) => ({
          ...state,
          environments: new Map(state.environments).set(
            RELAY_TARGET.environmentId,
            discovered(descriptor(RELAY_TARGET.environmentId), "2026-09-15T00:02:00Z"),
          ),
        }));
        yield* Deferred.await(refreshed);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId),
        ).toMatchObject({ enabled: false });
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId)
            ?.unsupportedReason,
        ).toBeUndefined();
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("discovery leaves direct connections that share an environment id alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET, RELAY_TARGET]);
      const discovered = (environmentId: EnvironmentId) => {
        const endpoint = {
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test",
          providerKind: "manual" as const,
        };
        return {
          environment: {
            environmentId,
            label: "Preview server",
            endpoint,
            linkedAt: "2026-09-25T00:00:00Z",
          },
          availability: "online" as const,
          status: Option.some<RelayEnvironmentStatusResponse>({
            environmentId,
            endpoint,
            status: "online",
            checkedAt: "2026-09-25T00:00:00Z",
            descriptor: {
              environmentId,
              label: "Preview server",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "2.0.0",
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
              capabilities: { repositoryIdentity: true },
            },
          }),
          error: Option.none(),
        };
      };
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const relayChecked = yield* Deferred.make<void>();
        yield* watchDiscoveredCompatibility().pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, {
            ...registry,
            setCompatibility: (environmentId, error) =>
              registry
                .setCompatibility(environmentId, error)
                .pipe(
                  Effect.andThen(
                    environmentId === RELAY_TARGET.environmentId
                      ? Deferred.succeed(relayChecked, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.provideService(
            RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
            RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
              state:
                yield* SubscriptionRef.make<RelayEnvironmentDiscovery.RelayEnvironmentDiscoveryState>(
                  {
                    ...RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
                    environments: new Map([
                      [TARGET.environmentId, discovered(TARGET.environmentId)],
                      [RELAY_TARGET.environmentId, discovered(RELAY_TARGET.environmentId)],
                    ]),
                  },
                ),
              refresh: Effect.void,
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(relayChecked);

        const entries = yield* SubscriptionRef.get(registry.entries);
        expect(entries.get(RELAY_TARGET.environmentId)).toMatchObject({ enabled: false });
        expect(entries.get(TARGET.environmentId)).toMatchObject({ enabled: true });
        expect(entries.get(TARGET.environmentId)?.unsupportedReason).toBeUndefined();
        expect((yield* registry.state(TARGET.environmentId)).phase).toBe("connected");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("discovery keeps unsupported environments off until compatibility changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        initialDisabled: [RELAY_TARGET.environmentId],
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        const error = new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Use a compatible client.",
        });
        yield* registry.setCompatibility(RELAY_TARGET.environmentId, error);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          RELAY_TARGET.environmentId,
        );
        expect(entry).toMatchObject({ enabled: false, unsupportedReason: error.message });
        expect(
          yield* Effect.flip(registry.setEnabled(RELAY_TARGET.environmentId, true)),
        ).toMatchObject({ reason: "unsupported" });
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
        yield* registry.setCompatibility(RELAY_TARGET.environmentId, null);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId)?.enabled,
        ).toBe(false);
        yield* registry.setEnabled(RELAY_TARGET.environmentId, true);
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a socket preflight rejection persists the connection as switched off", () =>
    Effect.gen(function* () {
      const error = new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Use a compatible client.",
      });
      const harness = yield* makeHarness([RELAY_TARGET], [], [], { prepareError: error });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* SubscriptionRef.changes(registry.entries).pipe(
          Stream.filter((entries) => entries.get(RELAY_TARGET.environmentId)?.enabled === false),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* Ref.get(harness.storedDisabled)).has(RELAY_TARGET.environmentId)).toBe(true);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId)
            ?.unsupportedReason,
        ).toBe(error.message);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("switching an environment off disconnects it and persists the flag", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.setEnabled(RELAY_TARGET.environmentId, false);
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "available",
        );

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          RELAY_TARGET.environmentId,
        );
        expect(entry?.enabled).toBe(false);
        expect((yield* Ref.get(harness.storedDisabled)).has(RELAY_TARGET.environmentId)).toBe(true);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY_TARGET.environmentId)).toBe(
          true,
        );
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);

        yield* registry.setEnabled(RELAY_TARGET.environmentId, true);
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect((yield* Ref.get(harness.storedDisabled)).has(RELAY_TARGET.environmentId)).toBe(
          false,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("re-registering a switched-off environment keeps it off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        initialDisabled: [RELAY_TARGET.environmentId],
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.register(
          new RelayConnectionRegistration({
            target: new RelayConnectionTarget({ ...RELAY_TARGET, label: "Renamed" }),
          }),
        );
        yield* Effect.yieldNow;

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          RELAY_TARGET.environmentId,
        );
        expect(entry?.target.label).toBe("Renamed");
        expect(entry?.enabled).toBe(false);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("switching an SSH environment off tears down its managed backend", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          SSH_CONNECTION.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.setEnabled(SSH_CONNECTION.environmentId, false);
        yield* awaitConnectionState(
          registry,
          SSH_CONNECTION.environmentId,
          (state) => state.phase === "available",
        );

        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([SSH_TARGET]);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), SSH_CONNECTION.environmentId)).toBe(
          true,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not connect a persisted environment that was switched off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        initialDisabled: [RELAY_TARGET.environmentId],
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Effect.yieldNow;

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          RELAY_TARGET.environmentId,
        );
        expect(entry?.enabled).toBe(false);
        expect((yield* registry.state(RELAY_TARGET.environmentId)).phase).toBe("available");
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("moves durable streams to a replacement supervisor", () =>
    Effect.gen(function* () {
      const replacement = new RelayConnectionTarget({
        environmentId: RELAY_TARGET.environmentId,
        label: "Replacement relay environment",
      });
      const harness = yield* makeHarness([RELAY_TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const firstObserved = yield* Deferred.make<void>();
        const secondObserved = yield* Deferred.make<void>();
        const labels = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              RELAY_TARGET.environmentId,
              Stream.unwrap(
                EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                  Effect.map((supervisor) =>
                    Stream.concat(Stream.succeed(supervisor.target.label), Stream.never),
                  ),
                ),
              ),
            )
            .pipe(
              Stream.tap((label) =>
                Ref.updateAndGet(labels, (current) => [...current, label]).pipe(
                  Effect.flatMap((current) =>
                    current.length === 1
                      ? Deferred.succeed(firstObserved, undefined)
                      : Deferred.succeed(secondObserved, undefined),
                  ),
                ),
              ),
              Stream.runDrain,
            ),
        );

        yield* Deferred.await(firstObserved).pipe(Effect.timeout("1 second"));
        yield* registry.register(new RelayConnectionRegistration({ target: replacement }));
        yield* Deferred.await(secondObserved).pipe(Effect.timeout("1 second"));
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(labels)).toEqual([RELAY_TARGET.label, replacement.label]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("moves prepared credential observers when re-pairing an unchanged environment", () =>
    Effect.gen(function* () {
      const replacementCredential = new BearerConnectionCredential({ token: "replacement-token" });
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const initialObserved = yield* Deferred.make<void>();
        const replacementObserved = yield* Deferred.make<void>();
        const tokens = yield* Ref.make<ReadonlyArray<string>>([]);
        const followedSupervisors = yield* Ref.make(0);
        yield* registry.start;

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              BEARER_TARGET.environmentId,
              Stream.unwrap(
                Effect.gen(function* () {
                  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
                  yield* Ref.update(followedSupervisors, (count) => count + 1);
                  return SubscriptionRef.changes(supervisor.prepared);
                }),
              ),
            )
            .pipe(
              Stream.filterMap((prepared) =>
                Option.isSome(prepared) && prepared.value.httpAuthorization?._tag === "Bearer"
                  ? Result.succeed(prepared.value.httpAuthorization.token)
                  : Result.failVoid,
              ),
              Stream.changes,
              Stream.runForEach((token) =>
                Effect.gen(function* () {
                  yield* Ref.update(tokens, (current) => [...current, token]);
                  yield* Deferred.succeed(
                    token === replacementCredential.token ? replacementObserved : initialObserved,
                    undefined,
                  );
                }),
              ),
            ),
        );

        yield* Deferred.await(initialObserved);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({ ...BEARER_TARGET }),
            profile: new BearerConnectionProfile({ ...BEARER_PROFILE }),
            credential: replacementCredential,
          }),
        );
        yield* Deferred.await(replacementObserved);
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(tokens)).toEqual([
          BEARER_CREDENTIAL.token,
          replacementCredential.token,
        ]);
        expect(yield* Ref.get(followedSupervisors)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ignores retry signals for environments that are no longer registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.retryNow(EnvironmentId.make("removed-environment"));
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removes all relay-owned data without touching non-cloud connections", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [RELAY_TARGET, SECOND_RELAY_TARGET, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY_TARGET.environmentId)).toBe(false);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(false);
        expect(routesOf(targets, BEARER_TARGET.environmentId)).toEqual([BEARER_TARGET]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).has(BEARER_TARGET.environmentId),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps the runtime registered when durable removal fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        beforeRegistrationRemove: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "remove-connection",
              message: "Storage is unavailable.",
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const error = yield* Effect.flip(registry.removeRelayEnvironments());

        expect(error._tag).toBe("ConnectionPersistenceError");
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
        expect((yield* SubscriptionRef.get(registry.entries)).has(RELAY_TARGET.environmentId)).toBe(
          true,
        );
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY_TARGET.environmentId)).toBe(
          true,
        );
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a replaced platform bearer wakes a supervisor blocked on the old one", () =>
    Effect.gen(function* () {
      let storedCredentials: Ref.Ref<Map<string, ConnectionCredential>> | undefined;
      const harness = yield* makeHarness([], [], [], {
        // Authentication fails while the old bearer is stored, as the server
        // would answer once that session was revoked.
        beforePrepareRoute: (target) =>
          target._tag !== "BearerConnectionTarget" || storedCredentials === undefined
            ? Effect.succeed(undefined)
            : Ref.get(storedCredentials).pipe(
                Effect.map((current) =>
                  current.get(target.connectionId)?.token === "old-bearer"
                    ? new ConnectionBlockedError({ reason: "authentication", detail: "revoked" })
                    : undefined,
                ),
              ),
      });
      storedCredentials = harness.storedCredentials;

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = (token: string) =>
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: new BearerConnectionCredential({ token }),
          });
        yield* registry.reconcilePlatform([registration("old-bearer")]);
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "blocked",
        );

        yield* registry.reconcilePlatform([registration("new-bearer")]);

        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a bearer replaced while an attempt is in flight retries with the new one", () =>
    Effect.gen(function* () {
      const attemptStarted = yield* Deferred.make<void>();
      const releaseFirstAttempt = yield* Deferred.make<void>();
      const attempts = yield* Ref.make(0);
      const harness = yield* makeHarness([], [], [], {
        // The first attempt read the old bearer; it stalls, then fails
        // authentication after the bearer has already been replaced.
        beforePrepareRoute: (target) =>
          target._tag !== "BearerConnectionTarget"
            ? Effect.succeed(undefined)
            : Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.succeed(attemptStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseFirstAttempt)),
                        Effect.as(
                          new ConnectionBlockedError({
                            reason: "authentication",
                            detail: "revoked",
                          }),
                        ),
                      )
                    : Effect.succeed(undefined),
                ),
              ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = (token: string) =>
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: new BearerConnectionCredential({ token }),
          });
        yield* registry.reconcilePlatform([registration("old-bearer")]);
        yield* Deferred.await(attemptStarted).pipe(Effect.timeout("1 second"));

        // A live state subscription, as the UI holds, keeps the runtime in place
        // so the stalled attempt's failure lands on the same supervisor.
        yield* registry
          .stateChanges(BEARER_TARGET.environmentId)
          .pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* registry.reconcilePlatform([registration("new-bearer")]);
        yield* Deferred.succeed(releaseFirstAttempt, undefined);

        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* Ref.get(attempts)).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts a newly paired bearer environment without re-reading its profile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        );
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(yield* Ref.get(harness.profileReadCount)).toBe(0);
        expect(
          Option.getOrThrow(
            (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)
              ?.profile ?? Option.none(),
          ),
        ).toEqual(BEARER_PROFILE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts platform environments without persisting or removing them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(hasRoutes(yield* Ref.get(harness.storedTargets), TARGET.environmentId)).toBe(false);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);

        const error = yield* Effect.flip(registry.remove(TARGET.environmentId));
        expect(error._tag).toBe("PlatformEnvironmentRemovalError");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("gives a primary platform registration precedence over persisted registrations", () =>
    Effect.gen(function* () {
      const shadowedTarget = new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: "Shadowed relay environment",
      });
      const harness = yield* makeHarness([shadowedTarget]);
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const shadowedEntry = { target: shadowedTarget, profile: Option.none(), enabled: true };
      yield* permissions.set(shadowedEntry, "read-write");

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));
        expect(yield* permissions.get(shadowedEntry)).toBe("off");

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), TARGET.environmentId)).toBe(false);

        yield* registry.register(new RelayConnectionRegistration({ target: shadowedTarget }));

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), TARGET.environmentId)).toBe(false);
      }).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(GitHubRoutingPermissions, permissions),
        Effect.scoped,
      );
    }),
  );

  it.effect("rechecks platform ownership after waiting for the environment lease", () =>
    Effect.gen(function* () {
      const registrationStarted = yield* Deferred.make<void>();
      const continueRegistration = yield* Deferred.make<void>();
      const shadowedTarget = new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: "Shadowed relay environment",
      });
      const harness = yield* makeHarness([], [], [], {
        beforeRegistrationRegister: () =>
          Deferred.succeed(registrationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueRegistration)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const persistedRegistration = yield* registry
          .register(new RelayConnectionRegistration({ target: shadowedTarget }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(registrationStarted);

        const platformRegistration = yield* registry
          .registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        const removal = yield* Effect.flip(registry.remove(TARGET.environmentId)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.succeed(continueRegistration, undefined);
        yield* Fiber.join(persistedRegistration);
        yield* Fiber.join(platformRegistration);
        const error = yield* Fiber.join(removal);

        expect(error._tag).toBe("PlatformEnvironmentRemovalError");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not reacquire a runtime while its registration is being removed", () =>
    Effect.gen(function* () {
      const removalStarted = yield* Deferred.make<void>();
      const continueRemoval = yield* Deferred.make<void>();
      const harness = yield* makeHarness([TARGET], [], [], {
        beforeRegistrationRemove: () =>
          Deferred.succeed(removalStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueRemoval)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const removal = yield* Effect.forkChild(registry.remove(TARGET.environmentId));
        yield* Deferred.await(removalStarted);

        const stateLookup = yield* Effect.forkChild(
          Effect.flip(registry.state(TARGET.environmentId)),
        );
        yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);

        yield* Deferred.succeed(continueRemoval, undefined);
        yield* Fiber.join(removal);
        const error = yield* Fiber.join(stateLookup);
        expect(error._tag).toBe("EnvironmentNotRegisteredError");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("platform refreshes preserve unsupported state for the same endpoint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = new PrimaryConnectionRegistration({ target: TARGET });
        yield* registry.registerPlatform(registration);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const error = new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Use a compatible client.",
        });
        yield* registry.setCompatibility(TARGET.environmentId, error);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "available",
        );
        yield* registry.registerPlatform(registration);
        yield* registry.reconcilePlatform([registration]);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId),
        ).toMatchObject({ enabled: false, unsupportedReason: error.message });
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        yield* registry.registerPlatform(
          new PrimaryConnectionRegistration({
            target: new PrimaryConnectionTarget({
              ...TARGET,
              httpBaseUrl: "https://changed.example.test",
            }),
          }),
        );
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)
            ?.unsupportedReason,
        ).toBeUndefined();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps one session per environment across concurrent registrations and retries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = new PrimaryConnectionRegistration({ target: TARGET });
        yield* Effect.all(
          Array.from({ length: 5 }, () => registry.registerPlatform(registration)),
          { concurrency: "unbounded", discard: true },
        );
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        // Platform polls and explicit retries reach a healthy connection at once.
        yield* Effect.all(
          [
            ...Array.from({ length: 5 }, () => registry.registerPlatform(registration)),
            ...Array.from({ length: 5 }, () => registry.retryNow(TARGET.environmentId)),
            registry.reconcilePlatform([registration]),
          ],
          { concurrency: "unbounded", discard: true },
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          yield* Effect.yieldNow;
        }

        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
        expect(yield* registry.state(TARGET.environmentId)).toMatchObject({
          phase: "connected",
          generation: 1,
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("retains a healthy runtime when the platform repeats an identical registration", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      let failWrites = false;
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          failWrites
            ? Effect.fail(
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: "Storage unavailable",
                }),
              )
            : Effect.void,
      });
      const entry = { target: TARGET, profile: Option.none(), enabled: true };

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = new PrimaryConnectionRegistration({ target: TARGET });
        yield* registry.registerPlatform(registration);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        yield* permissions.set(entry, "read-write");

        yield* registry.registerPlatform(registration);

        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect(yield* permissions.get(entry)).toBe("read-write");

        const changedTarget = new PrimaryConnectionTarget({
          ...TARGET,
          httpBaseUrl: "https://changed.example.test",
        });
        failWrites = true;
        yield* registry.registerPlatform(
          new PrimaryConnectionRegistration({ target: changedTarget }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        yield* registry.reconcilePlatform([]);
        expect((yield* SubscriptionRef.get(registry.entries)).has(TARGET.environmentId)).toBe(true);

        failWrites = false;
        yield* registry.registerPlatform(
          new PrimaryConnectionRegistration({ target: changedTarget }),
        );
        expect(yield* permissions.get(entry)).toBe("off");
        yield* registry.registerPlatform(registration);
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read-write");
        yield* registry.reconcilePlatform([]);
        yield* registry.registerPlatform(registration);
        expect(yield* permissions.get(entry)).toBe("off");
      }).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(GitHubRoutingPermissions, permissions),
        Effect.scoped,
      );
    }),
  );

  it.effect("removes all owned SSH state only on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [SSH_CONNECTION],
        [SSH_PROFILE],
        [
          [
            SSH_CONNECTION.connectionId,
            new BearerConnectionCredential({ token: "temporary-token" }),
          ],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.remove(SSH_CONNECTION.environmentId);

        expect((yield* Ref.get(harness.storedProfiles)).has(SSH_CONNECTION.connectionId)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedCredentials)).has(SSH_CONNECTION.connectionId)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedRemoteTokens)).has(SSH_CONNECTION.environmentId)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([SSH_TARGET]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
