import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";

/**
 * Clerk calls this when a user is deleted outside the app (Clerk's account
 * portal, the Clerk dashboard), so the relay deletes that user's records too.
 * Not under `/v1/hooks/`, which forwards machines' webhooks.
 */
export const CLERK_WEBHOOK_PATH = "/v1/webhooks/clerk";

/** Svix refuses replays older than this, and so do we. */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** The replay store's scope for Clerk deliveries, apart from DPoP keys and link challenges. */
const CLERK_WEBHOOK_REPLAY_SCOPE = "clerk-webhook";

/** Past the last accepted second, so a prune can never readmit a delivery the window still takes. */
const CLERK_WEBHOOK_REPLAY_MARGIN_SECONDS = 60;

const encoder = new TextEncoder();

const decodeBase64 = (value: string): Uint8Array | null => {
  const decoded = Base64.decode(value);
  return Result.isSuccess(decoded) ? decoded.success : null;
};

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
};

/**
 * Checks a Svix signature: HMAC-SHA256, keyed by the base64 part of the
 * `whsec_` secret, over `<svix-id>.<svix-timestamp>.<raw body bytes>`. The
 * `svix-signature` header holds space-separated `v1,<base64>` entries; any one
 * matching is enough, so a secret rotation keeps working.
 */
export const verifySvixSignature = (input: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  readonly signatures: string;
  readonly body: Uint8Array;
  readonly nowSeconds: number;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!/^\d{1,12}$/u.test(input.timestamp)) return false;
    if (Math.abs(input.nowSeconds - Number(input.timestamp)) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
      return false;
    }
    const keyBytes = decodeBase64(input.secret.trim().replace(/^whsec_/u, ""));
    if (keyBytes === null || keyBytes.length === 0) return false;
    const prefix = encoder.encode(`${input.id}.${input.timestamp}.`);
    const signed = new Uint8Array(prefix.length + input.body.length);
    signed.set(prefix);
    signed.set(input.body, prefix.length);
    const expected = yield* Effect.promise(async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyBytes),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, signed));
    });
    return input.signatures.split(" ").some((entry) => {
      const [version, signature] = entry.split(",", 2);
      if (version !== "v1" || signature === undefined) return false;
      const candidate = decodeBase64(signature);
      return candidate !== null && constantTimeEqual(candidate, expected);
    });
  });

const ClerkWebhookEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({ id: Schema.optional(Schema.String) }),
});
const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(ClerkWebhookEvent));

const empty = (status: number) => HttpServerResponse.empty({ status });

/** The longest cause text a deletion warning keeps. */
const CAUSE_DETAIL_MAX_CHARS = 300;

const causeText = (cause: unknown): string => {
  const parts: Array<string> = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = (current as { readonly cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- ");
};

/**
 * What a failed deletion logs: the error's tag, the step that failed and the
 * underlying cause's text, with the user id taken out and the text capped.
 */
export const deletionFailureDetail = (
  error: { readonly _tag: string; readonly stage?: string; readonly cause?: unknown },
  userId: string,
): Record<string, string> => {
  const detail: Record<string, string> = { errorTag: error._tag };
  if (error.stage !== undefined) detail.stage = error.stage;
  if (error.cause !== undefined) {
    detail.cause = causeText(error.cause)
      .split(userId)
      .join("<user>")
      .slice(0, CAUSE_DETAIL_MAX_CHARS);
  }
  return detail;
};

type DeletionServices = Effect.Services<ReturnType<typeof AccountDeletion.deleteAccountRecords>>;

export const handleClerkWebhook = Effect.fn("relay.webhooks.clerk")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const secret = config.clerkWebhookSigningSecret;
  // No secret means nobody can prove a request came from Clerk: refuse all.
  if (secret === undefined || Redacted.value(secret).trim() === "") return empty(503);
  const id = request.headers["svix-id"];
  const timestamp = request.headers["svix-timestamp"];
  const signatures = request.headers["svix-signature"];
  if (!id || !timestamp || !signatures) return empty(401);
  const body = yield* request.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.orElseSucceed(() => null),
  );
  if (body === null) return empty(400);
  const verified = yield* verifySvixSignature({
    secret: Redacted.value(secret),
    id,
    timestamp,
    signatures,
    body,
    nowSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
  });
  if (!verified) return empty(401);
  // A captured delivery replayed inside the window does nothing. Clerk's own
  // retry signs the same message id with a new timestamp, so the pair is the
  // nonce: a retry after a 500 still acts. The record outlives the window by a minute.
  const issuedAt = Number(timestamp);
  const fresh = yield* DpopProofs.DpopProofReplay.use((replay) =>
    replay.consume({
      thumbprint: CLERK_WEBHOOK_REPLAY_SCOPE,
      jti: `${id}.${timestamp}`,
      iat: issuedAt,
      expiresAt: DateTime.makeUnsafe(
        (issuedAt + SVIX_TIMESTAMP_TOLERANCE_SECONDS + CLERK_WEBHOOK_REPLAY_MARGIN_SECONDS) * 1_000,
      ),
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Clerk webhook replay check failed", { errorTag: error._tag }).pipe(
        Effect.as(null),
      ),
    ),
  );
  if (fresh === null) return empty(500);
  if (!fresh) return empty(204);
  const event = decodeEvent(new TextDecoder().decode(body));
  if (Result.isFailure(event)) return empty(400);
  // Clerk sends every event type the endpoint subscribes to; only one matters.
  if (event.success.type !== "user.deleted") return empty(204);
  const userId = event.success.data.id;
  if (userId === undefined || userId.trim() === "") return empty(400);
  yield* Effect.annotateCurrentSpan({ "relay.webhook.clerk.event": event.success.type });
  // A user the relay never saw deletes nothing and still answers 2xx. A
  // failure answers 500 so Clerk retries; every deletion step is idempotent.
  return yield* AccountDeletion.deleteAccountRecords({
    userId,
    managedEndpointNamespace: config.managedEndpointNamespace,
  }).pipe(
    Effect.as(empty(204)),
    Effect.catch((error) =>
      Effect.logWarning(
        "Clerk user deletion left relay records behind",
        deletionFailureDetail(error, userId),
      ).pipe(Effect.as(empty(500))),
    ),
  );
});

/** The route, with the account-deletion services it needs captured once. */
export const layerClerkWebhookRoute = Layer.unwrap(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      DeletionServices | DpopProofs.DpopProofReplay | RelayConfiguration.RelayConfiguration
    >();
    return HttpRouter.add("POST", CLERK_WEBHOOK_PATH, (request) =>
      handleClerkWebhook(request).pipe(Effect.provideContext(context)),
    );
  }),
);
