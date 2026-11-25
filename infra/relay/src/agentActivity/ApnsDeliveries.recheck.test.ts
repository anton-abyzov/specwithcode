import type { RelayAgentActivityAggregateState } from "@specweave-studio/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import { makeApnsDeliveryJobPayload, signApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";

const signingKey = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make(signingKey.privateKey),
    bundleId: "com.specweave.studio.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-signing-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "studio-code-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const target: LiveActivities.TargetRow = {
  user_id: "user-1",
  device_id: "phone-1",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  bundle_id: null,
  aps_environment: null,
  push_token: "apns-device-token",
  push_to_start_token: "start-token",
  preferences_json: JSON.stringify({
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  }),
  activity_push_token: "activity-token",
  remote_start_queued_at: null,
  remote_started_at: "1970-01-01T00:00:00.000Z",
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};

const completedAt = "1970-01-01T00:00:01.000Z";

const completed: RelayAgentActivityAggregateState = {
  title: "SpecWithCode",
  subtitle: "Agent work in progress",
  activeCount: 0,
  updatedAt: completedAt,
  activities: [
    {
      environmentId: "env" as never,
      threadId: "thread" as never,
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "gpt-5.4",
      phase: "completed",
      status: "Done",
      updatedAt: completedAt,
      deepLink: "/",
    },
  ],
};

/** Every activity-row read fails, as when the database is unreachable. */
const failingRows = AgentActivityRows.AgentActivityRows.of({
  upsert: () => Effect.void,
  remove: () => Effect.void,
  pruneTerminal: () => Effect.void,
  listForUser: ({ userId }) =>
    Effect.fail(
      new AgentActivityRows.AgentActivityRowListPersistenceError({ userId, cause: "down" }),
    ),
  getForUserThread: ({ userId }) =>
    Effect.fail(
      new AgentActivityRows.AgentActivityRowListPersistenceError({ userId, cause: "down" }),
    ),
});

/** The user's rows: live work only on another machine of theirs. */
const rowsOnOtherMachine = AgentActivityRows.AgentActivityRows.of({
  ...failingRows,
  listForUser: () =>
    Effect.succeed([
      {
        environmentId: "env-kept" as never,
        threadId: "thread-kept" as never,
        projectTitle: "Kept",
        threadTitle: "Kept thread",
        modelTitle: "gpt-5.4",
        phase: "running",
        headline: "Running",
        updatedAt: "9999-01-01T00:00:00.000Z",
        deepLink: "/",
      },
    ]),
});

/**
 * The machine kept its environment id but was relinked under a new key; its
 * rows under the old key are no longer visible. The new key's row is.
 */
const rowsUnderReplacementKey = AgentActivityRows.AgentActivityRows.of({
  ...failingRows,
  listForUser: () =>
    Effect.succeed([
      {
        environmentId: "env" as never,
        threadId: "thread-new" as never,
        projectTitle: "Project",
        threadTitle: "Thread under the new key",
        modelTitle: "gpt-5.4",
        phase: "running",
        headline: "Running",
        updatedAt: "9999-01-01T00:00:00.000Z",
        deepLink: "/",
      },
    ]),
});

const layerFor = (
  calls: { apns: number; bodies?: Array<string> },
  rows: AgentActivityRows.AgentActivityRows["Service"] = failingRows,
  claim: "claimed" | "completed" = "claimed",
) =>
  ApnsDeliveries.layer.pipe(
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentActivityRows.AgentActivityRows, rows),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, { send: () => Effect.void }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          pruneExpired: Effect.succeed(0),
          record: () => Effect.void,
          claimSourceJob: () => Effect.succeed(claim),
          completeSourceJob: () => Effect.void,
        }),
        Layer.mock(LiveActivities.LiveActivities, {
          listTargets: () => Effect.succeed([target]),
          markDelivery: () => Effect.void,
          invalidateDeliveryToken: () => Effect.void,
          clearStartQueued: () => Effect.void,
        }),
        RelayConfiguration.layer(config),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
            Effect.sync(() => {
              calls.apns += 1;
              if (request.body._tag === "Uint8Array") {
                calls.bodies?.push(new TextDecoder().decode(request.body.body));
              }
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
          ),
        ),
      ),
    ),
  );

const sign = (payload: Parameters<typeof makeApnsDeliveryJobPayload>[0]) =>
  signApnsDeliveryJob({
    secret: config.apnsDeliveryJobSigningSecret,
    payload: makeApnsDeliveryJobPayload(payload),
  });

describe("ApnsDeliveries when the delivery-time recheck fails", () => {
  it.effect("skips a queued alert instead of delivering it", () => {
    const calls = { apns: 0 };
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(
        sign({
          kind: "push_notification",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "apns-device-token",
          aggregate: null,
          notification: {
            title: "Thread",
            body: "Done: Project",
            environmentId: "env",
            threadId: "thread",
            deepLink: "/",
            phase: "completed",
            updatedAt: completedAt,
          },
          createdAt: completedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-push-recheck-failed",
        }),
      );
      expect(result).toMatchObject({ apnsReason: "Stale APNs delivery job skipped." });
      expect(calls.apns).toBe(0);
    }).pipe(Effect.provide(layerFor(calls)));
  });

  it.effect("skips a queued Live Activity update instead of delivering it", () => {
    const calls = { apns: 0 };
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(
        sign({
          kind: "live_activity_update",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "activity-token",
          aggregate: completed,
          alert: { title: "Thread", body: "Done: Project" },
          createdAt: completedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-update-recheck-failed",
        }),
      );
      expect(result).toMatchObject({ apnsReason: "Stale APNs delivery job skipped." });
      expect(calls.apns).toBe(0);
    }).pipe(Effect.provide(layerFor(calls)));
  });

  it.effect("skips a queued Live Activity start instead of delivering it", () => {
    const calls = { apns: 0 };
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(
        sign({
          kind: "live_activity_start",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "start-token",
          aggregate: {
            ...completed,
            activeCount: 1,
            activities: completed.activities.map((activity) => ({
              ...activity,
              phase: "running",
              status: "Working",
            })),
          },
          createdAt: completedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-start-recheck-failed",
        }),
      );
      // A start the relay cannot confirm could birth an activity nothing ends.
      expect(result).toMatchObject({ kind: "live_activity_start", apnsStatus: null });
      expect(calls.apns).toBe(0);
    }).pipe(Effect.provide(layerFor(calls)));
  });

  // The machine moved to another account after the start was queued. The user
  // still has live work elsewhere, but the start's content is the moved
  // machine's: it must not reach this user's phone.
  it.effect("skips a queued start whose machine the user no longer has linked", () => {
    const calls = { apns: 0 };
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(
        sign({
          kind: "live_activity_start",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "start-token",
          aggregate: {
            ...completed,
            activeCount: 1,
            activities: completed.activities.map((activity) => ({
              ...activity,
              environmentId: "env-moved" as never,
              phase: "running",
              status: "Working",
            })),
          },
          createdAt: completedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-start-moved-machine",
        }),
      );
      expect(result).toMatchObject({ kind: "live_activity_start", apnsStatus: null });
      expect(calls.apns).toBe(0);
    }).pipe(Effect.provide(layerFor(calls, rowsOnOtherMachine)));
  });

  it.effect("starts with the current key's content, never the queued content of an old key", () => {
    const calls = { apns: 0, bodies: [] as Array<string> };
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.processSignedJob(
        sign({
          kind: "live_activity_start",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "start-token",
          aggregate: {
            ...completed,
            activeCount: 1,
            activities: completed.activities.map((activity) => ({
              ...activity,
              threadTitle: "Thread under the old key",
              phase: "running",
              status: "Working",
            })),
          },
          createdAt: completedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-start-replaced-key",
        }),
      );
      expect(calls.bodies.join("\n")).not.toContain("Thread under the old key");
      expect(calls.bodies.join("\n")).toContain("Thread under the new key");
    }).pipe(Effect.provide(layerFor(calls, rowsUnderReplacementKey)));
  });

  // A duplicate delivery of a start that already went out reads nothing: the
  // job claim comes before the start's row read.
  it.effect("reads no rows for a start whose job was already delivered", () => {
    const calls = { apns: 0 };
    let reads = 0;
    const countingRows = AgentActivityRows.AgentActivityRows.of({
      ...rowsUnderReplacementKey,
      listForUser: (input) =>
        Effect.suspend(() => {
          reads += 1;
          return rowsUnderReplacementKey.listForUser(input);
        }),
    });
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.processSignedJob(
        sign({
          kind: "live_activity_start",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "start-token",
          aggregate: completed,
          createdAt: completedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-start-duplicate",
        }),
      );
      expect(reads).toBe(0);
      expect(calls.apns).toBe(0);
    }).pipe(Effect.provide(layerFor(calls, countingRows, "completed")));
  });
});
