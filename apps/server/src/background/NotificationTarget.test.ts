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

  it("passes over a client that stopped reporting though its lease runs on: it went to sleep", () => {
    const silent = DateTime.makeUnsafe(NOW_MS - BackgroundPolicy.NOTIFICATION_TARGET_STALE_MS - 1);
    const asleep = { updatedAt: silent, expiresAt: DateTime.makeUnsafe(NOW_MS + 5_000) };
    assert.deepStrictEqual(
      elect([
        lease("desk-asleep", { ...foreground, interactedSecondsAgo: 5, ...asleep }),
        lease("desk-b", { interactedSecondsAgo: 600 }),
      ]),
      { clientId: "desk-b", reason: "recent" },
    );
    // With nobody else left there is no target, so every app shows the alert.
    assert.equal(
      elect([lease("desk-self", { hostEnvironmentId: SELF, interactedSecondsAgo: 5, ...asleep })]),
      null,
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

const reading = (overrides: Partial<HostPowerSnapshot> = {}): HostPowerSnapshot => ({
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "unknown",
  thermalState: "nominal",
  stale: false,
  updatedAt: NOW,
  ...overrides,
});

function inUse(
  leases: readonly ClientActivityLease[],
  power: HostPowerSnapshot,
  selfEnvironmentId: EnvironmentId | null = SELF,
) {
  return BackgroundPolicy.ownerMachineInUse({
    leases,
    hostPower: power,
    selfEnvironmentId,
    now: NOW,
  });
}

const ownApp = (overrides: Partial<ClientActivityLease> & { interactedSecondsAgo?: number } = {}) =>
  lease("desk-self", { hostEnvironmentId: SELF, ...overrides });

describe("ownerMachineInUse (1436 AC-01, AC-13)", () => {
  it("is in use with input 20 s ago, whatever the app window does", () => {
    assert.deepStrictEqual(inUse([ownApp()], reading({ idleSeconds: 20 })), {
      inUse: true,
      reason: "input",
      inputAgeMs: 20_000,
    });
  });

  it("adds the report's age, so an old report only looks more idle", () => {
    const old = reading({ idleSeconds: 30, updatedAt: DateTime.makeUnsafe(NOW_MS - 100_000) });
    assert.deepStrictEqual(inUse([ownApp()], old), {
      inUse: false,
      reason: "idle",
      inputAgeMs: 130_000,
    });
  });

  it("is idle after 10 minutes without input, even with its window in front", () => {
    assert.strictEqual(
      inUse(
        [ownApp({ ...foreground, interactedSecondsAgo: 600 })],
        reading({ idleSeconds: 600, idle: "true" }),
      ).inUse,
      false,
    );
  });

  it("is not in use while locked or suspended", () => {
    assert.deepInclude(inUse([ownApp(foreground)], reading({ locked: "true" })), {
      inUse: false,
      reason: "locked",
    });
    assert.deepInclude(inUse([ownApp(foreground)], reading({ suspended: true })), {
      inUse: false,
      reason: "suspended",
    });
  });

  it("needs a live app on this machine", () => {
    assert.deepInclude(inUse([], reading()), { inUse: false, reason: "no-lease" });
    assert.deepInclude(inUse([lease("desk-other", { hostEnvironmentId: OTHER })], reading()), {
      inUse: false,
      reason: "no-lease",
    });
    assert.deepInclude(
      inUse([lease("phone", { clientKind: "mobile", hostEnvironmentId: SELF })], reading()),
      {
        inUse: false,
        reason: "no-lease",
      },
    );
    assert.deepInclude(inUse([ownApp()], reading(), null), { inUse: false, reason: "no-lease" });
    const quiet = ownApp({ updatedAt: DateTime.makeUnsafe(NOW_MS - 40_000) });
    assert.deepInclude(inUse([quiet], reading()), { inUse: false, reason: "no-lease" });
  });

  it("falls back to an app in front a person touched, without a usable reading", () => {
    const stale = reading({ stale: true, idleSeconds: 5 });
    assert.deepInclude(inUse([ownApp({ ...foreground, interactedSecondsAgo: 10 })], stale), {
      inUse: true,
      reason: "foreground",
    });
    assert.deepInclude(inUse([ownApp(foreground)], stale), { inUse: false, reason: "no-reading" });
    assert.deepInclude(
      inUse([ownApp({ ...foreground, interactedSecondsAgo: 300 })], reading({ idleSeconds: null })),
      { inUse: false, reason: "no-reading" },
    );
    assert.deepInclude(inUse([ownApp({ interactedSecondsAgo: 10 })], hostPower), {
      inUse: false,
      reason: "no-reading",
    });
  });

  it("(f) ignores the idle reading within 120 s of agent-injected input", () => {
    const agent = reading({ idleSeconds: 2, lastAgentInputAtMs: NOW_MS - 3_000 });
    assert.deepInclude(inUse([ownApp()], agent), { inUse: false, reason: "agent-input" });
    assert.deepInclude(inUse([ownApp({ ...foreground, interactedSecondsAgo: 4 })], agent), {
      inUse: true,
      reason: "foreground",
    });
    const longAgo = reading({ idleSeconds: 2, lastAgentInputAtMs: NOW_MS - 121_000 });
    assert.deepInclude(inUse([ownApp()], longAgo), { inUse: true, reason: "input" });
  });
});

describe("BackgroundPolicy.notificationDecision", () => {
  it.effect("returns the target and whether this machine is in use", () =>
    Effect.gen(function* () {
      const clockMs = 120_000;
      yield* TestClock.adjust(`${clockMs} millis`);
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      assert.deepStrictEqual(yield* policy.notificationDecision(SELF), {
        notificationTarget: null,
        ownerInUse: false,
      });
      yield* policy.reportClientActivity(AuthSessionId.make("session"), RpcClientId.make(1), {
        clientId: "desk-self",
        clientKind: "desktop-renderer",
        visible: false,
        focused: false,
        recentlyInteracted: false,
        scopes: [],
        ttlMs: 45_000,
        observedAt: DateTime.makeUnsafe(clockMs),
        hostEnvironmentId: SELF,
      });
      assert.deepStrictEqual(yield* policy.notificationDecision(SELF), {
        notificationTarget: { clientId: "desk-self", reason: "owner" },
        ownerInUse: true,
      });
    }).pipe(
      Effect.provide(
        BackgroundPolicy.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(
                HostPowerMonitor.HostPowerMonitor,
                HostPowerMonitor.HostPowerMonitor.of({
                  // Reported just now: input 20 s ago.
                  snapshot: Effect.map(DateTime.now, (updatedAt) =>
                    reading({ idleSeconds: 20, updatedAt }),
                  ),
                  report: () => Effect.void,
                  streamChanges: Stream.empty,
                }),
              ),
              ServerSettings.layerTest(),
            ),
          ),
        ),
      ),
    ),
  );
});
