// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@specweave-studio/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@specweave-studio/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfiguration from "../Config.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinker from "./EnvironmentLinker.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import { recordEnvironmentHardwareIdentity } from "./EnvironmentUnlink.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

type KeyPair = { readonly publicKey: string; readonly privateKey: string };

const newKeyPair = (): KeyPair =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

const relayKeyPair = newKeyPair();
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.specweave.studio.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "studio-code-relay",
  cloudMintPrivateKey: Redacted.make(relayKeyPair.privateKey),
  cloudMintPublicKey: relayKeyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const isProofInvalid = Schema.is(EnvironmentLinker.EnvironmentLinkProofInvalid);

/** The machine-side hash: 64 hex characters, never the raw hardware id. */
const machineHash = (name: string) => NodeCrypto.createHash("sha256").update(name).digest("hex");

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

let sequence = 0;

/** A fresh, valid link request, as the machine and the signed-in client make one. */
const makeRequest = (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly keyPair: KeyPair;
  readonly label?: string;
  readonly hardwareIdentity?: string;
}) =>
  Effect.gen(function* () {
    sequence += 1;
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const relayTokens = yield* RelayTokens.RelayTokens;
    const request = {
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
    };
    const challenge = yield* relayTokens.issueLinkChallenge({
      userId: input.userId,
      request,
      jti: `challenge-${sequence}`,
      issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
    });
    const environmentId = input.environmentId as RelayEnvironmentLinkProofPayload["environmentId"];
    const payload = {
      iss: `studio-env:${environmentId}`,
      aud: "https://relay.example.test",
      sub: environmentId,
      jti: `proof-${sequence}`,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      challenge,
      environmentId,
      descriptor: {
        environmentId,
        label: input.label ?? "Anton M5MAX PROLED",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      environmentPublicKey: input.keyPair.publicKey.trim(),
      endpoint: {
        httpBaseUrl: "https://env.example.test/",
        wsBaseUrl: "wss://env.example.test/",
        providerKind: "manual",
      },
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
      scopes: ["agent_activity_notifications", "managed_tunnels"],
      ...(input.hardwareIdentity === undefined ? {} : { hardwareIdentity: input.hardwareIdentity }),
    } satisfies RelayEnvironmentLinkProofPayload;
    return {
      proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, input.keyPair.privateKey),
      ...request,
    } satisfies RelayEnvironmentLinkRequest;
  });

const link = (input: Parameters<typeof makeRequest>[0]) =>
  Effect.gen(function* () {
    const linker = yield* EnvironmentLinker.EnvironmentLinker;
    const request = yield* makeRequest(input);
    return yield* linker.link({ userId: input.userId, request });
  });

const activeIds = (userId: string) =>
  Effect.gen(function* () {
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const rows = yield* links.listForUser({ userId });
    return rows.map((row) => row.environmentId as string).sort();
  });

const layer = () =>
  EnvironmentLinker.layer.pipe(
    Layer.provideMerge(RelayTokens.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentLinks.layer,
        EnvironmentCredentials.layer,
        DpopProofs.layer,
        RelayConfiguration.layer(config),
        Layer.succeed(ConnectAccounts.ConnectAccounts, {
          ensureAccount: (account) =>
            Effect.succeed({
              userId: account.userId,
              promoId: null,
              founderNumber: null,
              createdAt: "2026-11-13T00:00:00.000Z",
            }),
          foundersSummary: () => Effect.die("unused"),
        }),
        Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
          reconcileOrigin: () => Effect.succeed("ready"),
          prepareDeprovision: () => Effect.succeed(null),
          deprovision: () => Effect.succeed(true),
          release: () => Effect.succeed(true),
          provision: () => Effect.die("managed tunnels are off in these tests"),
        }),
      ).pipe(Layer.provideMerge(layerSqliteRelayDb())),
    ),
    Layer.provideMerge(NodeCryptoLayer.layer),
  );

const ALICE = "user_alice";
const M5 = machineHash("m5-platform-uuid\n/Users/anton/.specwithcode");

describe("machine hardware identity on Connect links", () => {
  it.effect("a reinstall with wiped local state replaces the machine's old record", () =>
    Effect.gen(function* () {
      const before = newKeyPair();
      const first = yield* link({
        userId: ALICE,
        environmentId: "env-before-reset",
        keyPair: before,
        hardwareIdentity: M5,
      });
      expect(first.replacedEnvironmentIds).toEqual([]);

      // Wiped home: a new environment id and a new key, same machine.
      const second = yield* link({
        userId: ALICE,
        environmentId: "env-after-reset",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });

      expect(second.replacedEnvironmentIds).toEqual(["env-before-reset"]);
      expect(yield* activeIds(ALICE)).toEqual(["env-after-reset"]);
      // The old record's credential stops working with it.
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      expect(Option.isNone(yield* credentials.authenticate(first.environmentCredential))).toBe(
        true,
      );
      expect(Option.isSome(yield* credentials.authenticate(second.environmentCredential))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect("signing in again on the same machine keeps one record", () =>
    Effect.gen(function* () {
      const keyPair = newKeyPair();
      yield* link({ userId: ALICE, environmentId: "env-1", keyPair, hardwareIdentity: M5 });
      const again = yield* link({
        userId: ALICE,
        environmentId: "env-1",
        keyPair,
        hardwareIdentity: M5,
      });

      expect(again.replacedEnvironmentIds).toEqual([]);
      expect(yield* activeIds(ALICE)).toEqual(["env-1"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a double-submitted link is refused the second time and adds nothing", () =>
    Effect.gen(function* () {
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const request = yield* makeRequest({
        userId: ALICE,
        environmentId: "env-1",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });
      const [first, second] = yield* Effect.all(
        [
          linker.link({ userId: ALICE, request }).pipe(Effect.result),
          linker.link({ userId: ALICE, request }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );

      const outcomes = [first, second];
      expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
      const failure = outcomes.find(Result.isFailure);
      expect(failure !== undefined && isProofInvalid(failure.failure)).toBe(true);
      expect(yield* activeIds(ALICE)).toEqual(["env-1"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a link made before identities were sent is backfilled and later replaced", () =>
    Effect.gen(function* () {
      const legacyKey = newKeyPair();
      yield* link({ userId: ALICE, environmentId: "env-legacy", keyPair: legacyKey });

      const recorded = yield* recordEnvironmentHardwareIdentity({
        environmentId: "env-legacy",
        environmentPublicKey: legacyKey.publicKey.trim(),
        hardwareIdentity: M5,
      });
      expect(recorded).toEqual({ recorded: true });
      // Recording twice changes nothing.
      expect(
        yield* recordEnvironmentHardwareIdentity({
          environmentId: "env-legacy",
          environmentPublicKey: legacyKey.publicKey.trim(),
          hardwareIdentity: machineHash("another machine"),
        }),
      ).toEqual({ recorded: false });

      const reinstalled = yield* link({
        userId: ALICE,
        environmentId: "env-new",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });
      expect(reinstalled.replacedEnvironmentIds).toEqual(["env-legacy"]);
      expect(yield* activeIds(ALICE)).toEqual(["env-new"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a backfill needs the link's own key", () =>
    Effect.gen(function* () {
      yield* link({ userId: ALICE, environmentId: "env-legacy", keyPair: newKeyPair() });
      expect(
        yield* recordEnvironmentHardwareIdentity({
          environmentId: "env-legacy",
          environmentPublicKey: newKeyPair().publicKey.trim(),
          hardwareIdentity: M5,
        }),
      ).toEqual({ recorded: false });
      const replacing = yield* link({
        userId: ALICE,
        environmentId: "env-new",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });
      expect(replacing.replacedEnvironmentIds).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a legacy record with no identity is never matched by its name", () =>
    Effect.gen(function* () {
      yield* link({ userId: ALICE, environmentId: "env-legacy", keyPair: newKeyPair() });
      const fresh = yield* link({
        userId: ALICE,
        environmentId: "env-new",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });

      expect(fresh.replacedEnvironmentIds).toEqual([]);
      expect(yield* activeIds(ALICE)).toEqual(["env-legacy", "env-new"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("two different machines with the same name stay separate", () =>
    Effect.gen(function* () {
      yield* link({
        userId: ALICE,
        environmentId: "env-desk",
        keyPair: newKeyPair(),
        label: "MacBook Pro",
        hardwareIdentity: machineHash("desk-uuid\n/Users/anton/.specwithcode"),
      });
      const other = yield* link({
        userId: ALICE,
        environmentId: "env-travel",
        keyPair: newKeyPair(),
        label: "MacBook Pro",
        hardwareIdentity: machineHash("travel-uuid\n/Users/anton/.specwithcode"),
      });

      expect(other.replacedEnvironmentIds).toEqual([]);
      expect(yield* activeIds(ALICE)).toEqual(["env-desk", "env-travel"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("another account linking the same machine leaves this account's record", () =>
    Effect.gen(function* () {
      yield* link({
        userId: ALICE,
        environmentId: "env-alice",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });
      const bob = yield* link({
        userId: "user_bob",
        environmentId: "env-bob",
        keyPair: newKeyPair(),
        hardwareIdentity: M5,
      });

      expect(bob.replacedEnvironmentIds).toEqual([]);
      expect(yield* activeIds(ALICE)).toEqual(["env-alice"]);
      expect(yield* activeIds("user_bob")).toEqual(["env-bob"]);
    }).pipe(Effect.provide(layer())),
  );
});
