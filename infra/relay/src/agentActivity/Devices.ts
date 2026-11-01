import type {
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
} from "@specweave-studio/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";

export class DeviceRegistrationPersistenceError extends Schema.TaggedError<DeviceRegistrationPersistenceError>()(
  "DeviceRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals([
      "claim-push-token",
      "claim-push-to-start-token",
      "upsert-device",
      "drop-stale-registrations",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist mobile device registration for ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceUnregistrationPersistenceError extends Schema.TaggedError<DeviceUnregistrationPersistenceError>()(
  "DeviceUnregistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["delete-live-activity", "delete-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister mobile device ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceListPersistenceError extends Schema.TaggedError<DeviceListPersistenceError>()(
  "DeviceListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list mobile devices for ${this.userId}.`;
  }
}

export class DeviceTouchPersistenceError extends Schema.TaggedError<DeviceTouchPersistenceError>()(
  "DeviceTouchPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to record activity for mobile device ${this.userId}/${this.deviceId}.`;
  }
}

export class Devices extends Context.Service<
  Devices,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayDeviceRegistrationRequest;
      /** The DPoP key and Clerk session of the registering request. */
      readonly proofKeyThumbprint?: string | undefined;
      readonly clerkSessionId?: string | undefined;
    }) => Effect.Effect<void, DeviceRegistrationPersistenceError>;
    /**
     * Records that a registered phone is in use with this DPoP key (and Clerk
     * session, when known). Does nothing for a device that is not registered.
     */
    readonly touch: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly proofKeyThumbprint: string;
      readonly clerkSessionId?: string | undefined;
    }) => Effect.Effect<void, DeviceTouchPersistenceError>;
    readonly unregister: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, DeviceUnregistrationPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, DeviceListPersistenceError>;
  }
>()("studio-relay/agentActivity/Devices") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  /**
   * A reinstalled app keeps its Keychain DPoP key under a new device id:
   * once `deviceId` is registered with the key, the user's other
   * registrations holding it are the same phone's stale ones. Deletes them
   * and their Live Activities. Does nothing when `deviceId` is not registered.
   */
  const dropStaleRegistrations = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly proofKeyThumbprint: string;
  }) {
    const rows = yield* db
      .select({ deviceId: relayMobileDevices.deviceId })
      .from(relayMobileDevices)
      .where(
        and(
          eq(relayMobileDevices.userId, input.userId),
          eq(relayMobileDevices.proofKeyThumbprint, input.proofKeyThumbprint),
        ),
      );
    if (!rows.some((row) => row.deviceId === input.deviceId)) return;
    const stale = rows.map((row) => row.deviceId).filter((id) => id !== input.deviceId);
    if (stale.length === 0) return;
    yield* Effect.annotateCurrentSpan({ "relay.mobile.stale_registrations": stale.length });
    yield* RelayDb.batch(db, [
      db
        .delete(relayLiveActivities)
        .where(
          and(
            eq(relayLiveActivities.userId, input.userId),
            inArray(relayLiveActivities.deviceId, stale),
          ),
        ),
      db
        .delete(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            eq(relayMobileDevices.proofKeyThumbprint, input.proofKeyThumbprint),
            ne(relayMobileDevices.deviceId, input.deviceId),
          ),
        ),
    ]);
  });

  return Devices.of({
    register: Effect.fn("relay.devices.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const registration = input.registration;

      // The drizzle handle is alchemy's lazy proxy chain: it only becomes a
      // real Effect when consumed via `yield*`. Handing it to Effect.all sends
      // the raw Proxy into the fiber runtime, which spins the isolate at 100%
      // CPU (registrations then hang until the client aborts) — keep every db
      // chain directly yielded.
      if (registration.pushToken) {
        yield* db
          .update(relayMobileDevices)
          .set({ pushToken: null, updatedAt })
          .where(eq(relayMobileDevices.pushToken, registration.pushToken))
          .pipe(
            Effect.mapError(
              (cause) =>
                new DeviceRegistrationPersistenceError({
                  userId: input.userId,
                  deviceId: registration.deviceId,
                  stage: "claim-push-token",
                  cause,
                }),
            ),
          );
      }
      if (registration.pushToStartToken) {
        yield* db
          .update(relayMobileDevices)
          .set({ pushToStartToken: null, updatedAt })
          .where(eq(relayMobileDevices.pushToStartToken, registration.pushToStartToken))
          .pipe(
            Effect.mapError(
              (cause) =>
                new DeviceRegistrationPersistenceError({
                  userId: input.userId,
                  deviceId: registration.deviceId,
                  stage: "claim-push-to-start-token",
                  cause,
                }),
            ),
          );
      }

      yield* db
        .insert(relayMobileDevices)
        .values({
          userId: input.userId,
          deviceId: registration.deviceId,
          label: registration.label,
          platform: registration.platform,
          iosMajorVersion: registration.iosMajorVersion ?? null,
          androidApiLevel: registration.androidApiLevel ?? null,
          appVersion: registration.appVersion ?? null,
          bundleId: registration.bundleId ?? null,
          apsEnvironment: registration.apsEnvironment ?? null,
          pushToken: registration.pushToken ?? null,
          pushToStartToken: registration.pushToStartToken ?? null,
          proofKeyThumbprint: input.proofKeyThumbprint ?? null,
          clerkSessionId: input.clerkSessionId ?? null,
          model: registration.model ?? null,
          lastSeenAt: updatedAt,
          preferencesJson: registration.preferences,
          createdAt: updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [relayMobileDevices.userId, relayMobileDevices.deviceId],
          set: {
            platform: registration.platform,
            label: registration.label,
            iosMajorVersion: registration.iosMajorVersion ?? null,
            androidApiLevel: registration.androidApiLevel ?? null,
            appVersion: registration.appVersion ?? null,
            // Preserve routing from newer app builds when an older build
            // re-registers without these fields.
            bundleId: sql`coalesce(excluded.bundle_id, ${relayMobileDevices.bundleId})`,
            apsEnvironment: sql`coalesce(
                excluded.aps_environment,
                ${relayMobileDevices.apsEnvironment}
              )`,
            pushToken: sql`coalesce(excluded.push_token, ${relayMobileDevices.pushToken})`,
            pushToStartToken: sql`coalesce(
                excluded.push_to_start_token,
                ${relayMobileDevices.pushToStartToken}
              )`,
            proofKeyThumbprint: sql`coalesce(
                excluded.proof_key_thumbprint,
                ${relayMobileDevices.proofKeyThumbprint}
              )`,
            clerkSessionId: sql`coalesce(
                excluded.clerk_session_id,
                ${relayMobileDevices.clerkSessionId}
              )`,
            model: sql`coalesce(excluded.model, ${relayMobileDevices.model})`,
            lastSeenAt: updatedAt,
            // A registration without a push token (notifications not set up
            // on this install yet) keeps the preferences of a row that has one.
            preferencesJson: sql`case
                when excluded.push_token is null
                  and ${relayMobileDevices.pushToken} is not null
                then ${relayMobileDevices.preferencesJson}
                else excluded.preferences_json
              end`,
            updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceRegistrationPersistenceError({
                userId: input.userId,
                deviceId: registration.deviceId,
                stage: "upsert-device",
                cause,
              }),
          ),
        );
      if (input.proofKeyThumbprint) {
        yield* dropStaleRegistrations({
          userId: input.userId,
          deviceId: registration.deviceId,
          proofKeyThumbprint: input.proofKeyThumbprint,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new DeviceRegistrationPersistenceError({
                userId: input.userId,
                deviceId: registration.deviceId,
                stage: "drop-stale-registrations",
                cause,
              }),
          ),
        );
      }
    }),
    touch: Effect.fn("relay.devices.touch")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.mobile.device_id": input.deviceId });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayMobileDevices)
        .set({
          proofKeyThumbprint: input.proofKeyThumbprint,
          ...(input.clerkSessionId ? { clerkSessionId: input.clerkSessionId } : {}),
          lastSeenAt: now,
        })
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            eq(relayMobileDevices.deviceId, input.deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceTouchPersistenceError({
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
      yield* dropStaleRegistrations(input).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceTouchPersistenceError({
              userId: input.userId,
              deviceId: input.deviceId,
              cause,
            }),
        ),
      );
    }),
    unregister: Effect.fn("relay.devices.unregister")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      // Same proxy-chain constraint as register above: db chains must be
      // consumed via `yield*`, never passed to Effect.all.
      yield* db
        .delete(relayLiveActivities)
        .where(
          and(
            eq(relayLiveActivities.userId, input.userId),
            eq(relayLiveActivities.deviceId, input.deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceUnregistrationPersistenceError({
                userId: input.userId,
                deviceId: input.deviceId,
                stage: "delete-live-activity",
                cause,
              }),
          ),
        );
      yield* db
        .delete(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            eq(relayMobileDevices.deviceId, input.deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceUnregistrationPersistenceError({
                userId: input.userId,
                deviceId: input.deviceId,
                stage: "delete-device",
                cause,
              }),
          ),
        );
    }),
    listForUser: Effect.fn("relay.devices.listForUser")(function* (input) {
      const rows = yield* db
        .select({
          deviceId: relayMobileDevices.deviceId,
          label: relayMobileDevices.label,
          platform: relayMobileDevices.platform,
          iosMajorVersion: relayMobileDevices.iosMajorVersion,
          androidApiLevel: relayMobileDevices.androidApiLevel,
          appVersion: relayMobileDevices.appVersion,
          preferences: relayMobileDevices.preferencesJson,
          updatedAt: relayMobileDevices.updatedAt,
        })
        .from(relayMobileDevices)
        .where(eq(relayMobileDevices.userId, input.userId))
        .pipe(
          Effect.mapError(
            (cause) => new DeviceListPersistenceError({ userId: input.userId, cause }),
          ),
        );
      return rows.map((row) => ({
        deviceId: row.deviceId,
        label: row.label,
        platform: row.platform,
        iosMajorVersion: row.iosMajorVersion,
        androidApiLevel: row.androidApiLevel,
        appVersion: row.appVersion,
        notifications: {
          enabled: row.preferences.notificationsEnabled,
          notifyOnApproval: row.preferences.notifyOnApproval,
          notifyOnInput: row.preferences.notifyOnInput,
          notifyOnCompletion: row.preferences.notifyOnCompletion,
          notifyOnFailure: row.preferences.notifyOnFailure,
        },
        liveActivities: {
          enabled: row.preferences.liveActivitiesEnabled,
        },
        updatedAt: row.updatedAt,
      }));
    }),
  });
});

export const layer = Layer.effect(Devices, make);
