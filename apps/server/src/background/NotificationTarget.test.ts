import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  RpcClientId,
  type ClientActivityLease,
  type HostPowerSnapshot,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const NOW_MS = Date.parse("2026-11-12T12:00:00.000Z");
const NOW = DateTime.makeUnsafe(NOW_MS);
const SELF = EnvironmentId.make("env-self");
const OTHER = EnvironmentId.make("env-other");

function lease(
  clientId: string,
  overrides: Partial<ClientActivityLease> & { readonly interactedSecondsAgo?: number } = {},
): ClientActivityLease {
  const { interactedSecondsAgo, ...rest } = overrides;
  return {
    sessionId: AuthSessionId.make("session"),
    rpcClientId: RpcClientId.make(1),
    clientId,
    clientKind: "desktop-renderer",
    visible: false,
    focused: false,
    recentlyInteracted: false,
    scopes: [],
    updatedAt: NOW,
    expiresAt: DateTime.makeUnsafe(NOW_MS + 30_000),
    ...(interactedSecondsAgo === undefined
      ? {}
      : { lastInteractionAt: DateTime.makeUnsafe(NOW_MS - interactedSecondsAgo * 1_000) }),
    ...rest,
  };
}

const foreground = { visible: true, focused: true, recentlyInteracted: true } as const;

function elect(
  leases: readonly ClientActivityLease[],
  retained: ReadonlyMap<string, BackgroundPolicy.RetainedInteraction> = new Map(),
  selfEnvironmentId: EnvironmentId | null = SELF,
) {
  return BackgroundPolicy.electNotificationTarget({
    leases,
    retained,
    selfEnvironmentId,
    now: NOW,
  });
}

describe("electNotificationTarget", () => {
  it("elects the foreground desktop touched last", () => {
    assert.deepStrictEqual(
      elect([
        lease("desk-a", { ...foreground, interactedSecondsAgo: 30 }),
        lease("desk-b", { ...foreground, interactedSecondsAgo: 5 }),
        lease("desk-c", { interactedSecondsAgo: 1 }),
      ]),
      { clientId: "desk-b", reason: "foreground" },
    );
  });

  it("breaks a tie on the newer report, then on the lower client id", () => {
    const earlier = DateTime.makeUnsafe(NOW_MS - 10_000);
    assert.deepStrictEqual(
      elect([
        lease("desk-a", { ...foreground, interactedSecondsAgo: 5, updatedAt: earlier }),
        lease("desk-b", { ...foreground, interactedSecondsAgo: 5 }),
      ]),
      { clientId: "desk-b", reason: "foreground" },
    );
    assert.deepStrictEqual(
      elect([
        lease("desk-b", { ...foreground, interactedSecondsAgo: 5 }),
        lease("desk-a", { ...foreground, interactedSecondsAgo: 5 }),
      ]),
      { clientId: "desk-a", reason: "foreground" },
    );
  });

  it("gives a phone in use the slot, so no desktop pops up", () => {
    assert.deepStrictEqual(
      elect([
        lease("desk-a", { interactedSecondsAgo: 5 }),
        lease("mobile-1", { ...foreground, clientKind: "mobile" }),
      ]),
      { clientId: "mobile-1", reason: "phone" },
    );
  });

  it("never lets a backgrounded phone take the recent slot", () => {
    assert.deepStrictEqual(
      elect([
        lease("desk-a", { interactedSecondsAgo: 600 }),
        lease("mobile-1", { clientKind: "mobile", interactedSecondsAgo: 1 }),
      ]),
      { clientId: "desk-a", reason: "recent" },
    );
  });

  it("elects the idle desktop touched last, from the lease or the retained map", () => {
    assert.deepStrictEqual(
      elect([
        lease("desk-a", { interactedSecondsAgo: 600 }),
        lease("desk-b", { interactedSecondsAgo: 60 }),
      ]),
      { clientId: "desk-b", reason: "recent" },
    );
    // desk-a reloaded: its lease has no interaction, the retained map remembers one.
    assert.deepStrictEqual(
      elect(
        [lease("desk-a"), lease("desk-b", { interactedSecondsAgo: 60 })],
        new Map([["desk-a", { lastInteractionAtMs: NOW_MS - 10_000, seenAtMs: NOW_MS }]]),
      ),
      { clientId: "desk-a", reason: "recent" },
    );
  });

  it("never elects a client whose lease ended: it cannot show anything", () => {
    assert.deepStrictEqual(
      elect(
        [
          lease("desk-asleep", {
            interactedSecondsAgo: 5,
            expiresAt: DateTime.makeUnsafe(NOW_MS - 1),
          }),
          lease("desk-b", { interactedSecondsAgo: 600 }),
        ],
        new Map([["desk-asleep", { lastInteractionAtMs: NOW_MS - 5_000, seenAtMs: NOW_MS }]]),
      ),
      { clientId: "desk-b", reason: "recent" },
    );
  });

  it("falls back to the app on this server's own machine, then to nobody", () => {
    assert.deepStrictEqual(
      elect([
        lease("desk-other", { hostEnvironmentId: OTHER }),
        lease("desk-self", { hostEnvironmentId: SELF }),
      ]),
      { clientId: "desk-self", reason: "owner" },
    );
    assert.equal(elect([lease("desk-other", { hostEnvironmentId: OTHER })]), null);
    assert.equal(elect([lease("desk-self", { hostEnvironmentId: SELF })], new Map(), null), null);
    assert.equal(elect([]), null);
  });
});

describe("retainInteraction", () => {
  it("keeps the latest interaction per client", () => {
    let retained = BackgroundPolicy.retainInteraction(new Map(), "a", NOW_MS - 1_000, NOW_MS);
    retained = BackgroundPolicy.retainInteraction(retained, "a", NOW_MS - 5_000, NOW_MS);
    assert.equal(retained.get("a")?.lastInteractionAtMs, NOW_MS - 1_000);
    retained = BackgroundPolicy.retainInteraction(retained, "a", undefined, NOW_MS + 1);
    assert.equal(retained.get("a")?.lastInteractionAtMs, NOW_MS - 1_000);
  });

  it("forgets a client 8 hours after its last report and holds at most 64", () => {
    let retained = BackgroundPolicy.retainInteraction(new Map(), "old", NOW_MS, NOW_MS);
    retained = BackgroundPolicy.retainInteraction(
      retained,
      "new",
      NOW_MS,
      NOW_MS + BackgroundPolicy.RETAINED_INTERACTION_MS + 1,
    );
    assert.deepStrictEqual([...retained.keys()], ["new"]);

    let many = new Map<string, BackgroundPolicy.RetainedInteraction>();
    for (let index = 0; index < 70; index += 1) {
      many = BackgroundPolicy.retainInteraction(many, `c${index}`, NOW_MS, NOW_MS + index);
    }
    assert.equal(many.size, BackgroundPolicy.MAX_RETAINED_INTERACTIONS);
    assert.equal(many.has("c0"), false);
    assert.equal(many.has("c69"), true);
  });
});

const hostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: NOW,
};

const layer = BackgroundPolicy.layer.pipe(
  Layer.provide(
    Layer.merge(
      Layer.succeed(
        HostPowerMonitor.HostPowerMonitor,
        HostPowerMonitor.HostPowerMonitor.of({
          snapshot: Effect.succeed(hostPower),
          report: () => Effect.void,
          streamChanges: Stream.empty,
        }),
      ),
      ServerSettings.layerTest(),
    ),
  ),
);

describe("BackgroundPolicy.notificationTarget", () => {
  it.effect("follows the device the person touched last, and remembers it after a disconnect", () =>
    Effect.gen(function* () {
      // The test clock starts at zero; a long jump would run the lease sweep millions of times.
      const clockMs = 120_000;
      yield* TestClock.adjust(`${clockMs} millis`);
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const report = (clientId: string, rpc: number, interactedMsAgo: number | null) =>
        policy.reportClientActivity(AuthSessionId.make("session"), RpcClientId.make(rpc), {
          clientId,
          clientKind: "desktop-renderer",
          visible: false,
          focused: false,
          recentlyInteracted: false,
          scopes: [],
          ttlMs: 45_000,
          observedAt: DateTime.makeUnsafe(clockMs),
          hostEnvironmentId: clientId === "desk-self" ? SELF : OTHER,
          ...(interactedMsAgo === null
            ? {}
            : { lastInteractionAt: DateTime.makeUnsafe(clockMs - interactedMsAgo) }),
        });

      yield* report("desk-self", 1, null);
      yield* report("desk-other", 2, null);
      assert.deepStrictEqual(yield* policy.notificationTarget(SELF), {
        clientId: "desk-self",
        reason: "owner",
      });

      yield* report("desk-self", 1, 60_000);
      yield* report("desk-other", 2, 1_000);
      assert.deepStrictEqual(yield* policy.notificationTarget(SELF), {
        clientId: "desk-other",
        reason: "recent",
      });

      // desk-other reconnects after a reload with no interaction of its own yet.
      yield* policy.removeRpcClient(AuthSessionId.make("session"), RpcClientId.make(2));
      yield* report("desk-other", 3, null);
      assert.deepStrictEqual(yield* policy.notificationTarget(SELF), {
        clientId: "desk-other",
        reason: "recent",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("compares devices by how long ago they were used, whatever their clocks say", () =>
    Effect.gen(function* () {
      const clockMs = 120_000;
      yield* TestClock.adjust(`${clockMs} millis`);
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const report = (clientId: string, rpc: number, deviceClockMs: number, ageMs: number) =>
        policy.reportClientActivity(AuthSessionId.make("session"), RpcClientId.make(rpc), {
          clientId,
          clientKind: "desktop-renderer",
          visible: false,
          focused: false,
          recentlyInteracted: false,
          scopes: [],
          ttlMs: 45_000,
          observedAt: DateTime.makeUnsafe(deviceClockMs),
          lastInteractionAt: DateTime.makeUnsafe(deviceClockMs - ageMs),
        });
      // desk-slow's clock runs an hour behind; it was used one second ago.
      yield* report("desk-slow", 1, clockMs - 3_600_000, 1_000);
      yield* report("desk-right", 2, clockMs, 10_000);
      assert.deepStrictEqual(yield* policy.notificationTarget(SELF), {
        clientId: "desk-slow",
        reason: "recent",
      });
    }).pipe(Effect.provide(layer)),
  );
});
