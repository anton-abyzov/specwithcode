// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the copy's HTTP route on a real socket.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as CredentialFailureLimiter from "../auth/CredentialFailureLimiter.ts";
import * as FolderTransferRoute from "./folderTransferRoute.ts";
import { FOLDER_TRANSFER_PREFIX } from "./folderTransfer/wire.ts";
import * as MachineHandoff from "./MachineHandoff.ts";

const OPERATION = "0b0e9c4e-5d6f-4a1b-8c2d-3e4f5a6b7c8d";

/** One request on a real socket; `declared` false sends the body chunked, with no length. */
const send = (origin: string, action: string, bytes: number, declared: boolean) =>
  new Promise<number>((resolve) => {
    const body = Buffer.alloc(bytes, 0x20);
    const request = NodeHttp.request(
      `${origin}${FOLDER_TRANSFER_PREFIX}/${OPERATION}/${action}`,
      {
        method: "POST",
        agent: false,
        headers: declared
          ? { "content-length": String(bytes) }
          : { "transfer-encoding": "chunked" },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", () => resolve(0));
    request.end(body);
  });

it.effect("refuses a retire over 1 KiB at the socket, before the copy service sees it", () =>
  Effect.gen(function* () {
    const served: Array<[string, number]> = [];
    const services = yield* Layer.build(
      HttpRouter.serve(FolderTransferRoute.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(CredentialFailureLimiter.layer),
        Layer.provide(
          Layer.mock(MachineHandoff.MachineHandoff)({
            serveFolderTransfer: (request) =>
              Effect.promise(async () => {
                served.push([request.path.split("/").at(-1)!, (await request.body()).byteLength]);
                return {
                  status: 200,
                  contentType: "application/json",
                  body: new TextEncoder().encode("{}"),
                };
              }),
          }),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    const post = (action: string, bytes: number, declared = true) =>
      Effect.promise(() => send(origin, action, bytes, declared));
    // One byte past the limit, declared and streamed: refused, and never handed on.
    expect(yield* post("lan-retire", 1025)).toBe(413);
    expect(yield* post("lan-retire", 1025, false)).toBe(413);
    expect(yield* post("lan-retire", 256 * 1024, false)).toBe(413);
    expect(served).toEqual([]);
    // At the limit it is served, and other routes keep their own, larger limit.
    expect(yield* post("lan-retire", 1024)).toBe(200);
    expect(yield* post("chunks", 64 * 1024)).toBe(200);
    expect(served).toEqual([
      ["lan-retire", 1024],
      ["chunks", 64 * 1024],
    ]);
  }).pipe(Effect.scoped),
);
