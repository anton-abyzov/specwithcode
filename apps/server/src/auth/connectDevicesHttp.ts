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
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

/** Who is asking to approve, deny or remove, in the words the list records. */
export type DeviceApprover =
  | { readonly kind: "owner"; readonly name: string; readonly key: null }
  | { readonly kind: "device"; readonly name: string; readonly key: string };

const MACHINE_SUBJECTS: ReadonlySet<string> = new Set([
  EnvironmentAuth.MCP_CLIENT_SUBJECT,
  EnvironmentAuth.FLEET_INVITATION_SUBJECT,
]);

/**
 * The server-side caller test (B-02): no scope separates an approved device
 * from a waiting one, so the caller itself decides. This machine's owner is a
 * local session holding `access:write` that is not another machine's; an
 * approved device is a gated session whose key is on the list. Anything else,
 * including any coordinator or worker grant, may not approve.
 */
export const deviceApprover = (
  session: {
    readonly subject: string;
    readonly scopes: ReadonlySet<string>;
    readonly principal?: { readonly kind: string } | undefined;
    readonly proofKeyThumbprint?: string | undefined;
    readonly clientLabel?: string | undefined;
  },
  isApproved: (key: string) => Effect.Effect<boolean>,
): Effect.Effect<DeviceApprover | null> =>
  Effect.gen(function* () {
    if (session.principal?.kind === "coordinator" || MACHINE_SUBJECTS.has(session.subject))
      return null;
    const device = ConnectDeviceTrust.gatedDevice(session);
    if (device !== null) {
      if (device.key === null || !(yield* isApproved(device.key))) return null;
      return { kind: "device", name: device.label, key: device.key };
    }
    return session.scopes.has(AuthAccessWriteScope)
      ? { kind: "owner", name: "this machine", key: null }
      : null;
  });

const refused = new EnvironmentHttpForbiddenError({
  message: "Only this machine's owner or a device it approved can change who uses it.",
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
     * and the MCP sessions it approved. Its other bound credentials (folder
     * copies) stop on their next use, since the approval they name is gone.
     */
    const endSessions = (key: string) =>
      Effect.gen(function* () {
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
          const { approver: caller } = yield* approver;
          if (caller === null) return yield* refused;
          const snapshot = yield* trust.snapshot.pipe(Effect.mapError(storageFailure));
          return {
            ...snapshot,
            canApprove: snapshot.health === "ok",
            canRepair: caller.kind === "owner",
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
          return outcome;
        }),
      )
      .handle("deny", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireApprover;
          return {
            denied: yield* trust.deny(payload.requestId).pipe(Effect.mapError(storageFailure)),
          };
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
