import type { RelayAgentActivityAggregateState } from "@specweave-studio/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";

import type { SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("not-a-private-key"),
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

const waitingForInput: RelayAgentActivityAggregateState = {
  title: "SpecWithCode",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
  activities: [
    {
      environmentId: "env" as never,
      threadId: "thread" as never,
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "gpt-5.4",
      phase: "waiting_for_input",
      status: "Input",
      updatedAt: "1970-01-01T00:00:00.000Z",
      deepLink: "/",
    },
  ],
};

/** A phone that declined notifications registers for "Your phones" with no tokens. */
const tokenless: LiveActivities.TargetRow = {
  user_id: "user-1",
  device_id: "phone-1",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  bundle_id: null,
  aps_environment: null,
  push_token: null,
  push_to_start_token: null,
  preferences_json: JSON.stringify({
    liveActivitiesEnabled: true,
    notificationsEnabled: false,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  }),
  activity_push_token: null,
  remote_start_queued_at: null,
  remote_started_at: null,
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};

const layerFor = (queuedJobs: Array<SignedApnsDeliveryJob>) =>
  ApnsDeliveries.layer.pipe(
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AgentActivityRows.AgentActivityRows, {}),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) => Effect.sync(() => void queuedJobs.push(body)),
        }),
        Layer.mock(DeliveryAttempts.DeliveryAttempts, {}),
        Layer.mock(LiveActivities.LiveActivities, {
          listTargets: () => Effect.succeed([tokenless]),
        }),
        RelayConfiguration.layer(config),
        FetchHttpClient.layer,
      ),
    ),
  );

describe("ApnsDeliveries for a phone without push tokens", () => {
  it.effect("queues nothing, whatever the agent state", () => {
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      for (const notificationsEnabled of [false, true]) {
        const target = {
          ...tokenless,
          preferences_json: tokenless.preferences_json.replace(
            '"notificationsEnabled":false',
            `"notificationsEnabled":${notificationsEnabled}`,
          ),
        };
        for (const aggregate of [waitingForInput, null]) {
          expect(yield* deliveries.sendForTarget({ target, aggregate, nowMs: 5_000 })).toBeNull();
          expect(
            yield* deliveries.sendForTarget({ target, aggregate, nowMs: 5_000, replay: true }),
          ).toBeNull();
          expect(yield* deliveries.sendPushNotificationForTarget({ target, aggregate })).toBeNull();
        }
      }
      expect(queuedJobs).toEqual([]);
    }).pipe(Effect.provide(layerFor(queuedJobs)));
  });
});
