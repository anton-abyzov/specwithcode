import * as DateTime from "effect/DateTime";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
} from "@specweave-studio/contracts";
import { isIP } from "node:net";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Config from "../config.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./requestOrigin.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  DEVICE_SIGN_IN_APPROVED_TTL_MS,
  DEVICE_SIGN_IN_POLL_INTERVAL_MS,
  DeviceSignInRequests,
} from "./DeviceSignInRequests.ts";
import { requireEnvironmentScope } from "./http.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    }),
  ),
);

/**
 * Whether a Host header names this machine in a way no public DNS name can
 * fake. A DNS-rebinding page sends its own domain as both Origin and Host, so
 * the same-origin check alone would let it in. IP literals, loopback and
 * `.localhost` names, single-label and `.local` names, Tailscale MagicDNS
 * names and configured trusted origins pass; other domains do not.
 */
export function deviceSignInHostAllowed(
  host: string | undefined,
  trustedOrigins: ReadonlyArray<string>,
): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (!hostname.includes(".") || hostname.endsWith(".local")) return true;
  if (hostname.endsWith(".ts.net")) return true;
  return trustedOrigins.some((origin) => {
    try {
      return new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  });
}

/**
 * The address a per-source cap counts against; behind a local proxy, the
 * forwarded client. Only the rightmost X-Forwarded-For entry was written by
 * that proxy: entries to its left came from the client and can be anything.
 */
export function deviceSignInSource(
  socketAddress: string | null | undefined,
  forwardedFor: string | undefined,
): string {
  const socket = socketAddress ?? "unknown";
  const loopback = socket === "::1" || socket.startsWith("127.");
  const forwarded = forwardedFor?.split(",").at(-1)?.trim();
  return loopback && forwarded ? forwarded : socket;
}

/**
 * Only a page served by this server (or the Mac app) may ask or collect. The
 * packaged desktop answers CORS with a wildcard, so without this a web page
 * open in the owner's browser could start a request and read the credential
 * the owner approves.
 */
const requireSameOrigin = (message: string, credentialed: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* Config.ServerConfig;
    const allowed = capacityMutationOriginAllowed({
      origin: request.headers.origin,
      host: request.headers.host,
      requestUrl: request.originalUrl,
      forwardedProto: request.headers["x-forwarded-proto"],
      fetchSite: request.headers["sec-fetch-site"],
      authorization: credentialed ? request.headers.authorization : undefined,
      cookie: credentialed ? request.headers.cookie : undefined,
      trustedOrigins: mutationTrustedOrigins(config),
    });
    if (!allowed) return yield* new EnvironmentHttpForbiddenError({ message });
    if (
      !credentialed &&
      !deviceSignInHostAllowed(request.headers.host, mutationTrustedOrigins(config))
    )
      return yield* new EnvironmentHttpForbiddenError({
        message: "Open this machine by its IP, Tailscale or local name to ask to sign in.",
      });
    yield* noStore;
    return request;
  });

const deviceLabel = (info: { readonly browser: string | null; readonly os: string | null }) =>
  [info.browser, info.os].filter(Boolean).join(" on ") || "Approved device";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "deviceSignIn",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const requests = new DeviceSignInRequests();

    return handlers
      .handle("start", () =>
        Effect.gen(function* () {
          const descriptor = yield* serverAuth.getDescriptor();
          if (!descriptor.bootstrapMethods.includes("one-time-token"))
            return yield* new EnvironmentHttpForbiddenError({
              message: "This machine only accepts the desktop app it runs in.",
            });
          const request = yield* requireSameOrigin(
            "Ask to sign in from a page this server opened.",
            false,
          );
          const metadata = deriveAuthClientMetadata({ request });
          const forwardedFor = request.headers["x-forwarded-for"];
          const outcome = requests.start({
            deviceType: metadata.deviceType,
            browser: metadata.browser ?? null,
            os: metadata.os ?? null,
            ipAddress: metadata.ipAddress ?? null,
            origin: request.headers.origin ?? null,
            source: deviceSignInSource(
              metadata.ipAddress,
              typeof forwardedFor === "string" ? forwardedFor : undefined,
            ),
          });
          if (!outcome.ok)
            return yield* new EnvironmentHttpConflictError({
              message: "Too many devices are waiting to sign in. Try again in a few minutes.",
            });
          return {
            requestId: outcome.requestId,
            pollToken: outcome.pollToken,
            code: outcome.code,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(outcome.expiresAt)),
            pollIntervalMs: DEVICE_SIGN_IN_POLL_INTERVAL_MS,
          };
        }),
      )
      .handle("poll", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSameOrigin("Check a sign-in request from the page that asked.", false);
          return requests.poll(payload.requestId, payload.pollToken);
        }),
      )
      .handle("approve", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* requireSameOrigin(
            "Approving a device requires an authorized same-origin request.",
            true,
          );
          if (principal.principal?.kind === "coordinator")
            return yield* new EnvironmentHttpForbiddenError({
              message: "Only this machine's owner can approve a device here.",
            });
          const pending = requests.pendingByCode(payload.code);
          if (!pending) return { status: "not-found" as const };
          const device = {
            deviceType: pending.deviceType,
            browser: pending.browser,
            os: pending.os,
            address: pending.source,
            askedAt: DateTime.formatIso(DateTime.makeUnsafe(pending.createdAt)),
          };
          if (!payload.confirm) return { status: "found" as const, device };
          // Standard client access, never more than the approver holds: a new
          // device cannot approve others or mint pairing links.
          const scopes = AuthStandardClientScopes.filter((scope) => principal.scopes.has(scope));
          if (scopes.length === 0)
            return yield* new EnvironmentHttpBadRequestError({
              message: "This session cannot grant access to another device.",
            });
          const issued = yield* serverAuth
            .createPairingLink({
              scopes,
              subject: "device-approval",
              label: deviceLabel(pending),
              ttl: Duration.millis(DEVICE_SIGN_IN_APPROVED_TTL_MS),
            })
            .pipe(
              Effect.mapError(
                () =>
                  new EnvironmentHttpInternalServerError({
                    message: "Could not approve this device.",
                  }),
              ),
            );
          if (!requests.approve(pending.requestId, issued)) {
            yield* serverAuth.revokePairingLink(issued.id).pipe(Effect.ignore);
            return { status: "not-found" as const };
          }
          return { status: "approved" as const, device };
        }),
      );
  }),
);
