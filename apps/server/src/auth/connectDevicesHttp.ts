import {
  AuthAccessWriteScope,
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import { deviceApprover, type DeviceApprover } from "./deviceApprover.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

export { deviceApprover, type DeviceApprover };

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

const MACHINE_SUBJECTS: ReadonlySet<string> = new Set([
  EnvironmentAuth.MCP_CLIENT_SUBJECT,
  EnvironmentAuth.FLEET_INVITATION_SUBJECT,
]);

/**
 * A session that manages access here but is not an approver (the app before its
 * update, a pair token) still sees the list, without controls. An app window
 * then hides them instead of reporting that it cannot reach this machine.
 */
const canReadList = (session: {
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  readonly principal?: { readonly kind: string } | undefined;
}) =>
  session.scopes.has(AuthAccessWriteScope) &&
  session.principal?.kind !== "coordinator" &&
  !MACHINE_SUBJECTS.has(session.subject) &&
  ConnectDeviceTrust.gatedDevice(session) === null;

const refused = new EnvironmentHttpForbiddenError({
  message:
    "Only this machine's owner or a device it approved can change who uses it. " +
    "On a machine without the app, run specwithcode service restart and open the new " +
    "Pairing URL from the service log within 5 minutes, or use an approved device.",
});

const storageFailure = (error: ConnectDeviceTrust.DeviceTrustError) =>
  new EnvironmentHttpInternalServerError({ message: error.message });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connectDevices",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;

    const approver = Effect.gen(function* () {
      yield* noStore;
      const session = yield* EnvironmentAuthenticatedPrincipal;
      return { session, approver: yield* deviceApprover(session, trust.isApproved) };
    });
    const requireApprover = approver.pipe(
      Effect.flatMap(({ approver }) =>
        approver === null ? Effect.fail(refused) : Effect.succeed(approver),
      ),
    );

    /**
     * Ends every session of one device here: its key's or its phone link's,
     * the MCP sessions it approved, and the pairing codes it made that no one
     * redeemed yet. Its other bound credentials (folder copies, asset URLs)
     * stop on their next use, since the approval they carry is gone.
     */
    const endSessions = (key: string) =>
      Effect.gen(function* () {
        yield* auth.revokeDeviceCredentials(key);
        let ended = 0;
        for (const id of yield* trust.boundIds(key))
          if (
            id.startsWith("session:") &&
            (yield* auth.revokeSession(AuthSessionId.make(id.slice("session:".length))))
          )
            ended += 1;
        if (key.startsWith("jkt:"))
          return (
            ended + (yield* auth.revokeSessionsByProofKeyThumbprints([key.slice("jkt:".length)]))
          );
        if (!key.startsWith("link:")) return ended;
        const subject = key.slice("link:".length);
        for (const session of yield* auth.listSessions())
          if (session.subject === subject && (yield* auth.revokeSession(session.sessionId)))
            ended += 1;
        return ended;
      }).pipe(
        Effect.mapError(
          () =>
            new EnvironmentHttpInternalServerError({
              message: "Could not end that device's sessions.",
            }),
        ),
      );

    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { session, approver: caller } = yield* approver;
          if (caller === null && !canReadList(session)) return yield* refused;
          const snapshot = yield* trust.snapshot.pipe(Effect.mapError(storageFailure));
          return {
            ...snapshot,
            notices: caller === null ? [] : ConnectDeviceTrust.noticesFor(snapshot, caller.key),
            canApprove: caller !== null && snapshot.health === "ok",
            canRepair: caller?.kind === "owner",
          };
        }),
      )
      .handle("approve", ({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireApprover;
          const outcome = yield* trust
            .approve({ code: payload.code, approvedBy: caller.name, approverKey: caller.key })
            .pipe(Effect.mapError(storageFailure));
          if (outcome.status === "approved")
            yield* Effect.logInfo("Approved a new device on this machine.", {
              kind: outcome.device.kind,
              approvedBy: caller.kind,
            });
          // The answer names the device as the list does, short ID included (1406).
          return outcome.status === "approved"
            ? { ...outcome, device: ConnectDeviceTrust.listedDevice(outcome.device) }
            : outcome;
        }),
      )
      .handle("deny", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireApprover;
          const denied = yield* trust.deny(payload.requestId).pipe(Effect.mapError(storageFailure));
          // A key turned away keeps nothing it was handed before (1327).
          if (denied !== null) yield* endSessions(denied);
          return { denied: denied !== null };
        }),
      )
      .handle("remove", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireApprover;
          const removed = yield* trust.remove(payload.key).pipe(Effect.mapError(storageFailure));
          // Off the list first, so the device cannot slip back in between.
          const endedSessions = removed === null ? 0 : yield* endSessions(removed.key);
          return { removed: removed !== null, endedSessions };
        }),
      )
      .handle("confirmReview", () =>
        Effect.gen(function* () {
          yield* requireApprover;
          yield* trust.confirmReview.pipe(Effect.mapError(storageFailure));
          return { done: true };
        }),
      )
      .handle("repair", () =>
        Effect.gen(function* () {
          const caller = yield* requireApprover;
          if (caller.kind !== "owner") return yield* refused;
          yield* trust.repair.pipe(Effect.mapError(storageFailure));
          return { done: true };
        }),
      );
  }),
);
