// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test signs requests the way Svix does.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as ClerkWebhook from "./ClerkWebhook.ts";

const SIGNING_KEY = NodeCrypto.randomBytes(24);
const SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;

const config = (secret: string | undefined) =>
  RelayConfiguration.RelayConfiguration.of({
    relayIssuer: "https://relay.example.test",
    apns: null,
    apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "studio-code-relay",
    ...(secret === undefined ? {} : { clerkWebhookSigningSecret: Redacted.make(secret) }),
    cloudMintPrivateKey: Redacted.make("private-key"),
    cloudMintPublicKey: "public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  });

/** The relay with no machines: what deletion touched is all that is recorded. */
const makeRelay = (secret: string | undefined) => {
  const deleted: Array<string> = [];
  const consumed = new Set<string>();
  const layer = Layer.mergeAll(
    Layer.mock(DpopProofs.DpopProofReplay, {
      consume: ({ thumbprint, jti }) =>
        Effect.sync(() => {
          const key = `${thumbprint}:${jti}`;
          if (consumed.has(key)) return false;
          consumed.add(key);
          return true;
        }),
    }),
    Layer.succeed(
      AccountDeletion.AccountRecords,
      AccountDeletion.AccountRecords.of({
        markDeleting: () => Effect.void,
        listEnvironmentIds: () => Effect.succeed([]),
        listAllocatedEnvironmentIds: () => Effect.succeed([]),
        deleteUserRows: ({ userId }) => Effect.sync(() => (deleted.push(userId), true)),
      }),
    ),
    Layer.succeed(
      AccountDeletion.ClerkUsers,
      AccountDeletion.ClerkUsers.of({ deleteUser: () => Effect.void }),
    ),
    Layer.mock(HookInbox.HookInbox, {}),
    Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
    Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
    RelayConfiguration.layer(config(secret)),
    NodeCryptoLayer.layer,
  );
  return { deleted, layer };
};

const sign = (id: string, timestamp: number, body: string, key: Buffer = SIGNING_KEY) =>
  `v1,${NodeCrypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

// The route runs on its own runtime with the real clock, so the test signs with it too.
// @effect-diagnostics-next-line globalDate:off
const now = () => Math.floor(Date.now() / 1_000);

const deliver = (
  relay: ReturnType<typeof makeRelay>,
  body: string,
  headers: (id: string, timestamp: number) => Record<string, string> = (id, timestamp) => ({
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": sign(id, timestamp, body),
  }),
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        ClerkWebhook.layerClerkWebhookRoute.pipe(
          Layer.provide(relay.layer),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (app) =>
      Effect.promise(() =>
        app.handler(
          new Request(`https://relay.example.test${ClerkWebhook.CLERK_WEBHOOK_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers("msg_1", now()) },
            body,
          }),
        ),
      ),
    (app) => Effect.promise(() => app.dispose()),
  );

const userDeleted = JSON.stringify({
  type: "user.deleted",
  data: { id: "user_2gone", deleted: true },
});

describe("Clerk user.deleted webhook", () => {
  it.effect("deletes the user's relay records for a signed user.deleted", () => {
    const relay = makeRelay(SECRET);
    return Effect.gen(function* () {
      const response = yield* deliver(relay, userDeleted);
      expect(response.status).toBe(204);
      expect(relay.deleted).toEqual(["user_2gone"]);
    });
  });

  it.effect("accepts the signature among several, as during a secret rotation", () => {
    const relay = makeRelay(SECRET);
    return Effect.gen(function* () {
      const response = yield* deliver(relay, userDeleted, (id, timestamp) => ({
        "svix-id": id,
        "svix-timestamp": String(timestamp),
        "svix-signature": `${sign(id, timestamp, userDeleted, NodeCrypto.randomBytes(24))} ${sign(id, timestamp, userDeleted)}`,
      }));
      expect(response.status).toBe(204);
      expect(relay.deleted).toEqual(["user_2gone"]);
    });
  });

  it.effect("refuses every request while the signing secret is unset", () =>
    Effect.gen(function* () {
      for (const secret of [undefined, "  "]) {
        const relay = makeRelay(secret);
        const response = yield* deliver(relay, userDeleted);
        expect(response.status).toBe(503);
        expect(relay.deleted).toEqual([]);
      }
    }),
  );

  it.effect("refuses a bad signature, a missing one or an altered body", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<(id: string, timestamp: number) => Record<string, string>> = [
        (id, timestamp) => ({
          "svix-id": id,
          "svix-timestamp": String(timestamp),
          "svix-signature": sign(id, timestamp, userDeleted, NodeCrypto.randomBytes(24)),
        }),
        (id, timestamp) => ({ "svix-id": id, "svix-timestamp": String(timestamp) }),
        (id, timestamp) => ({
          "svix-id": id,
          "svix-timestamp": String(timestamp),
          "svix-signature": sign(id, timestamp, userDeleted.replace("user_2gone", "user_other")),
        }),
        (id, timestamp) => ({
          "svix-id": "msg_other",
          "svix-timestamp": String(timestamp),
          "svix-signature": sign(id, timestamp, userDeleted),
        }),
      ];
      for (const headers of cases) {
        const relay = makeRelay(SECRET);
        const response = yield* deliver(relay, userDeleted, headers);
        expect(response.status).toBe(401);
        expect(relay.deleted).toEqual([]);
      }
    }),
  );

  it.effect("refuses a timestamp more than five minutes away", () =>
    Effect.gen(function* () {
      for (const offset of [-6 * 60, 6 * 60]) {
        const relay = makeRelay(SECRET);
        const response = yield* deliver(relay, userDeleted, (id, timestamp) => ({
          "svix-id": id,
          "svix-timestamp": String(timestamp + offset),
          "svix-signature": sign(id, timestamp + offset, userDeleted),
        }));
        expect(response.status).toBe(401);
        expect(relay.deleted).toEqual([]);
      }
    }),
  );

  it.effect("answers other event types without deleting anything", () => {
    const relay = makeRelay(SECRET);
    const body = JSON.stringify({ type: "user.updated", data: { id: "user_2gone" } });
    return Effect.gen(function* () {
      const response = yield* deliver(relay, body);
      expect(response.status).toBe(204);
      expect(relay.deleted).toEqual([]);
    });
  });

  it.effect("answers a replayed delivery without acting on it again", () => {
    const relay = makeRelay(SECRET);
    const timestamp = now();
    const captured = {
      "svix-id": "msg_1",
      "svix-timestamp": String(timestamp),
      "svix-signature": sign("msg_1", timestamp, userDeleted),
    };
    return Effect.gen(function* () {
      expect((yield* deliver(relay, userDeleted, () => captured)).status).toBe(204);
      expect((yield* deliver(relay, userDeleted, () => captured)).status).toBe(204);
      expect(relay.deleted).toEqual(["user_2gone"]);
    });
  });

  it.effect("acts on Clerk's retry, which signs the same message with a new timestamp", () => {
    const relay = makeRelay(SECRET);
    const timestamp = now();
    const attempt = (at: number) => () => ({
      "svix-id": "msg_1",
      "svix-timestamp": String(at),
      "svix-signature": sign("msg_1", at, userDeleted),
    });
    return Effect.gen(function* () {
      yield* deliver(relay, userDeleted, attempt(timestamp - 1));
      expect((yield* deliver(relay, userDeleted, attempt(timestamp))).status).toBe(204);
      expect(relay.deleted).toEqual(["user_2gone", "user_2gone"]);
    });
  });
});
