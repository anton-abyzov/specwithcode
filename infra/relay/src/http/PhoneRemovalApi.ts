import type { RelayPublicClientId } from "@specweave-studio/contracts/relay";
import * as Effect from "effect/Effect";

import * as PhoneRemovals from "../agentActivity/PhoneRemovals.ts";
import * as ClerkSessions from "../auth/ClerkSessions.ts";
import * as ClientKeyRevocations from "../environments/ClientKeyRevocations.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";

/**
 * Removes the user's phone: records the removal and stops its pushes, ends
 * the Clerk sessions it used (so only an interactive sign-in brings it back)
 * and tells the user's linked environments to end its sessions.
 */
export const removePhone = Effect.fn("relay.phone_removal.remove")(function* (
  input: PhoneRemovals.PhoneSelector & {
    readonly onlyPhones?: boolean | undefined;
    readonly exceptEnvironmentId?: string | undefined;
  },
) {
  const removals = yield* PhoneRemovals.PhoneRemovals;
  const sessions = yield* ClerkSessions.ClerkSessions;
  const revocations = yield* ClientKeyRevocations.ClientKeyRevocations;
  const result = yield* removals.remove(input);
  yield* Effect.annotateCurrentSpan({
    "relay.phone_removal.removed": result.removed,
    "relay.phone_removal.sessions": result.clerkSessionIds.length,
    "relay.phone_removal.keys": result.proofKeyThumbprints.length,
  });
  yield* Effect.all(
    [
      Effect.forEach(result.clerkSessionIds, (sessionId) => sessions.revoke(sessionId), {
        concurrency: "unbounded",
        discard: true,
      }),
      revocations.notify({
        userId: input.userId,
        proofKeyThumbprints: result.proofKeyThumbprints,
        exceptEnvironmentId: input.exceptEnvironmentId,
      }),
    ],
    { concurrency: 2, discard: true },
  );
  return result;
});

/**
 * The first time a removed phone shows a device id, key or Clerk session its
 * removal lacks (a registration made before keys were recorded, or a phone
 * removed by key alone), records it and ends it: Clerk signs that session
 * out and linked environments drop that key. Best effort.
 */
const backfillRemoval = Effect.fnUntraced(function* (
  removal: PhoneRemovals.PhoneRemovalRecord,
  presented: PhoneRemovals.PhoneRequestSelector,
) {
  const deviceId = removal.deviceId === null ? presented.deviceId : undefined;
  const proofKeyThumbprint =
    removal.proofKeyThumbprint === null ? presented.proofKeyThumbprint : undefined;
  const clerkSessionId = removal.clerkSessionId === null ? presented.clerkSessionId : undefined;
  if (!deviceId && !proofKeyThumbprint && !clerkSessionId) return;
  const removals = yield* PhoneRemovals.PhoneRemovals;
  const sessions = yield* ClerkSessions.ClerkSessions;
  const revocations = yield* ClientKeyRevocations.ClientKeyRevocations;
  yield* Effect.annotateCurrentSpan({ "relay.phone_removal.backfilled": true });
  yield* removals
    .backfill({
      userId: presented.userId,
      removalId: removal.id,
      deviceId,
      proofKeyThumbprint,
      clerkSessionId,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not complete a phone removal", { stage: error.stage }),
      ),
    );
  yield* Effect.all(
    [
      clerkSessionId ? sessions.revoke(clerkSessionId) : Effect.void,
      proofKeyThumbprint
        ? revocations.notify({
            userId: presented.userId,
            proofKeyThumbprints: [proofKeyThumbprint],
          })
        : Effect.void,
    ],
    { concurrency: 2, discard: true },
  );
});

/**
 * Settles a request from a phone a removal blocks. A removed phone is let
 * back in only with a Clerk session created after its removal: a fresh
 * interactive sign-in, since the removal ended the session it had. Admission
 * clears the removal (by everything the request presented, its device id
 * included) and returns true. Otherwise the removal takes what the request
 * presented; its Clerk session is ended only when it is known to predate the
 * removal, since an unknown or unreadable session might be a fresh sign-in.
 */
const settleBlockedPhone = Effect.fnUntraced(function* (
  blocking: PhoneRemovals.PhoneRemovalRecord,
  presented: PhoneRemovals.PhoneRequestSelector,
) {
  const sessionId = presented.clerkSessionId;
  let createdAt: number | null = null;
  if (sessionId && sessionId !== blocking.clerkSessionId) {
    const sessions = yield* ClerkSessions.ClerkSessions;
    createdAt = yield* sessions.getCreatedAt(sessionId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Clerk session lookup failed for a removed phone", {
          errorTag: error._tag,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
  }
  const removedAt = Date.parse(blocking.removedAt);
  if (createdAt === null || !Number.isFinite(removedAt) || createdAt <= removedAt) {
    yield* backfillRemoval(blocking, {
      userId: presented.userId,
      deviceId: presented.deviceId,
      proofKeyThumbprint: presented.proofKeyThumbprint,
      clerkSessionId: createdAt === null ? undefined : sessionId,
    });
    return false;
  }
  const removals = yield* PhoneRemovals.PhoneRemovals;
  yield* removals.clear(presented);
  yield* Effect.annotateCurrentSpan({ "relay.phone_removal.cleared": true });
  return true;
});

/**
 * Whether the phone presenting this device id, DPoP key or Clerk session was
 * removed from the account and has not signed in again since; completes the
 * removal with what it presented.
 */
export const isRemovedPhone = Effect.fn("relay.phone_removal.is_removed")(function* (
  input: PhoneRemovals.PhoneRequestSelector,
) {
  const removals = yield* PhoneRemovals.PhoneRemovals;
  const blocking = yield* removals.findBlocking(input);
  if (!blocking) return false;
  yield* Effect.annotateCurrentSpan({ "relay.phone_removal.blocked": true });
  return !(yield* settleBlockedPhone(blocking, input));
});

/**
 * Whether a Clerk session belongs to a removed phone; "unavailable" when the
 * relay could not tell.
 */
export const clerkSessionStatus = Effect.fn("relay.phone_removal.clerk_session_status")(
  function* (input: { readonly userId: string; readonly clerkSessionId: string }) {
    const removals = yield* PhoneRemovals.PhoneRemovals;
    return yield* removals.findBlocking(input).pipe(
      Effect.map((blocking) => (blocking ? ("removed" as const) : ("allowed" as const))),
      Effect.catch((error) =>
        Effect.logWarning("Phone removal check failed", { stage: error.stage }).pipe(
          Effect.as("unavailable" as const),
        ),
      ),
    );
  },
);

/** Whether the phone holding this DPoP key was removed, from any account. */
export const removalStatus = Effect.fn("relay.phone_removal.removal_status")(function* (
  proofKeyThumbprint: string,
) {
  const removals = yield* PhoneRemovals.PhoneRemovals;
  return { removed: yield* removals.isKeyRemoved({ proofKeyThumbprint }) };
});

/**
 * Decides whether a token exchange from a possibly removed phone may proceed.
 * A removed phone is let back in only with a Clerk session created after its
 * removal: a fresh interactive sign-in, since the removal ended the session
 * it had. A refreshed token from the same session, or any doubt (no session
 * id, a failed Clerk lookup), keeps it refused (see settleBlockedPhone). An
 * admitted exchange records which client, device and session the key is
 * for.
 */
export const admitTokenExchange = Effect.fn("relay.phone_removal.admit_token_exchange")(
  function* (input: {
    readonly userId: string;
    readonly clientId: RelayPublicClientId;
    readonly deviceId?: string | undefined;
    readonly proofKeyThumbprint: string;
    readonly clerkSessionId?: string | undefined;
  }) {
    const removals = yield* PhoneRemovals.PhoneRemovals;
    const blocking = yield* removals.findBlocking(input);
    if (blocking) {
      yield* Effect.annotateCurrentSpan({ "relay.phone_removal.blocked": true });
      if (!(yield* settleBlockedPhone(blocking, input))) return false;
    }
    yield* removals.recordClientKey({
      userId: input.userId,
      proofKeyThumbprint: input.proofKeyThumbprint,
      clientId: input.clientId,
      deviceId: input.deviceId,
      clerkSessionId: input.clerkSessionId,
    });
    return true;
  },
);

/** Accounts an environment credential acts for: its active links proven by its key. */
const environmentOwners = Effect.fnUntraced(function* (input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const owned = yield* links.findActiveManagedForEnvironment(input);
  return [...new Set(owned.map((link) => link.userId))];
});

/**
 * A Mac revoking a Connect client it knows only by its DPoP key. Only a
 * phone's key is removed: another browser over Connect is the Mac's alone
 * to revoke.
 */
export const removeClientKeyForEnvironment = Effect.fn(
  "relay.phone_removal.remove_client_key_for_environment",
)(function* (input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly proofKeyThumbprint: string;
}) {
  let removed = false;
  for (const userId of yield* environmentOwners(input)) {
    const result = yield* removePhone({
      userId,
      proofKeyThumbprint: input.proofKeyThumbprint,
      onlyPhones: true,
      exceptEnvironmentId: input.environmentId,
    });
    removed = removed || result.removed;
  }
  return { removed };
});

export const listRemovedClientKeysForEnvironment = Effect.fn(
  "relay.phone_removal.list_removed_client_keys_for_environment",
)(function* (input: { readonly environmentId: string; readonly environmentPublicKey: string }) {
  const removals = yield* PhoneRemovals.PhoneRemovals;
  const thumbprints = new Set<string>();
  for (const userId of yield* environmentOwners(input)) {
    for (const thumbprint of yield* removals.listRemovedThumbprints({ userId })) {
      thumbprints.add(thumbprint);
    }
  }
  return { proofKeyThumbprints: [...thumbprints].sort() };
});
