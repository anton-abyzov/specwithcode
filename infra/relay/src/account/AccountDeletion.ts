import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { managedEndpointDigestInput, managedEndpointTunnelName } from "../deploymentConfig.ts";
import { unlinkEnvironmentRecord } from "../environments/EnvironmentUnlink.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import {
  relayDeliveryAttempts,
  relayEnvironmentLinks,
  relayLiveActivities,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
  relayMobileDevices,
} from "../persistence/schema.ts";

export class AccountRecordsPersistenceError extends Schema.TaggedError<AccountRecordsPersistenceError>()(
  "AccountRecordsPersistenceError",
  {
    userId: Schema.String,
    stage: Schema.Literals(["list-environments", "list-allocations", "delete-rows"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.stage} while deleting account ${this.userId}.`;
  }
}

export class ClerkUserDeletionFailed extends Schema.TaggedError<ClerkUserDeletionFailed>()(
  "ClerkUserDeletionFailed",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete Clerk user ${this.userId}.`;
  }
}

export class AccountDeletionIncomplete extends Schema.TaggedError<AccountDeletionIncomplete>()(
  "AccountDeletionIncomplete",
  {
    userId: Schema.String,
    environmentIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Managed endpoints remain for account ${this.userId}: ${this.environmentIds.join(", ")}.`;
  }
}

/** Everything the relay stores per user, outside the unlink lifecycle. */
export class AccountRecords extends Context.Service<
  AccountRecords,
  {
    /** Environments with a link (active or revoked) or a managed endpoint allocation. */
    readonly listEnvironmentIds: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<string>, AccountRecordsPersistenceError>;
    readonly listAllocatedEnvironmentIds: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<string>, AccountRecordsPersistenceError>;
    /** Hard-deletes devices, Live Activities, delivery records, tunnel limits and links. */
    readonly deleteUserRows: (input: {
      readonly userId: string;
    }) => Effect.Effect<void, AccountRecordsPersistenceError>;
  }
>()("studio-relay/account/AccountDeletion/AccountRecords") {}

export const layerAccountRecords = Layer.effect(
  AccountRecords,
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const fail =
      (userId: string, stage: AccountRecordsPersistenceError["stage"]) => (cause: unknown) =>
        new AccountRecordsPersistenceError({ userId, stage, cause });
    const listAllocatedEnvironmentIds = Effect.fn("relay.account.listAllocatedEnvironmentIds")(
      function* (input: { readonly userId: string }) {
        const rows = yield* db
          .select({ environmentId: relayManagedEndpointAllocations.environmentId })
          .from(relayManagedEndpointAllocations)
          .where(eq(relayManagedEndpointAllocations.userId, input.userId))
          .pipe(Effect.mapError(fail(input.userId, "list-allocations")));
        return rows.map((row) => row.environmentId);
      },
    );
    return AccountRecords.of({
      listAllocatedEnvironmentIds,
      listEnvironmentIds: Effect.fn("relay.account.listEnvironmentIds")(function* (input) {
        const links = yield* db
          .select({ environmentId: relayEnvironmentLinks.environmentId })
          .from(relayEnvironmentLinks)
          .where(eq(relayEnvironmentLinks.userId, input.userId))
          .pipe(Effect.mapError(fail(input.userId, "list-environments")));
        const allocated = yield* listAllocatedEnvironmentIds(input);
        return [...new Set([...links.map((row) => row.environmentId), ...allocated])];
      }),
      deleteUserRows: Effect.fn("relay.account.deleteUserRows")(function* (input) {
        const userId = input.userId;
        // One D1 batch runs the deletes atomically.
        yield* RelayDb.batch(db, [
          db.delete(relayLiveActivities).where(eq(relayLiveActivities.userId, userId)),
          db.delete(relayMobileDevices).where(eq(relayMobileDevices.userId, userId)),
          db.delete(relayDeliveryAttempts).where(eq(relayDeliveryAttempts.userId, userId)),
          db.delete(relayManagedTunnelLimits).where(eq(relayManagedTunnelLimits.userId, userId)),
          db.delete(relayEnvironmentLinks).where(eq(relayEnvironmentLinks.userId, userId)),
        ]).pipe(Effect.mapError(fail(userId, "delete-rows")));
      }),
    });
  }),
);

export class ClerkUsers extends Context.Service<
  ClerkUsers,
  {
    /** Deletes the Clerk user. An already-deleted user counts as success. */
    readonly deleteUser: (userId: string) => Effect.Effect<void, ClerkUserDeletionFailed>;
  }
>()("studio-relay/account/AccountDeletion/ClerkUsers") {}

export const isClerkUserMissing = (error: unknown): boolean =>
  isClerkAPIResponseError(error) && error.status === 404;

export const layerClerkUsers = Layer.effect(
  ClerkUsers,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    return ClerkUsers.of({
      deleteUser: (userId) =>
        Effect.tryPromise({
          try: async () => {
            const client = createClerkClient({
              secretKey: Redacted.value(config.clerkSecretKey),
              publishableKey: config.clerkPublishableKey,
            });
            try {
              await client.users.deleteUser(userId);
            } catch (error) {
              if (!isClerkUserMissing(error)) throw error;
            }
          },
          catch: (cause) => new ClerkUserDeletionFailed({ userId, cause }),
        }),
    });
  }),
);

/** The held-webhook inbox key a user's endpoint for this environment uses, if any. */
const derivedEndpointKey = Effect.fn("relay.account.derivedEndpointKey")(function* (
  namespace: string,
  userId: string,
  environmentId: string,
) {
  const crypto = yield* Crypto.Crypto;
  const hash = yield* crypto
    .digest(
      "SHA-256",
      new TextEncoder().encode(managedEndpointDigestInput(namespace, userId, environmentId)),
    )
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return HeldHooks.endpointKeyForTunnelName(namespace, managedEndpointTunnelName(namespace, hash));
});

/**
 * Deletes everything the relay holds for a user, then the Clerk user. Each
 * step is idempotent, so a client retries the whole call after any failure.
 * The Clerk user goes last: while relay records remain, the caller can still
 * authenticate to finish the cleanup.
 */
export const deleteAccountRecords = Effect.fn("relay.account.deleteAccountRecords")(
  function* (input: {
    readonly userId: string;
    readonly managedEndpointNamespace?: string | undefined;
  }) {
    const records = yield* AccountRecords;
    const inbox = yield* HookInbox.HookInbox;
    const clerk = yield* ClerkUsers;
    const environmentIds = yield* records.listEnvironmentIds({ userId: input.userId });
    for (const environmentId of environmentIds) {
      yield* unlinkEnvironmentRecord({
        userId: input.userId,
        environmentId,
        managedEndpointNamespace: input.managedEndpointNamespace,
      });
      // Unlink clears the inbox only while it still finds the allocation, and
      // only as best effort. A retry may find no allocation left, so clear by
      // the derived key and fail on error so the client retries.
      if (input.managedEndpointNamespace) {
        const endpointKey = yield* derivedEndpointKey(
          input.managedEndpointNamespace,
          input.userId,
          environmentId,
        );
        if (endpointKey !== null) yield* inbox.clear({ endpointKey });
      }
    }
    const remaining = yield* records.listAllocatedEnvironmentIds({ userId: input.userId });
    if (remaining.length > 0) {
      return yield* new AccountDeletionIncomplete({
        userId: input.userId,
        environmentIds: remaining,
      });
    }
    yield* records.deleteUserRows({ userId: input.userId });
    yield* clerk.deleteUser(input.userId);
    return { deleted: true, environmentCount: environmentIds.length };
  },
);
