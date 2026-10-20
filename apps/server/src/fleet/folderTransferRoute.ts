import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { FOLDER_TRANSFER_PREFIX, MAX_REQUEST_BYTES } from "./folderTransfer/wire.ts";
import * as MachineHandoff from "./MachineHandoff.ts";

const refusal = (status: number, error: string, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, ...(headers ? { headers } : {}) });

/**
 * The source half of a folder copy: the destination pulls the scanned folder
 * here over the machines' private HTTPS address. Every request carries the
 * operation's transfer grant; the handoff service checks it before anything else.
 */
export const layer = HttpRouter.add(
  "*",
  `${FOLDER_TRANSFER_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (yield* (yield* ServiceUpdateHold.optional).isHeld)
      return refusal(503, "service_updating", { "retry-after": "30" });
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return refusal(400, "invalid_request");
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES)
      return refusal(413, "too_large");
    // Chunked requests carry no content-length, so the reader itself is capped.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? Option.some(new Uint8Array())
        : yield* request.arrayBuffer.pipe(
            Effect.map((buffer) => new Uint8Array(buffer)),
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(MAX_REQUEST_BYTES),
            ),
            Effect.option,
          );
    if (Option.isNone(body)) return refusal(413, "too_large");
    const handoff = yield* MachineHandoff.MachineHandoff;
    const response = yield* handoff.serveFolderTransfer({
      method: request.method,
      path: url.value.pathname.slice(FOLDER_TRANSFER_PREFIX.length),
      authorization: request.headers["authorization"] ?? null,
      body: () => Promise.resolve(body.value),
    });
    return HttpServerResponse.uint8Array(response.body, {
      status: response.status,
      contentType: response.contentType,
      headers: { "cache-control": "no-store" },
    });
  }),
);
