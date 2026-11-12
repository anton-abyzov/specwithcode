import { createClerkClient } from "@clerk/backend";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

/** Clerk calls must leave room in the relay's 9 s request deadline. */
export const ADMIN_IDENTITY_REQUEST_TIMEOUT = Duration.seconds(3);
/** Accounts a search by email or name can return. */
export const ADMIN_IDENTITY_SEARCH_LIMIT = 50;

export interface AdminIdentity {
  readonly email: string | null;
  readonly name: string | null;
}

export class AdminIdentityLookupFailed extends Schema.TaggedError<AdminIdentityLookupFailed>()(
  "AdminIdentityLookupFailed",
  {
    operation: Schema.Literals(["lookup", "search"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk user ${this.operation} failed`;
  }
}

/** Who an account is, read from Clerk for the admin routes. */
export class AdminIdentities extends Context.Service<
  AdminIdentities,
  {
    /** Email and name of the given Clerk users; users Clerk does not know are left out. */
    readonly lookup: (
      userIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, AdminIdentity>, AdminIdentityLookupFailed>;
    /**
     * Clerk user ids matching an email or name, at most ADMIN_IDENTITY_SEARCH_LIMIT.
     * `truncated` says Clerk knows more matches than it returned.
     */
    readonly search: (
      query: string,
    ) => Effect.Effect<
      { readonly userIds: ReadonlyArray<string>; readonly truncated: boolean },
      AdminIdentityLookupFailed
    >;
  }
>()("studio-relay/admin/AdminIdentities") {}

interface ClerkUserLike {
  readonly id: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly primaryEmailAddressId?: string | null;
  readonly emailAddresses?: ReadonlyArray<{
    readonly id: string;
    readonly emailAddress: string;
  }> | null;
}

/** The primary email, else the first one; the name as Clerk has it, else null. */
export function toAdminIdentity(user: ClerkUserLike): AdminIdentity {
  const emails = user.emailAddresses ?? [];
  const email =
    emails.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress ??
    emails[0]?.emailAddress ??
    null;
  const name = [user.firstName, user.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  return { email, name: name === "" ? null : name };
}

export const layer = Layer.effect(
  AdminIdentities,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const users = () =>
      createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      }).users;
    const bounded =
      (operation: "lookup" | "search") =>
      <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new AdminIdentityLookupFailed({ operation, cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: ADMIN_IDENTITY_REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(new AdminIdentityLookupFailed({ operation, cause: "clerk_timeout" })),
          }),
        );
    return AdminIdentities.of({
      lookup: Effect.fn("relay.admin.identities.lookup")(function* (userIds) {
        if (userIds.length === 0) return new Map<string, AdminIdentity>();
        const page = yield* bounded("lookup")(() =>
          users().getUserList({ userId: [...userIds], limit: userIds.length }),
        );
        return new Map(page.data.map((user) => [user.id, toAdminIdentity(user)] as const));
      }),
      search: Effect.fn("relay.admin.identities.search")(function* (query) {
        const page = yield* bounded("search")(() =>
          users().getUserList({ query, limit: ADMIN_IDENTITY_SEARCH_LIMIT }),
        );
        return {
          userIds: page.data.map((user) => user.id),
          truncated: page.totalCount > page.data.length,
        };
      }),
    });
  }),
);
