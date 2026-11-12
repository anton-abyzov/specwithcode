/**
 * How many people signed up and how many were active lately, counted from
 * Clerk for the owner's usage numbers. Only counts leave this module.
 */
import { createClerkClient } from "@clerk/backend";
import type { RelayAdminSignUps } from "@specweave-studio/contracts/relayAdmin";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import { ADMIN_IDENTITY_REQUEST_TIMEOUT } from "./AdminIdentities.ts";
import { countByWeek, countInWindows, usageWeekStarts, usageWindowStarts } from "./usageWindows.ts";

/** People one read of Clerk returns; Clerk allows no more per request. */
export const ADMIN_SIGN_UPS_READ_LIMIT = 500;

export class AdminSignUpsReadFailed extends Schema.TaggedError<AdminSignUpsReadFailed>()(
  "AdminSignUpsReadFailed",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Clerk sign-up read failed";
  }
}

export class AdminSignUps extends Context.Service<
  AdminSignUps,
  {
    /** Sign-ups and activity in the windows that end at `nowMs`. */
    readonly read: (nowMs: number) => Effect.Effect<RelayAdminSignUps, AdminSignUpsReadFailed>;
  }
>()("studio-relay/admin/AdminSignUps") {}

/** What the counts are made from: two moments of a person, and nothing else. */
export interface SignUpMoments {
  readonly createdAt: number;
  readonly lastActiveAt: number | null;
}

/**
 * Counts from two reads of Clerk: the newest sign-ups, and the people active
 * most recently. A read that stops inside a window makes the answer a lower
 * bound, and `complete` says so.
 */
export function summarizeSignUps(input: {
  readonly nowMs: number;
  readonly total: number;
  readonly newest: ReadonlyArray<SignUpMoments>;
  readonly lastActive: ReadonlyArray<SignUpMoments>;
}): RelayAdminSignUps {
  const { nowMs, total, newest, lastActive } = input;
  const created = newest.map((user) => user.createdAt);
  const active = lastActive.flatMap((user) => user.lastActiveAt ?? []);
  const firstWeek = usageWeekStarts(nowMs)[0] ?? nowMs;
  const monthStart = usageWindowStarts(nowMs).month;
  const oldestCreated = newest.at(-1)?.createdAt;
  const leastRecent = lastActive.at(-1)?.lastActiveAt;
  // A read covers its windows when it returned everyone, or went back past them.
  const createdCovered =
    newest.length >= total ||
    (oldestCreated !== undefined && oldestCreated < Math.min(firstWeek, monthStart));
  const activeCovered =
    lastActive.length >= total ||
    (leastRecent !== undefined && leastRecent !== null && leastRecent < monthStart);
  return {
    total,
    created: countInWindows(created, nowMs),
    active: countInWindows(active, nowMs),
    weekly: countByWeek(created, nowMs),
    complete: createdCovered && activeCovered,
  };
}

export const layer = Layer.effect(
  AdminSignUps,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const users = () =>
      createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      }).users;
    const list = (orderBy: "-created_at" | "-last_active_at") =>
      Effect.tryPromise({
        try: () => users().getUserList({ orderBy, limit: ADMIN_SIGN_UPS_READ_LIMIT }),
        catch: (cause) => new AdminSignUpsReadFailed({ cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: ADMIN_IDENTITY_REQUEST_TIMEOUT,
          orElse: () => Effect.fail(new AdminSignUpsReadFailed({ cause: "clerk_timeout" })),
        }),
      );
    return AdminSignUps.of({
      read: Effect.fn("relay.admin.sign_ups.read")(function* (nowMs) {
        const [newest, lastActive] = yield* Effect.all(
          [list("-created_at"), list("-last_active_at")],
          { concurrency: 2 },
        );
        // Only the two moments are kept: no id, email or name is read further.
        const moments = (page: typeof newest): ReadonlyArray<SignUpMoments> =>
          page.data.map((user) => ({
            createdAt: user.createdAt,
            lastActiveAt: user.lastActiveAt,
          }));
        return summarizeSignUps({
          nowMs,
          total: newest.totalCount,
          newest: moments(newest),
          lastActive: moments(lastActive),
        });
      }),
    });
  }),
);
