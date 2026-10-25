import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@specweave-studio/contracts";
import { createModelCapabilities } from "@specweave-studio/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import type { RememberedSubscription, SubscriptionMemory } from "./subscriptionIdentity.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
};

function layerBackgroundPolicy(shouldRunScopeWork: boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: TEST_EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(shouldRunScopeWork),
    shouldRunScopeWork: () => Effect.succeed(shouldRunScopeWork),
    shouldRunOpportunisticWork: Effect.succeed(shouldRunScopeWork),
  });
}

const layerBackgroundPolicyAlwaysRun = layerBackgroundPolicy(true);
const layerBackgroundPolicyNeverRun = layerBackgroundPolicy(false);
const layerServerSettingsTest = ServerSettings.layerTest();
const layerAlwaysRunTest = Layer.merge(layerBackgroundPolicyAlwaysRun, layerServerSettingsTest);
const layerNeverRunTest = Layer.merge(layerBackgroundPolicyNeverRun, layerServerSettingsTest);

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

function refreshToUnsupported(driver: ProviderDriverKind, usageLimits: ServerProviderUsageLimits) {
  return Effect.scoped(
    Effect.gen(function* () {
      const releaseInitialCheck = yield* Deferred.make<void>();
      const checkCalls = yield* Ref.make(0);
      const unsupported: ServerProviderUsageLimits = {
        checkedAt: refreshedSnapshotSecond.checkedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      };
      const identity = { driver, instanceId: ProviderInstanceId.make(driver) };
      const provider = yield* makeManagedServerProvider<TestSettings>({
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
        initialSnapshot: () => Effect.succeed({ ...initialSnapshot, ...identity }),
        checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Deferred.await(releaseInitialCheck).pipe(
                  Effect.as({ ...refreshedSnapshot, ...identity, usageLimits }),
                )
              : Effect.succeed({
                  ...refreshedSnapshotSecond,
                  ...identity,
                  usageLimits: unsupported,
                }),
          ),
        ),
        refreshInterval: 0,
      });
      const initialUpdate = yield* Stream.take(provider.streamChanges, 1).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseInitialCheck, undefined);
      const [first] = Array.from(yield* Fiber.join(initialUpdate));
      assert.deepStrictEqual(first?.usageLimits, usageLimits);

      const refreshed = yield* provider.refresh;
      assert.strictEqual(refreshed.driver, driver);
      assert.strictEqual(refreshed.checkedAt, refreshedSnapshotSecond.checkedAt);
      assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
      assert.deepStrictEqual(yield* provider.getSnapshot, refreshed);
      assert.strictEqual(yield* Ref.get(checkCalls), 2);
      return { refreshed, unsupported };
    }),
  ).pipe(Effect.provide(layerAlwaysRunTest));
}

function refreshAcrossLogins(
  driver: ProviderDriverKind,
  first: { readonly email: string; readonly usageLimits: ServerProviderUsageLimits },
  second: { readonly email: string; readonly usageLimits: ServerProviderUsageLimits },
) {
  return refreshThroughLogins(driver, [first, second]).pipe(
    Effect.map((snapshots) => snapshots[1]!),
  );
}

/** One probe per login, in order; `email: null` is a probe that is signed out. */
function refreshThroughLogins(
  driver: ProviderDriverKind,
  logins: ReadonlyArray<{
    readonly email: string | null;
    readonly usageLimits: ServerProviderUsageLimits;
    readonly auth?: Partial<ServerProvider["auth"]>;
  }>,
  subscriptionMemory?: SubscriptionMemory,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const checkCalls = yield* Ref.make(0);
      const identity = { driver, instanceId: ProviderInstanceId.make(driver) };
      const provider = yield* makeManagedServerProvider<TestSettings>({
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
        initialSnapshot: () => Effect.succeed({ ...initialSnapshot, ...identity }),
        checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
          Effect.map((count) => {
            const login = logins[count - 1]!;
            return {
              ...(count === 1 ? refreshedSnapshot : refreshedSnapshotSecond),
              ...identity,
              auth:
                login.email === null
                  ? { status: "unauthenticated" as const }
                  : { status: "authenticated" as const, email: login.email, ...login.auth },
              usageLimits: login.usageLimits,
            };
          }),
        ),
        refreshInterval: 0,
        ...(subscriptionMemory ? { subscriptionMemory } : {}),
      });
      const snapshots = [];
      for (const _login of logins) snapshots.push(yield* provider.refresh);
      return snapshots;
    }),
  ).pipe(Effect.provide(layerAlwaysRunTest));
}

const exhaustedClaudeLimits: ServerProviderUsageLimits = {
  checkedAt: refreshedSnapshot.checkedAt,
  windows: [
    { id: "five_hour", kind: "session", label: "Session", usedPercent: 100 },
    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 },
  ],
  ordinaryUsageAllowed: false,
  nativeDenialObservedAt: refreshedSnapshot.checkedAt,
  nativeDenialRequiresFullRead: true,
};

describe("makeManagedServerProvider", () => {
  it.effect("shows only the new Claude account's usage after a login switch", () => {
    // No allowance witness: one of the new account's buckets is full, which
    // alone would keep the old account's denial on screen.
    const newAccount: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent: 4 },
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 10 },
        { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 100 },
      ],
    };
    return refreshAcrossLogins(
      ProviderDriverKind.make("claudeAgent"),
      { email: "old@example.com", usageLimits: exhaustedClaudeLimits },
      { email: "New@Example.com", usageLimits: newAccount },
    ).pipe(
      Effect.map((refreshed) =>
        assert.deepStrictEqual(refreshed.usageLimits, {
          ...newAccount,
          accountChangedAt: newAccount.checkedAt,
        }),
      ),
    );
  });

  it.effect("does not carry Claude usage into a login whose limits cannot be read", () => {
    const unsupported: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    };
    return refreshAcrossLogins(
      ProviderDriverKind.make("claudeAgent"),
      { email: "old@example.com", usageLimits: exhaustedClaudeLimits },
      { email: "new@example.com", usageLimits: unsupported },
    ).pipe(
      Effect.map((refreshed) =>
        assert.deepStrictEqual(refreshed.usageLimits, {
          ...unsupported,
          accountChangedAt: unsupported.checkedAt,
        }),
      ),
    );
  });

  it.effect("keeps the same Claude login's denial until a full read clears it", () => {
    const partial: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
    };
    return refreshAcrossLogins(
      ProviderDriverKind.make("claudeAgent"),
      { email: "same@example.com", usageLimits: exhaustedClaudeLimits },
      { email: "SAME@example.com", usageLimits: partial },
    ).pipe(
      Effect.map((refreshed) =>
        assert.deepStrictEqual(refreshed.usageLimits, exhaustedClaudeLimits),
      ),
    );
  });

  it.effect("marks when the Claude account changed and keeps the mark for that account", () => {
    const old: ServerProviderUsageLimits = { ...exhaustedClaudeLimits };
    const next: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 14 }],
      nativeAllowanceObservedAt: refreshedSnapshotSecond.checkedAt,
    };
    return refreshThroughLogins(ProviderDriverKind.make("claudeAgent"), [
      { email: "old@example.com", usageLimits: old },
      { email: "new@example.com", usageLimits: next },
      { email: "new@example.com", usageLimits: next },
    ]).pipe(
      Effect.map(([first, switched, same]) => {
        // The first read after a start has nothing to compare with.
        assert.isUndefined(first?.usageLimits?.accountChangedAt);
        assert.strictEqual(switched?.usageLimits?.accountChangedAt, next.checkedAt);
        assert.strictEqual(same?.usageLimits?.accountChangedAt, next.checkedAt);
      }),
    );
  });

  it.effect("counts a sign-out between two Claude accounts as a change", () => {
    const signedOut: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const next: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 14 }],
      nativeAllowanceObservedAt: refreshedSnapshotSecond.checkedAt,
    };
    return refreshThroughLogins(ProviderDriverKind.make("claudeAgent"), [
      { email: "old@example.com", usageLimits: exhaustedClaudeLimits },
      { email: null, usageLimits: signedOut },
      { email: "new@example.com", usageLimits: next },
    ]).pipe(
      Effect.map(([, out, back]) => {
        assert.isUndefined(out?.usageLimits?.accountChangedAt);
        assert.deepStrictEqual(back?.usageLimits, { ...next, accountChangedAt: next.checkedAt });
      }),
    );
  });

  it.effect("keeps the change mark through a sign-out and back in to the new account", () => {
    const next: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 14 }],
      nativeAllowanceObservedAt: refreshedSnapshotSecond.checkedAt,
    };
    const later = "2099-01-01T00:10:00.000Z";
    // A signed-out read replaces the published usage, mark and all.
    const signedOut: ServerProviderUsageLimits = { checkedAt: later, windows: [] };
    const again: ServerProviderUsageLimits = {
      ...next,
      checkedAt: later,
      nativeAllowanceObservedAt: later,
    };
    return refreshThroughLogins(ProviderDriverKind.make("claudeAgent"), [
      { email: "old@example.com", usageLimits: exhaustedClaudeLimits },
      { email: "new@example.com", usageLimits: next },
      { email: null, usageLimits: signedOut },
      { email: "New@Example.com", usageLimits: again },
    ]).pipe(
      Effect.map(([, switched, out, back]) => {
        assert.strictEqual(switched?.usageLimits?.accountChangedAt, next.checkedAt);
        assert.isUndefined(out?.usageLimits?.accountChangedAt);
        // The mark of the change, not of the sign-in after the sign-out.
        assert.deepStrictEqual(back?.usageLimits, { ...again, accountChangedAt: next.checkedAt });
      }),
    );
  });

  it.effect("signing back in to the same Claude account is no change", () => {
    const signedOut: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    return refreshThroughLogins(ProviderDriverKind.make("claudeAgent"), [
      { email: "same@example.com", usageLimits: exhaustedClaudeLimits },
      { email: null, usageLimits: signedOut },
      { email: "Same@Example.com", usageLimits: exhaustedClaudeLimits },
    ]).pipe(
      Effect.map((snapshots) =>
        assert.deepStrictEqual(
          snapshots.map((snapshot) => snapshot.usageLimits?.accountChangedAt),
          [undefined, undefined, undefined],
        ),
      ),
    );
  });

  describe("same-CLI subscription changes", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const keyA = `claude:sha256:${"a".repeat(64)}`;
    const keyB = `claude:sha256:${"b".repeat(64)}`;
    const read = (checkedAt: string, subscriptionKey?: string): ServerProviderUsageLimits => ({
      checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 3 }],
      nativeAllowanceObservedAt: checkedAt,
      ...(subscriptionKey ? { subscriptionKey } : {}),
    });
    const first = refreshedSnapshot.checkedAt;
    const second = refreshedSnapshotSecond.checkedAt;
    const memory = (stored?: RememberedSubscription) => {
      const saved: Array<RememberedSubscription> = [];
      const store: SubscriptionMemory = {
        load: Effect.succeed(stored),
        save: (value) => Effect.sync(() => void saved.push(value)),
      };
      return { saved, store };
    };

    it.effect("tells two subscriptions on one email apart by their key", () =>
      refreshThroughLogins(claude, [
        {
          email: "me@example.com",
          usageLimits: { ...exhaustedClaudeLimits, subscriptionKey: keyA },
        },
        { email: "me@example.com", usageLimits: read(second, keyB) },
      ]).pipe(
        Effect.map(([, switched]) =>
          assert.deepStrictEqual(switched?.usageLimits, {
            ...read(second, keyB),
            accountChangedAt: second,
          }),
        ),
      ),
    );

    it.effect("counts no change for a read that cannot name the subscription", () =>
      refreshThroughLogins(claude, [
        { email: "me@example.com", usageLimits: read(first, keyA) },
        { email: "me@example.com", usageLimits: read(second) },
        { email: "me@example.com", usageLimits: read(second, keyA) },
      ]).pipe(
        Effect.map((snapshots) =>
          assert.deepStrictEqual(
            snapshots.map((snapshot) => snapshot.usageLimits?.accountChangedAt),
            [undefined, undefined, undefined],
          ),
        ),
      ),
    );

    it.effect("still sees a change past an unreadable read in between", () =>
      refreshThroughLogins(claude, [
        { email: "me@example.com", usageLimits: read(first, keyA) },
        { email: "me@example.com", usageLimits: read(first) },
        { email: "me@example.com", usageLimits: read(second, keyB) },
      ]).pipe(
        Effect.map(([, between, switched]) => {
          assert.isUndefined(between?.usageLimits?.accountChangedAt);
          assert.strictEqual(switched?.usageLimits?.accountChangedAt, second);
        }),
      ),
    );

    it.effect("notices a subscription changed while the server was down", () => {
      const { saved, store } = memory({ identity: { key: keyA } });
      return refreshThroughLogins(
        claude,
        [{ email: "me@example.com", usageLimits: read(second, keyB) }],
        store,
      ).pipe(
        Effect.map(([afterRestart]) => {
          assert.strictEqual(afterRestart?.usageLimits?.accountChangedAt, second);
          assert.strictEqual(saved.at(-1)?.identity.key, keyB);
          assert.strictEqual(saved.at(-1)?.changedAt, second);
          // Only hashes are kept, never the email itself.
          assert.notInclude(JSON.stringify(saved), "me@example.com");
        }),
      );
    });

    it.effect("keeps the remembered change time for the same subscription after a restart", () => {
      const { saved, store } = memory({ identity: { key: keyB }, changedAt: first });
      return refreshThroughLogins(
        claude,
        [{ email: "me@example.com", usageLimits: read(second, keyB) }],
        store,
      ).pipe(
        Effect.map(([afterRestart]) => {
          assert.strictEqual(afterRestart?.usageLimits?.accountChangedAt, first);
          // The email hash is new to the memory, so it is saved; the stamp is not moved.
          assert.isTrue(saved.every((value) => value.changedAt === first));
        }),
      );
    });

    it.effect("never treats a switch to API-key billing as a subscription change", () =>
      refreshThroughLogins(claude, [
        { email: "me@example.com", usageLimits: read(first, keyA) },
        {
          email: "other@example.com",
          usageLimits: read(second),
          auth: { apiKeyBilling: true },
        },
      ]).pipe(
        Effect.map(([, apiKey]) => assert.isUndefined(apiKey?.usageLimits?.accountChangedAt)),
      ),
    );
  });

  it.effect("shows only the new Codex account's usage after a login switch", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshotSecond.checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    return refreshAcrossLogins(
      ProviderDriverKind.make("codex"),
      {
        email: "old@example.com",
        usageLimits: {
          checkedAt: refreshedSnapshot.checkedAt,
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 100 }],
          ordinaryUsageAllowed: false,
          nativeDenialObservedAt: refreshedSnapshot.checkedAt,
        },
      },
      { email: "new@example.com", usageLimits: failed },
    ).pipe(
      Effect.map((refreshed) =>
        assert.deepStrictEqual(refreshed.usageLimits, {
          ...failed,
          accountChangedAt: failed.checkedAt,
        }),
      ),
    );
  });

  it.effect(
    "retains Claude exhausted windows and native denial through an unsupported refresh",
    () => {
      const usageLimits: ServerProviderUsageLimits = {
        checkedAt: refreshedSnapshot.checkedAt,
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
        ordinaryUsageAllowed: false,
        nativeAllowanceObservedAt: initialSnapshot.checkedAt,
        nativeDenialObservedAt: refreshedSnapshot.checkedAt,
        nativeDenialRequiresFullRead: true,
      };
      return refreshToUnsupported(ProviderDriverKind.make("claudeAgent"), usageLimits).pipe(
        Effect.map(({ refreshed, unsupported }) => {
          assert.deepStrictEqual(refreshed.usageLimits, {
            ...usageLimits,
            checkedAt: unsupported.checkedAt,
            unavailable: unsupported.unavailable,
          });
        }),
      );
    },
  );

  it.effect("retains Claude malformed-response evidence through an unsupported refresh", () => {
    const usageLimits: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshot.checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 0 }],
      unavailable: { reason: "probeFailed", invalidResponse: true },
      nativeAllowanceObservedAt: initialSnapshot.checkedAt,
    };
    return refreshToUnsupported(ProviderDriverKind.make("claudeAgent"), usageLimits).pipe(
      Effect.map(({ refreshed, unsupported }) => {
        assert.deepStrictEqual(refreshed.usageLimits, {
          ...usageLimits,
          checkedAt: unsupported.checkedAt,
        });
      }),
    );
  });

  it.effect("still replaces Codex usage evidence with an unsupported refresh", () => {
    const usageLimits: ServerProviderUsageLimits = {
      checkedAt: refreshedSnapshot.checkedAt,
      windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 100 }],
      ordinaryUsageAllowed: false,
      nativeDenialObservedAt: refreshedSnapshot.checkedAt,
    };
    return refreshToUnsupported(ProviderDriverKind.make("codex"), usageLimits).pipe(
      Effect.map(({ refreshed, unsupported }) => {
        assert.strictEqual(refreshed.usageLimits, unsupported);
      }),
    );
  });

  it.effect(
    "runs the initial provider check in the background and streams the refreshed snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const releaseCheck = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial, initialSnapshot);

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(checkCalls), 1);

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latest = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latest, refreshedSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("skips periodic provider refreshes without foreground provider-status demand", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerNeverRunTest, TestClock.layer()))),
  );

  it.effect("disables periodic provider refreshes when the explicit interval is zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: 0,
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("keeps manual refresh when interval refresh is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
          refreshOnInterval: false,
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        yield* provider.refresh;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("wakes a sleeping provider refresh loop when its interval changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerHealthRefreshInterval: Duration.hours(1),
        };
        const serverSettingsRef = yield* Ref.make(initialServerSettings);
        const serverSettingsChanges = yield* PubSub.unbounded<typeof initialServerSettings>();
        const layerServerSettings = Layer.succeed(
          ServerSettings.ServerSettingsService,
          ServerSettings.ServerSettingsService.of({
            start: Effect.void,
            ready: Effect.void,
            getSettings: Ref.get(serverSettingsRef),
            updateSettings: () => Effect.die(new Error("unused in this test")),
            updateProviderInstance: () => Effect.die(new Error("unused in this test")),
            withSettingsSnapshot: (use) => Ref.get(serverSettingsRef).pipe(Effect.flatMap(use)),
            streamChanges: Stream.empty,
            subscribeChanges: PubSub.subscribe(serverSettingsChanges).pipe(
              Effect.map((subscription) => Stream.fromSubscription(subscription)),
            ),
          }),
        );
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const periodicCheckDone = yield* Deferred.make<void>();

        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Deferred.succeed(periodicCheckDone, undefined).pipe(Effect.ignore),
            ),
            Effect.as(refreshedSnapshot),
          ),
        }).pipe(Effect.provide(Layer.merge(layerBackgroundPolicyAlwaysRun, layerServerSettings)));

        yield* Deferred.await(initialCheckDone);
        const nextServerSettings = {
          ...initialServerSettings,
          providerHealthRefreshInterval: Duration.seconds(1),
        };
        yield* Ref.set(serverSettingsRef, nextServerSettings);
        yield* PubSub.publish(serverSettingsChanges, nextServerSettings);
        yield* Effect.yieldNow;

        yield* TestClock.adjust("999 millis");
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(periodicCheckDone);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("can update settings and disable periodic checks without probing again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const enrichmentCalls = yield* Ref.make(0);
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)),
            Effect.as(refreshedSnapshot),
          ),
          enrichSnapshot: () => Ref.update(enrichmentCalls, (count) => count + 1),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(yield* Ref.get(enrichmentCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("applies runtime usage updates onto the published snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            usageLimits: {
              checkedAt: "2026-04-10T00:00:01.000Z",
              windows: [
                { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 20,
                  resetsAt: "2026-04-17T00:00:00.000Z",
                },
              ],
            },
          } satisfies ServerProvider),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        // Percent-only weekly update: keeps the probe's reset time.
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
        });
        // No windows: nothing to merge, nothing published.
        yield* provider.applyUsageLimits({ checkedAt: "2026-04-10T00:06:00.000Z", windows: [] });

        const [update] = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(update?.usageLimits, {
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 25,
              resetsAt: "2026-04-17T00:00:00.000Z",
            },
          ],
        });
        assert.deepStrictEqual(yield* provider.getSnapshot, update);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps live usage windows across a failed probe and a stale enrichment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const refreshCount = yield* Ref.make(0);
        const probedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? { ...refreshedSnapshot, usageLimits: probedLimits }
                : {
                    ...refreshedSnapshotSecond,
                    usageLimits: {
                      checkedAt: "2026-04-10T00:00:03.000Z",
                      windows: [],
                      unavailable: { reason: "probeFailed" },
                    },
                  },
            ),
          ),
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() =>
                publishSnapshot({
                  ...enrichedSnapshot,
                  ...snapshot,
                  models: enrichedSnapshot.models,
                }),
              ),
            ),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const liveWindow = {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 60,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [liveWindow],
        });

        // Enrichment computed from the pre-update snapshot lands afterwards.
        yield* Deferred.succeed(releaseEnrichment, undefined);
        const enriched = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]!),
        );
        assert.deepStrictEqual(enriched.models, enrichedSnapshot.models);
        assert.deepStrictEqual(enriched.usageLimits?.windows, [liveWindow]);

        // A probe that could not read usage keeps the last good windows.
        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
        assert.deepStrictEqual(refreshed.usageLimits?.windows, [liveWindow]);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
