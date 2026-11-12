/**
 * Owner-only admin routes: the gate that hides them from everyone else, and
 * the read-only handlers behind it.
 */
import { RelayApi } from "@specweave-studio/contracts/relay";
import {
  RELAY_ADMIN_ACCOUNTS_PAGE_SIZE,
  type RelayAdminAccount,
  RelayAdminAccountNotFoundError,
  RelayAdminAuth,
  RelayAdminPrincipal,
  type RelayAdminTunnelLive,
  RelayAdminUnavailableError,
} from "@specweave-studio/contracts/relayAdmin";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as PhoneRemovals from "../agentActivity/PhoneRemovals.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import { verifyRelayClientBearerToken } from "../http/ClerkBearer.ts";
import { currentTraceId } from "../http/mapErrorTags.ts";
import * as PhoneRemovalApi from "../http/PhoneRemovalApi.ts";
import { readHttpAuthorizationCredential } from "../http/requestCredentials.ts";
import * as AdminIdentities from "./AdminIdentities.ts";
import * as ConnectAdminQueries from "./ConnectAdminQueries.ts";

/** Distinctive log message: every admin request an owner made, for Workers Logs. */
export const CONNECT_ADMIN_LOG_MESSAGE = "connect_admin_request";

/** Cloudflare's live tunnel readings for one account must fit in this. */
export const ADMIN_TUNNEL_STATUS_TIMEOUT = Duration.seconds(3);

/** What a path the relay does not have answers: nothing tells a caller the routes exist. */
const notFound = () => HttpServerResponse.empty({ status: 404 });

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

export const layerAdminAuth = Layer.effect(
  RelayAdminAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const removals = yield* PhoneRemovals.PhoneRemovals;
    const owners = new Set(config.adminUserIds ?? []);
    /** The owner a token belongs to, or null. Any doubt or failure is "not an owner". */
    const ownerOf = Effect.fnUntraced(
      function* (token: string) {
        const verified = yield* verifyRelayClientBearerToken(config, token);
        // Only an interactive Clerk session of an owner. The headless CLI's
        // OAuth token is refused even for an owner's account.
        if (verified.mode !== "clerk_session_bearer" || !owners.has(verified.sub)) return null;
        if (verified.sid) {
          // A removed phone's session is refused; so is one the relay cannot check.
          const session = yield* PhoneRemovalApi.clerkSessionStatus({
            userId: verified.sub,
            clerkSessionId: verified.sid,
          }).pipe(Effect.provideService(PhoneRemovals.PhoneRemovals, removals));
          if (session !== "allowed") return null;
        }
        return verified.sub;
      },
      Effect.catchCause(() => Effect.succeed(null)),
    );

    return {
      adminBearer: Effect.fn("relay.auth.admin.bearer")(function* (httpEffect, { credential }) {
        // Nobody is an owner: the routes are off, and no token is even looked at.
        if (owners.size === 0) return notFound();
        const userId = yield* ownerOf(readHttpAuthorizationCredential(credential));
        if (userId === null) return notFound();
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "admin",
          "relay.auth.subject": userId,
        });
        yield* Effect.logInfo(CONNECT_ADMIN_LOG_MESSAGE, {
          log: CONNECT_ADMIN_LOG_MESSAGE,
          owner: userId,
          method: request.method,
          path: request.url.split("?", 1)[0],
        });
        yield* noStore;
        return yield* httpEffect.pipe(Effect.provideService(RelayAdminPrincipal, { userId }));
      }),
    };
  }),
);

const unavailable = (reason: RelayAdminUnavailableError["reason"]) =>
  currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new RelayAdminUnavailableError({ code: "admin_unavailable", reason, traceId })),
    ),
  );

const LIVE_STATES: ReadonlySet<string> = new Set(["healthy", "degraded", "down", "inactive"]);

const liveState = (status: string | null | undefined): RelayAdminTunnelLive =>
  status && LIVE_STATES.has(status) ? (status as RelayAdminTunnelLive) : "unknown";

export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
    const identities = yield* AdminIdentities.AdminIdentities;
    const tunnels = yield* ManagedEndpointProvider.ManagedEndpointTunnelClient;

    /** Email and name for a page. A Clerk failure leaves the page with ids only. */
    const identify = Effect.fnUntraced(function* (
      rows: ReadonlyArray<ConnectAdminQueries.AdminAccountRow>,
    ) {
      const known = yield* identities.lookup(rows.map((row) => row.userId)).pipe(
        Effect.map((found) => ({ found, read: true })),
        Effect.catch((error) =>
          Effect.logWarning("Connect admin could not read identities", {
            operation: error.operation,
          }).pipe(
            Effect.as({ found: new Map<string, AdminIdentities.AdminIdentity>(), read: false }),
          ),
        ),
      );
      return {
        accounts: rows.map((row): RelayAdminAccount => ({
          ...row,
          email: known.found.get(row.userId)?.email ?? null,
          name: known.found.get(row.userId)?.name ?? null,
        })),
        identities: known.read ? ("read" as const) : ("unavailable" as const),
      };
    });

    /** Cloudflare's reading per tunnel id. Whatever is not read in time is left out. */
    const readLive = Effect.fnUntraced(function* (tunnelIds: ReadonlyArray<string>) {
      const read = new Map<string, { live: RelayAdminTunnelLive; changedAt: string | null }>();
      yield* Effect.forEach(
        tunnelIds,
        (tunnelId) =>
          tunnels.get(tunnelId).pipe(
            Effect.map((tunnel) => {
              read.set(tunnelId, {
                live: liveState(tunnel.status),
                changedAt: tunnel.connsInactiveAt ?? null,
              });
            }),
            Effect.catch(() => Effect.void),
          ),
        { concurrency: 5, discard: true },
      ).pipe(Effect.timeoutOption(ADMIN_TUNNEL_STATUS_TIMEOUT));
      return read;
    });

    return handlers
      .handle(
        "me",
        Effect.fn("relay.api.admin.me")(function* () {
          const { userId } = yield* RelayAdminPrincipal;
          return { userId };
        }),
      )
      .handle(
        "overview",
        Effect.fn("relay.api.admin.overview")(function* () {
          return yield* queries
            .overview()
            .pipe(Effect.catch(() => unavailable("persistence_failed")));
        }),
      )
      .handle(
        "listAccounts",
        Effect.fn("relay.api.admin.listAccounts")(function* ({ query }) {
          const search = query.query?.trim() ?? "";
          // An id is matched as it is; anything else is an email or name Clerk looks up.
          const userIds =
            search === ""
              ? undefined
              : search.startsWith("user_")
                ? [search]
                : yield* identities
                    .search(search)
                    .pipe(Effect.catch(() => unavailable("identity_lookup_failed")));
          const listed = yield* queries
            .listAccounts({
              limit: RELAY_ADMIN_ACCOUNTS_PAGE_SIZE,
              cursor: query.cursor,
              userIds,
            })
            .pipe(Effect.catch(() => unavailable("persistence_failed")));
          return { ...(yield* identify(listed.accounts)), nextCursor: listed.nextCursor };
        }),
      )
      .handle(
        "account",
        Effect.fn("relay.api.admin.account")(function* ({ params }) {
          const found = yield* queries
            .account(params.userId)
            .pipe(Effect.catch(() => unavailable("persistence_failed")));
          if (found === null) {
            return yield* new RelayAdminAccountNotFoundError({ code: "account_not_found" });
          }
          const [identified, live] = yield* Effect.all(
            [
              identify([found.account]),
              readLive(found.machines.flatMap((machine) => machine.tunnelId ?? [])),
            ],
            { concurrency: 2 },
          );
          return {
            account: identified.accounts[0]!,
            machines: found.machines.map(({ tunnelId, ...machine }) => ({
              ...machine,
              live: (tunnelId === null ? undefined : live.get(tunnelId)?.live) ?? "unknown",
              liveChangedAt:
                (tunnelId === null ? undefined : live.get(tunnelId)?.changedAt) ?? null,
            })),
            phones: found.phones,
          };
        }),
      );
  }),
);
