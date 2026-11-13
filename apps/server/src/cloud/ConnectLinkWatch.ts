/**
 * Noticing that this machine was deregistered from another device. The relay
 * has no way to tell a machine, so a linked machine asks: one small request
 * with its own credential, at start and every {@link LINK_WATCH_INTERVAL}. Only
 * the relay's explicit word that the link is gone forgets the link here; an
 * unreachable relay, a failure on its side or a plain refusal changes nothing.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeRelayEnvironmentHttpClient } from "../relay/relayEnvironmentClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as CloudLink from "./CloudLink.ts";
import * as MachineHardwareIdentity from "./MachineHardwareIdentity.ts";
import { readRelayConnection } from "./config.ts";

const RELAY_REQUEST_TIMEOUT = "10 seconds";
/** How often a linked machine asks whether it is still linked. */
export const LINK_WATCH_INTERVAL = "2 minutes";

export type LinkWatchResult = "not_linked" | "linked" | "revoked" | "unknown";

/**
 * One look. `revoked` means the link was forgotten here just now; `unknown`
 * covers everything that proves nothing. Never fails.
 */
export const checkLinkOnce: Effect.Effect<
  LinkWatchResult,
  never,
  | CloudLink.CloudLink
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | HttpClient.HttpClient
> = Effect.gen(function* () {
  const cloudLink = yield* CloudLink.CloudLink;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const connection = yield* readRelayConnection;
  if (connection === null) return "not_linked" as const;
  const client = yield* makeRelayEnvironmentHttpClient(connection);
  const environmentId = yield* environment.getEnvironmentId;
  const answer = yield* client.server.listRemovedClientKeys({ params: { environmentId } }).pipe(
    Effect.as("linked" as const),
    Effect.catchTag("RelayAuthInvalidError", (error) =>
      Effect.succeed(
        error.environmentLink === "revoked" ? ("revoked" as const) : ("unknown" as const),
      ),
    ),
    Effect.timeout(RELAY_REQUEST_TIMEOUT),
  );
  if (answer !== "revoked") return answer;
  const forgotten = yield* cloudLink.unlinkRevokedElsewhere(connection.environmentCredential);
  return forgotten ? ("revoked" as const) : ("unknown" as const);
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logDebug("Could not ask SpecWithCode Connect whether this machine is still linked", {
      cause,
    }).pipe(Effect.as("unknown" as const)),
  ),
);

/**
 * Records this machine's hardware identity on its existing link, for links made
 * by a version that did not send one, so a later reinstall replaces the record
 * instead of adding a second. `true` once recorded or when there is nothing
 * to record; `false` to try again later. Never fails.
 */
export const recordHardwareIdentityOnce: Effect.Effect<
  boolean,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | MachineHardwareIdentity.MachineHardwareIdentity
  | HttpClient.HttpClient
> = Effect.gen(function* () {
  const identity = yield* MachineHardwareIdentity.MachineHardwareIdentity;
  const hardwareIdentity = yield* identity.get;
  if (hardwareIdentity === null) return true;
  const connection = yield* readRelayConnection;
  if (connection === null) return false;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const client = yield* makeRelayEnvironmentHttpClient(connection);
  return yield* client.server
    .recordHardwareIdentity({ params: { environmentId }, payload: { hardwareIdentity } })
    .pipe(Effect.as(true), Effect.timeout(RELAY_REQUEST_TIMEOUT));
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logDebug("Could not record this machine's identity with SpecWithCode Connect", {
      cause,
    }).pipe(Effect.as(false)),
  ),
);

/** Failed attempts to record the identity before waiting for the next restart or relink. */
const IDENTITY_RECORD_ATTEMPTS = 3;

/** {@link checkLinkOnce} once this server is active, then every {@link LINK_WATCH_INTERVAL}. */
export const layerWatch = Layer.effectDiscard(
  Effect.gen(function* () {
    // Attempts left; 0 once recorded. An older relay has no route for it, so
    // a few tries per run is enough until the relay is updated.
    const attemptsLeft = yield* Ref.make(IDENTITY_RECORD_ATTEMPTS);
    const watchOnce = Effect.gen(function* () {
      const answer = yield* checkLinkOnce;
      if (answer === "not_linked" || answer === "revoked") {
        // A new link carries the identity itself; look again after a relink.
        yield* Ref.set(attemptsLeft, IDENTITY_RECORD_ATTEMPTS);
        return;
      }
      if (answer !== "linked" || (yield* Ref.get(attemptsLeft)) === 0) return;
      const recorded = yield* recordHardwareIdentityOnce;
      yield* Ref.update(attemptsLeft, (left) => (recorded ? 0 : Math.max(0, left - 1)));
    });
    return yield* forkParked(
      watchOnce.pipe(Effect.repeat(Schedule.spaced(LINK_WATCH_INTERVAL)), Effect.asVoid),
    );
  }),
);
