import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import { BearerConnectionTarget, SshConnectionTarget } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  GitHubRoutingPermissions,
  type StoredGitHubRoutingPermission,
  makeGitHubRoutingPermissions,
} from "./githubRoutingPermissions.ts";
import {
  RELAY_TARGET,
  SECOND_RELAY_TARGET,
  BEARER_TARGET,
  BEARER_PROFILE,
  BEARER_CREDENTIAL,
  SSH_TARGET,
  SSH_CONNECTION,
  SSH_PROFILE,
  makeHarness,
  routesOf,
  hasRoutes,
} from "./registry.testHarness.ts";

describe("EnvironmentRegistry routes", () => {
  // The relay environment, reachable on the LAN as well.
  const LAN_TARGET = new BearerConnectionTarget({
    environmentId: RELAY_TARGET.environmentId,
    label: RELAY_TARGET.label,
    connectionId: "bearer:lan",
  });
  const LAN_PROFILE = new BearerConnectionProfile({
    connectionId: LAN_TARGET.connectionId,
    environmentId: LAN_TARGET.environmentId,
    label: LAN_TARGET.label,
    httpBaseUrl: "http://192.168.1.10:8319/",
    wsBaseUrl: "ws://192.168.1.10:8319/",
  });
  const lanRegistration = (target = LAN_TARGET, profile = LAN_PROFILE) =>
    new BearerConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL });

  it.effect("adds a paired LAN route behind Studio Connect instead of replacing it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(lanRegistration());

        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          RELAY_TARGET,
          LAN_TARGET,
        ]);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(LAN_TARGET.environmentId);
        expect(entry?.target).toEqual(RELAY_TARGET);
        expect(entry?.alternateRoutes?.map((route) => route.target)).toEqual([LAN_TARGET]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a pairing that targets no environment cannot add a route to a saved one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        const attacker = new BearerConnectionTarget({ ...LAN_TARGET, connectionId: "bearer:new" });
        const attackerProfile = new BearerConnectionProfile({
          ...LAN_PROFILE,
          connectionId: attacker.connectionId,
          httpBaseUrl: "https://attacker.example.test/",
          wsBaseUrl: "wss://attacker.example.test/",
        });

        const checked = yield* registry
          .assertKnownAddress({ target: attacker, profile: Option.some(attackerProfile) })
          .pipe(Effect.flip);
        const refused = yield* registry
          .register(lanRegistration(attacker, attackerProfile), { knownAddressOnly: true })
          .pipe(Effect.flip);

        expect(checked).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
        expect(refused).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          LAN_TARGET,
          RELAY_TARGET,
        ]);

        // Re-pairing an address it already has still replaces that route.
        yield* registry.register(lanRegistration(), { knownAddressOnly: true });
        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          LAN_TARGET,
          RELAY_TARGET,
        ]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("re-pairing the same address replaces that route rather than adding another", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const repaired = new BearerConnectionTarget({
          ...LAN_TARGET,
          connectionId: "bearer:lan-again",
        });
        yield* registry.register(
          lanRegistration(
            repaired,
            new BearerConnectionProfile({ ...LAN_PROFILE, connectionId: repaired.connectionId }),
          ),
        );

        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          RELAY_TARGET,
          repaired,
        ]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a second SSH host for the same machine adds a route beside the first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const other = new SshConnectionTarget({
          ...SSH_CONNECTION,
          connectionId: "ssh-connection-other-host",
        });
        yield* registry.register(
          new SshConnectionRegistration({
            target: other,
            profile: new SshConnectionProfile({
              ...SSH_PROFILE,
              connectionId: other.connectionId,
              target: { ...SSH_TARGET, alias: "other", hostname: "other.example.test" },
            }),
          }),
        );

        expect(
          routesOf(yield* Ref.get(harness.storedTargets), SSH_CONNECTION.environmentId),
        ).toEqual([SSH_CONNECTION, other]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "adding a saved SSH host again replaces its route, whatever id it was saved under",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const again = new SshConnectionTarget({
            ...SSH_CONNECTION,
            connectionId: "ssh-connection-new-id",
          });
          yield* registry.register(
            new SshConnectionRegistration({
              target: again,
              profile: new SshConnectionProfile({
                ...SSH_PROFILE,
                connectionId: again.connectionId,
              }),
            }),
          );

          expect(
            routesOf(yield* Ref.get(harness.storedTargets), SSH_CONNECTION.environmentId),
          ).toEqual([again]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("signing out of Studio Connect keeps an environment that still has a LAN route", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET, SECOND_RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();

        const targets = yield* Ref.get(harness.storedTargets);
        expect(routesOf(targets, LAN_TARGET.environmentId)).toEqual([LAN_TARGET]);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(false);
        // Only the environment that lost its last route is forgotten.
        expect(yield* Ref.get(harness.cacheClears)).toEqual([SECOND_RELAY_TARGET.environmentId]);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(LAN_TARGET.environmentId)?.target,
        ).toEqual(LAN_TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("reorders routes and rejects an order that drops one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.reorderRoutes(LAN_TARGET.environmentId, ["relay", LAN_TARGET.connectionId]);
        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          RELAY_TARGET,
          LAN_TARGET,
        ]);

        const error = yield* registry
          .reorderRoutes(LAN_TARGET.environmentId, ["relay"])
          .pipe(Effect.flip);
        expect(error._tag).toBe("ConnectionBlockedError");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removing the last route forgets the environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRoute(LAN_TARGET.environmentId, LAN_TARGET.connectionId);
        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          RELAY_TARGET,
        ]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);

        yield* registry.removeRoute(LAN_TARGET.environmentId, "relay");
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.cacheClears)).toEqual([LAN_TARGET.environmentId]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("revokes GitHub routing trust when a route is added but keeps it on reorder", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET]);
      let stored: ReadonlyArray<StoredGitHubRoutingPermission> = [];
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.sync(() => stored),
        write: (next) => Effect.sync(() => void (stored = next)),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const current = () =>
          SubscriptionRef.get(registry.entries).pipe(
            Effect.map((entries) => entries.get(RELAY_TARGET.environmentId)!),
          );
        yield* permissions.set(yield* current(), "read");
        yield* registry.register(lanRegistration());
        expect(yield* permissions.get(yield* current())).toBe("off");

        yield* permissions.set(yield* current(), "read");
        yield* registry.reorderRoutes(LAN_TARGET.environmentId, ["relay", LAN_TARGET.connectionId]);
        expect(yield* permissions.get(yield* current())).toBe("read");
      }).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(GitHubRoutingPermissions, permissions),
        Effect.scoped,
      );
    }),
  );

  it.effect("loads saved routes grouped by environment, in saved order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, BEARER_TARGET, RELAY_TARGET],
        [LAN_PROFILE, BEARER_PROFILE],
        [
          [LAN_TARGET.connectionId, BEARER_CREDENTIAL],
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
        ],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entries = yield* SubscriptionRef.get(registry.entries);
        expect([...entries.keys()]).toEqual([
          LAN_TARGET.environmentId,
          BEARER_TARGET.environmentId,
        ]);
        expect(entries.get(LAN_TARGET.environmentId)?.alternateRoutes?.[0]?.target).toEqual(
          RELAY_TARGET,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("drops a learned route whose profile was not saved instead of duplicating it", () =>
    Effect.gen(function* () {
      const learnedId = `learned:${LAN_TARGET.environmentId}:100.64.0.9:8319@${LAN_TARGET.connectionId}`;
      const learned = new BearerConnectionTarget({ ...LAN_TARGET, connectionId: learnedId });
      // An earlier build saved the learned target twice and never its profile.
      const harness = yield* makeHarness(
        [LAN_TARGET, learned, learned],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(LAN_TARGET.environmentId);
        expect(entry?.target).toEqual(LAN_TARGET);
        expect(entry?.alternateRoutes ?? []).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
