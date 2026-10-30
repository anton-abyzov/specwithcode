// @effect-diagnostics nodeBuiltinImport:off - a plain loopback HTTP server for transfer tests.
import * as NodeHttp from "node:http";

import { CaptureFilesystemRefused, verifyCaptureFilesystem } from "./sourceCaptureFilesystem.ts";
import { handleSourceRequest } from "./sourceRoutes.ts";
import type { SourceTransfers } from "./sourceService.ts";
import { FOLDER_TRANSFER_PREFIX } from "./wire.ts";

/**
 * Treats the test volume as one captured copies cannot verify for moving copies, so
 * they keep the live-file checks network volumes use. Plain copies still capture.
 */
export async function liveMovingCopies(root: string, mode: string): Promise<void> {
  if (mode === "copy-and-move")
    throw new CaptureFilesystemRefused("This test treats the source as an unverifiable volume.");
  await verifyCaptureFilesystem(root);
}

/** Serves the source routes on 127.0.0.1 exactly as the app's HTTP router does. */
export async function serveSource(
  transfers: SourceTransfers,
  environmentId: string,
): Promise<{
  readonly url: string;
  readonly requests: Array<{ action: string; body: string }>;
  readonly close: () => Promise<void>;
}> {
  const requests: Array<{ action: string; body: string }> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith(FOLDER_TRANSFER_PREFIX)) {
      response.writeHead(404).end();
      return;
    }
    const path = pathname.slice(FOLDER_TRANSFER_PREFIX.length);
    requests.push({ action: path.split("/").at(-1) ?? "", body: body.toString("utf8") });
    const result = await handleSourceRequest(transfers, environmentId, {
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization ?? null,
      body: async () => body,
    });
    response
      .writeHead(result.status, { "content-type": result.contentType })
      .end(Buffer.from(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
