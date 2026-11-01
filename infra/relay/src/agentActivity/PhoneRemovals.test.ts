import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import type { RelayDeviceRegistrationRequest } from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import {
  relayClientKeys,
  relayLiveActivities,
  relayMobileDeviceRemovals,
  relayMobileDevices,
} from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as Devices from "./Devices.ts";
import * as PhoneRemovals from "./PhoneRemovals.ts";

const USER = "user-1";

const registration = (
  deviceId: string,
  overrides: Partial<RelayDeviceRegistrationRequest> = {},
): RelayDeviceRegistrationRequest => ({
  deviceId,
  label: `Phone ${deviceId}`,
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: "1.2.0",
  pushToken: `push-${deviceId}`,
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  ...overrides,
});

const layer = () =>
  Layer.mergeAll(PhoneRemovals.layer, Devices.layer).pipe(
    Layer.provideMerge(Layer.merge(layerSqliteRelayDb(), NodeCryptoLayer.layer)),
  );

const register = (
  deviceId: string,
  options: {
    readonly userId?: string;
    readonly key?: string;
    readonly sid?: string;
    readonly model?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const devices = yield* Devices.Devices;
    yield* devices.register({
      userId: options.userId ?? USER,
      registration: registration(deviceId, options.model ? { model: options.model } : {}),
      proofKeyThumbprint: options.key,
      clerkSessionId: options.sid,
    });
  });

const deviceIds = (userId = USER) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const devices = yield* Devices.Devices;
    const liveActivities = yield* db
      .select({ deviceId: relayLiveActivities.deviceId })
      .from(relayLiveActivities);
    return {
      devices: (yield* devices.listForUser({ userId })).map((device) => device.deviceId).sort(),
      liveActivities: liveActivities.map((row) => row.deviceId).sort(),
    };
  });

const insertLiveActivity = (deviceId: string) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db.insert(relayLiveActivities).values({
      userId: USER,
      deviceId,
      activityPushToken: `activity-${deviceId}`,
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
    });
  });

const insertDevice = (
  deviceId: string,
  options: { readonly key?: string; readonly sid?: string; readonly at?: string } = {},
) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const at = options.at ?? "2026-10-01T00:00:00.000Z";
    yield* db.insert(relayMobileDevices).values({
      userId: USER,
      deviceId,
      label: `Phone ${deviceId}`,
      platform: "ios",
      proofKeyThumbprint: options.key ?? null,
      clerkSessionId: options.sid ?? null,
      lastSeenAt: at,
      preferencesJson: registration(deviceId).preferences,
      createdAt: at,
      updatedAt: at,
    });
  });

describe("PhoneRemovals", () => {
  it.effect("removes a phone by device id and keeps it refused", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      yield* register("phone-a", { key: "key-a", sid: "sess_a", model: "iPhone 16 Pro" });
      yield* register("phone-b", { key: "key-b", sid: "sess_b" });
      yield* insertLiveActivity("phone-a");
      yield* insertLiveActivity("phone-b");

      expect(yield* removals.findBlocking({ userId: USER, deviceId: "phone-a" })).toBeNull();
      expect(yield* removals.remove({ userId: USER, deviceId: "phone-a" })).toEqual({
        removed: true,
        clerkSessionIds: ["sess_a"],
        proofKeyThumbprints: ["key-a"],
      });
      // Pushes stop: the phone and its Live Activity are gone; the other phone stays.
      expect(yield* deviceIds()).toEqual({ devices: ["phone-b"], liveActivities: ["phone-b"] });

      const byDevice = yield* removals.findBlocking({ userId: USER, deviceId: "phone-a" });
      expect(byDevice).toMatchObject({
        deviceId: "phone-a",
        proofKeyThumbprint: "key-a",
        clerkSessionId: "sess_a",
        label: "Phone phone-a",
      });
      expect(
        yield* removals.findBlocking({ userId: USER, proofKeyThumbprint: "key-a" }),
      ).toMatchObject({ id: byDevice?.id });
      // Removals are per account.
      expect(
        yield* removals.findBlocking({ userId: "user-2", proofKeyThumbprint: "key-a" }),
      ).toBeNull();
      expect(yield* removals.findBlocking({ userId: USER })).toBeNull();

      // Idempotent: a retry reports the same phone without adding rows.
      expect(yield* removals.remove({ userId: USER, deviceId: "phone-a" })).toEqual({
        removed: true,
        clerkSessionIds: ["sess_a"],
        proofKeyThumbprints: ["key-a"],
      });
      expect(yield* removals.listRemovedThumbprints({ userId: USER })).toEqual(["key-a"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("reports an unknown phone as not removed and records nothing", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      expect(yield* removals.remove({ userId: USER, deviceId: "missing" })).toEqual({
        removed: false,
        clerkSessionIds: [],
        proofKeyThumbprints: [],
      });
      expect(yield* removals.findBlocking({ userId: USER, deviceId: "missing" })).toBeNull();
    }).pipe(Effect.provide(layer())),
  );

  it.effect("removes every registration holding the key, as a Mac does by thumbprint", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      // A reinstall keeps the Keychain key under a new device id; these rows
      // predate registration dropping the older install.
      yield* insertDevice("old-install", { key: "key-a", sid: "sess_old" });
      yield* insertDevice("new-install", { key: "key-a", sid: "sess_new" });
      yield* register("other", { key: "key-b" });

      const result = yield* removals.remove({ userId: USER, deviceId: "new-install" });
      expect(result.removed).toBe(true);
      expect([...result.clerkSessionIds].sort()).toEqual(["sess_new", "sess_old"]);
      expect(result.proofKeyThumbprints).toEqual(["key-a"]);
      expect((yield* deviceIds()).devices).toEqual(["other"]);

      expect(yield* removals.remove({ userId: USER, proofKeyThumbprint: "key-b" })).toEqual({
        removed: true,
        clerkSessionIds: [],
        proofKeyThumbprints: ["key-b"],
      });
      expect((yield* deviceIds()).devices).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("records a key-only removal when no registration holds the key", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      expect(yield* removals.remove({ userId: USER, proofKeyThumbprint: "key-web" })).toEqual({
        removed: true,
        clerkSessionIds: [],
        proofKeyThumbprints: ["key-web"],
      });
      expect(
        yield* removals.findBlocking({ userId: USER, proofKeyThumbprint: "key-web" }),
      ).toMatchObject({ deviceId: null, proofKeyThumbprint: "key-web", clerkSessionId: null });
      // A retry does not add a second key-only row.
      yield* removals.remove({ userId: USER, proofKeyThumbprint: "key-web" });
      expect(yield* removals.listRemovedThumbprints({ userId: USER })).toEqual(["key-web"]);

      yield* removals.clear({ userId: USER, deviceId: "phone", proofKeyThumbprint: "key-web" });
      expect(
        yield* removals.findBlocking({ userId: USER, proofKeyThumbprint: "key-web" }),
      ).toBeNull();
      expect(yield* removals.listRemovedThumbprints({ userId: USER })).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("returns the newest matching removal", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      yield* TestClock.setTime(Date.parse("2026-10-31T10:00:00.000Z"));
      yield* removals.remove({ userId: USER, proofKeyThumbprint: "key-a" });
      yield* TestClock.setTime(Date.parse("2026-10-31T11:00:00.000Z"));
      yield* register("phone-a", { key: "key-b", sid: "sess_b" });
      yield* removals.remove({ userId: USER, deviceId: "phone-a" });

      expect(
        yield* removals.findBlocking({
          userId: USER,
          deviceId: "phone-a",
          proofKeyThumbprint: "key-a",
        }),
      ).toMatchObject({ removedAt: "2026-10-31T11:00:00.000Z", proofKeyThumbprint: "key-b" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("lists phones with model, last use and the caller's own phone", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      const devices = yield* Devices.Devices;
      const db = yield* RelayDb.RelayDb;
      yield* TestClock.setTime(Date.parse("2026-10-31T10:00:00.000Z"));
      yield* register("phone-a", { key: "key-a", sid: "sess_a", model: "iPhone 16 Pro" });
      yield* TestClock.setTime(Date.parse("2026-10-31T11:00:00.000Z"));
      yield* register("phone-b", { key: "key-b" });
      yield* register("someone-else", { userId: "user-2", sid: "sess_a" });
      // A row written before this release has no last-use time.
      yield* db.insert(relayMobileDevices).values({
        userId: USER,
        deviceId: "legacy",
        label: "Old phone",
        platform: "android",
        androidApiLevel: 34,
        preferencesJson: registration("legacy").preferences,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      yield* TestClock.setTime(Date.parse("2026-10-31T12:00:00.000Z"));
      // A connect records use, the key and the session.
      yield* devices.touch({
        userId: USER,
        deviceId: "phone-b",
        proofKeyThumbprint: "key-b2",
        clerkSessionId: "sess_b",
      });
      // Unknown devices are left alone.
      yield* devices.touch({ userId: USER, deviceId: "missing", proofKeyThumbprint: "key-x" });

      expect(yield* removals.listPhones({ userId: USER, clerkSessionId: "sess_a" })).toEqual([
        {
          deviceId: "phone-b",
          label: "Phone phone-b",
          platform: "ios",
          model: null,
          appVersion: "1.2.0",
          lastSeenAt: "2026-10-31T12:00:00.000Z",
          current: false,
        },
        {
          deviceId: "phone-a",
          label: "Phone phone-a",
          platform: "ios",
          model: "iPhone 16 Pro",
          appVersion: "1.2.0",
          lastSeenAt: "2026-10-31T10:00:00.000Z",
          current: true,
        },
        {
          deviceId: "legacy",
          label: "Old phone",
          platform: "android",
          model: null,
          appVersion: null,
          lastSeenAt: "2026-09-02T00:00:00.000Z",
          current: false,
        },
      ]);
      // Without a session id, no phone is the caller's.
      expect((yield* removals.listPhones({ userId: USER })).every((phone) => !phone.current)).toBe(
        true,
      );
      // The touched key is what a later removal copies.
      expect(yield* removals.remove({ userId: USER, deviceId: "phone-b" })).toMatchObject({
        clerkSessionIds: ["sess_b"],
        proofKeyThumbprints: ["key-b2"],
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("marks every registration holding the caller's key as current", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      // A reinstall left the old install's row under the same key.
      yield* insertDevice("old-install", { key: "key-a", at: "2026-10-01T00:00:00.000Z" });
      yield* insertDevice("new-install", {
        key: "key-a",
        sid: "sess_a",
        at: "2026-10-02T00:00:00.000Z",
      });
      yield* insertDevice("other", { key: "key-b", at: "2026-10-03T00:00:00.000Z" });

      const current = (phones: ReadonlyArray<{ deviceId: string; current: boolean }>) =>
        phones.filter((phone) => phone.current).map((phone) => phone.deviceId);
      expect(
        current(yield* removals.listPhones({ userId: USER, clerkSessionId: "sess_a" })),
      ).toEqual(["new-install", "old-install"]);
      // The caller's own DPoP key marks its phone without a session match.
      expect(
        current(yield* removals.listPhones({ userId: USER, proofKeyThumbprint: "key-b" })),
      ).toEqual(["other"]);
      expect(
        current(yield* removals.listPhones({ userId: USER, clerkSessionId: "sess_none" })),
      ).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("drops the same phone's older install when it registers or connects", () =>
    Effect.gen(function* () {
      yield* register("old-install", { key: "key-a", sid: "sess_old" });
      yield* register("elsewhere", { userId: "user-2", key: "key-a" });
      yield* insertLiveActivity("old-install");
      yield* register("new-install", { key: "key-a", sid: "sess_new" });
      expect(yield* deviceIds()).toEqual({ devices: ["new-install"], liveActivities: [] });
      // Another account's row is its own.
      expect((yield* deviceIds("user-2")).devices).toEqual(["elsewhere"]);

      // A connect with a key another install holds drops that install too.
      const devices = yield* Devices.Devices;
      yield* register("phone-b", { key: "key-b" });
      yield* devices.touch({ userId: USER, deviceId: "phone-b", proofKeyThumbprint: "key-a" });
      expect((yield* deviceIds()).devices).toEqual(["phone-b"]);
      // An unregistered device drops nothing.
      yield* devices.touch({ userId: USER, deviceId: "missing", proofKeyThumbprint: "key-a" });
      expect((yield* deviceIds()).devices).toEqual(["phone-b"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("keeps notification preferences when a registration has no push token", () =>
    Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const off = { ...registration("x").preferences, notificationsEnabled: false };
      const enabled = (deviceId: string) =>
        devices
          .listForUser({ userId: USER })
          .pipe(
            Effect.map(
              (rows) => rows.find((row) => row.deviceId === deviceId)?.notifications.enabled,
            ),
          );
      const registerWith = (deviceId: string, overrides: Partial<RelayDeviceRegistrationRequest>) =>
        devices.register({ userId: USER, registration: registration(deviceId, overrides) });

      yield* registerWith("phone-a", {});
      // Registered again before notifications are set up on this install.
      yield* registerWith("phone-a", { pushToken: undefined, preferences: off });
      expect(yield* enabled("phone-a")).toBe(true);
      // With a push token, the new preferences apply.
      yield* registerWith("phone-a", { preferences: off });
      expect(yield* enabled("phone-a")).toBe(false);

      // A row with no push token takes the new preferences.
      yield* registerWith("phone-b", { pushToken: undefined });
      yield* registerWith("phone-b", { pushToken: undefined, preferences: off });
      expect(yield* enabled("phone-b")).toBe(false);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("keeps the stored key, session and model when an older build re-registers", () =>
    Effect.gen(function* () {
      const removals = yield* PhoneRemovals.PhoneRemovals;
      yield* register("phone-a", { key: "key-a", sid: "sess_a", model: "iPhone 16" });
      yield* register("phone-a");
      expect(yield* removals.listPhones({ userId: USER, clerkSessionId: "sess_a" })).toEqual([
        expect.objectContaining({ model: "iPhone 16", current: true }),
      ]);
      expect(yield* removals.remove({ userId: USER, deviceId: "phone-a" })).toMatchObject({
        proofKeyThumbprints: ["key-a"],
      });
    }).pipe(Effect.provide(layer())),
  );

  describe("key records from token exchange", () => {
    const record = (input: {
      readonly key: string;
      readonly clientId?: "studio-mobile" | "studio-web";
      readonly deviceId?: string;
      readonly sid?: string;
      readonly userId?: string;
    }) =>
      Effect.gen(function* () {
        const removals = yield* PhoneRemovals.PhoneRemovals;
        yield* removals.recordClientKey({
          userId: input.userId ?? USER,
          proofKeyThumbprint: input.key,
          clientId: input.clientId ?? "studio-mobile",
          deviceId: input.deviceId,
          clerkSessionId: input.sid,
        });
      });

    const keyRows = Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      return yield* db
        .select({
          userId: relayClientKeys.userId,
          key: relayClientKeys.proofKeyThumbprint,
          clientId: relayClientKeys.clientId,
          deviceId: relayClientKeys.deviceId,
          sid: relayClientKeys.clerkSessionId,
        })
        .from(relayClientKeys);
    });

    it.effect("upserts one row per key, keeping a known device id and session", () =>
      Effect.gen(function* () {
        yield* record({ key: "key-a", deviceId: "phone-a", sid: "sess_1" });
        // An older build exchanges without a device id; a refresh keeps the session.
        yield* record({ key: "key-a" });
        expect(yield* keyRows).toEqual([
          {
            userId: USER,
            key: "key-a",
            clientId: "studio-mobile",
            deviceId: "phone-a",
            sid: "sess_1",
          },
        ]);
        yield* record({ key: "key-a", sid: "sess_2" });
        expect((yield* keyRows)[0]?.sid).toBe("sess_2");
      }).pipe(Effect.provide(layer())),
    );

    it.effect(
      "removes a registration with no key or session using what its exchanges recorded",
      () =>
        Effect.gen(function* () {
          const removals = yield* PhoneRemovals.PhoneRemovals;
          yield* register("phone-a");
          yield* record({ key: "key-a", deviceId: "phone-a", sid: "sess_a" });
          // Another account's identical device id is not this phone.
          yield* record({ key: "key-x", deviceId: "phone-a", sid: "sess_x", userId: "user-2" });

          expect(yield* removals.remove({ userId: USER, deviceId: "phone-a" })).toEqual({
            removed: true,
            clerkSessionIds: ["sess_a"],
            proofKeyThumbprints: ["key-a"],
          });
          expect(
            yield* removals.findBlocking({ userId: USER, proofKeyThumbprint: "key-a" }),
          ).toMatchObject({
            deviceId: "phone-a",
            proofKeyThumbprint: "key-a",
            clerkSessionId: "sess_a",
            label: "Phone phone-a",
          });
          // Key records of the removed phone go with it.
          expect((yield* keyRows).map((row) => row.key)).toEqual(["key-x"]);
          // Idempotent.
          expect(yield* removals.remove({ userId: USER, deviceId: "phone-a" })).toEqual({
            removed: true,
            clerkSessionIds: ["sess_a"],
            proofKeyThumbprints: ["key-a"],
          });
          const db = yield* RelayDb.RelayDb;
          expect(yield* db.select().from(relayMobileDeviceRemovals)).toHaveLength(1);
        }).pipe(Effect.provide(layer())),
    );

    it.effect("removes every key and session a device id exchanged, registered or not", () =>
      Effect.gen(function* () {
        const removals = yield* PhoneRemovals.PhoneRemovals;
        yield* register("phone-a", { key: "key-a1", sid: "sess_1" });
        yield* record({ key: "key-a1", deviceId: "phone-a", sid: "sess_2" });
        yield* record({ key: "key-a2", deviceId: "phone-a", sid: "sess_3" });
        // Known only from a token exchange.
        yield* record({ key: "key-b", deviceId: "phone-b", sid: "sess_b" });

        const result = yield* removals.remove({ userId: USER, deviceId: "phone-a" });
        expect([...result.clerkSessionIds].sort()).toEqual(["sess_1", "sess_2", "sess_3"]);
        expect([...result.proofKeyThumbprints].sort()).toEqual(["key-a1", "key-a2"]);
        expect(
          yield* removals.findBlocking({ userId: USER, clerkSessionId: "sess_3" }),
        ).not.toBeNull();

        expect(yield* removals.remove({ userId: USER, deviceId: "phone-b" })).toEqual({
          removed: true,
          clerkSessionIds: ["sess_b"],
          proofKeyThumbprints: ["key-b"],
        });
      }).pipe(Effect.provide(layer())),
    );

    it.effect("with onlyPhones, removes a phone's key but leaves a browser's alone", () =>
      Effect.gen(function* () {
        const removals = yield* PhoneRemovals.PhoneRemovals;
        yield* record({ key: "key-web", clientId: "studio-web", sid: "sess_web" });
        yield* record({ key: "key-phone", deviceId: "phone-a", sid: "sess_phone" });
        yield* register("phone-b", { key: "key-registered" });

        const none = { removed: false, clerkSessionIds: [], proofKeyThumbprints: [] };
        expect(
          yield* removals.remove({ userId: USER, proofKeyThumbprint: "key-web", onlyPhones: true }),
        ).toEqual(none);
        expect(
          yield* removals.remove({
            userId: USER,
            proofKeyThumbprint: "key-unknown",
            onlyPhones: true,
          }),
        ).toEqual(none);
        const db = yield* RelayDb.RelayDb;
        expect(yield* db.select().from(relayMobileDeviceRemovals)).toEqual([]);

        expect(
          yield* removals.remove({
            userId: USER,
            proofKeyThumbprint: "key-phone",
            onlyPhones: true,
          }),
        ).toEqual({
          removed: true,
          clerkSessionIds: ["sess_phone"],
          proofKeyThumbprints: ["key-phone"],
        });
        expect(yield* removals.findBlocking({ userId: USER, deviceId: "phone-a" })).toMatchObject({
          proofKeyThumbprint: "key-phone",
        });
        // A registered phone's key counts too, and a repeat stays removed.
        expect(
          yield* removals.remove({
            userId: USER,
            proofKeyThumbprint: "key-registered",
            onlyPhones: true,
          }),
        ).toMatchObject({ removed: true, proofKeyThumbprints: ["key-registered"] });
        expect(
          yield* removals.remove({
            userId: USER,
            proofKeyThumbprint: "key-phone",
            onlyPhones: true,
          }),
        ).toMatchObject({ removed: true, proofKeyThumbprints: ["key-phone"] });
      }).pipe(Effect.provide(layer())),
    );

    it.effect("backfills only a removal's missing fields", () =>
      Effect.gen(function* () {
        const removals = yield* PhoneRemovals.PhoneRemovals;
        yield* register("phone-a");
        yield* removals.remove({ userId: USER, deviceId: "phone-a" });
        const removal = yield* removals.findBlocking({ userId: USER, deviceId: "phone-a" });
        expect(removal).toMatchObject({ proofKeyThumbprint: null, clerkSessionId: null });

        yield* removals.backfill({
          userId: USER,
          removalId: removal!.id,
          deviceId: "phone-other",
          proofKeyThumbprint: "key-a",
          clerkSessionId: "sess_a",
        });
        yield* removals.backfill({
          userId: USER,
          removalId: removal!.id,
          proofKeyThumbprint: "key-later",
        });
        expect(yield* removals.findBlocking({ userId: USER, deviceId: "phone-a" })).toMatchObject({
          deviceId: "phone-a",
          proofKeyThumbprint: "key-a",
          clerkSessionId: "sess_a",
        });
      }).pipe(Effect.provide(layer())),
    );

    it.effect("answers whether any account removed a key", () =>
      Effect.gen(function* () {
        const removals = yield* PhoneRemovals.PhoneRemovals;
        yield* register("phone-a", { userId: "user-2", key: "key-a" });
        expect(yield* removals.isKeyRemoved({ proofKeyThumbprint: "key-a" })).toBe(false);
        yield* removals.remove({ userId: "user-2", deviceId: "phone-a" });
        expect(yield* removals.isKeyRemoved({ proofKeyThumbprint: "key-a" })).toBe(true);
        expect(yield* removals.isKeyRemoved({ proofKeyThumbprint: "key-b" })).toBe(false);
      }).pipe(Effect.provide(layer())),
    );
  });
});
