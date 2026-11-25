// @effect-diagnostics nodeBuiltinImport:off - drains a refused body on the Node socket.
import * as NodeHttp from "node:http";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

/**
 * The most body an API route reads. Every API payload is a small JSON or form
 * body; routes that take more (attachments, folder copy, handoff, webhooks,
 * MCP) are raw routes with their own limits.
 */
export const API_MAX_BODY_BYTES = 1024 * 1024;

const tooLarge = () =>
  HttpServerResponse.jsonUnsafe(
    { error: "request_too_large", message: "The request body is over 1 MiB." },
    { status: 413, headers: { "cache-control": "no-store" } },
  );

/** How much of a refused body is read and thrown away before the socket is dropped. */
const DISCARD_MAX_BYTES = 8 * API_MAX_BODY_BYTES;

/**
 * Reads and throws away what the client is still sending, keeping none of it,
 * so it sees the 413 instead of a reset; past {@link DISCARD_MAX_BYTES} the
 * socket is dropped.
 */
const discardRestOfBody = (source: NodeHttp.IncomingMessage) => {
  let discarded = 0;
  const onData = (chunk: Uint8Array) => {
    discarded += chunk.byteLength;
    if (discarded <= DISCARD_MAX_BYTES) return;
    source.off("data", onData);
    source.destroy();
  };
  source.on("data", onData);
  source.once("end", () => source.off("data", onData));
  source.resume();
};

/**
 * API routes refuse a body over {@link API_MAX_BODY_BYTES}: a declared length
 * over it is answered 413 before any byte is kept, and a chunked body stops
 * being read at the limit. Without it the unauthenticated sign-in routes buffer
 * whatever a caller sends.
 */
export const layerApiBodyLimit = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const declared = request.headers["content-length"];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isFinite(length) || length > API_MAX_BODY_BYTES) {
        if (request.source instanceof NodeHttp.IncomingMessage) {
          discardRestOfBody(request.source);
        }
        return tooLarge();
      }
    }
    // A chunked body has no length to check: the platform reader stops at the
    // limit and drops the connection.
    return yield* httpEffect.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(API_MAX_BODY_BYTES)),
    );
  }),
).layer;
