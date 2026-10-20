import { bearerToken } from "./transferGrant.ts";
import { SourceTransferError, type SourceTransfers } from "./sourceService.ts";
import {
  encodeFrames,
  FOLDER_TRANSFER_PREFIX,
  MAX_BATCH_CHUNKS,
  MAX_REQUEST_BYTES,
  SHA256,
} from "./wire.ts";

export interface RawRequest {
  readonly method: string;
  /** Path below FOLDER_TRANSFER_PREFIX, for example `/<operation>/chunks`. */
  readonly path: string;
  readonly authorization: string | null;
  readonly body: () => Promise<Uint8Array>;
}

export interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
}

const json = (status: number, value: unknown): RawResponse => ({
  status,
  contentType: "application/json",
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const stringList = (value: unknown, max: number): Array<string> => {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string"))
    throw new SourceTransferError(400, "invalid_request");
  return value as Array<string>;
};

/**
 * Serves one copy to its destination. Every route needs the operation's bearer;
 * every refusal before authorization is the same 401 so the endpoint reveals
 * nothing about which operations exist.
 */
export async function handleSourceRequest(
  transfers: SourceTransfers,
  environmentId: string,
  request: RawRequest,
): Promise<RawResponse> {
  try {
    const match = /^\/([a-f0-9-]{36})\/([a-z]+)$/.exec(request.path);
    if (!match) return json(404, { error: "not_found" });
    const [, operationId, action] = match as unknown as [string, string, string];
    const loaded = await transfers.authorize(operationId, bearerToken(request.authorization));
    const body = async () => {
      const bytes = await request.body();
      if (bytes.byteLength > MAX_REQUEST_BYTES) throw new SourceTransferError(413, "too_large");
      try {
        return (bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as Record<
          string,
          unknown
        >;
      } catch {
        throw new SourceTransferError(400, "invalid_request");
      }
    };
    switch (`${request.method} ${action}`) {
      case "GET hello":
        return json(200, transfers.hello(loaded, environmentId));
      case "POST manifest": {
        const input = await body();
        const record = await transfers.requestManifest(loaded, stringList(input.selection, 8));
        return json(202, { state: record.state, progress: record.progress });
      }
      case "GET manifest": {
        const result = await transfers.manifest(loaded);
        return result.ready
          ? { status: 200, contentType: "application/gzip", body: result.bytes }
          : json(202, { state: result.record.state, progress: result.record.progress });
      }
      case "POST chunks": {
        const hashes = stringList((await body()).chunks, MAX_BATCH_CHUNKS);
        if (hashes.some((hash) => !SHA256.test(hash)))
          throw new SourceTransferError(400, "invalid_request");
        return {
          status: 200,
          contentType: "application/x-swc-chunks",
          body: encodeFrames(await transfers.chunks(loaded, hashes)),
        };
      }
      case "POST stat":
        return json(200, {
          entries: await transfers.stat(loaded, stringList((await body()).paths, 5000)),
        });
      case "POST refresh":
        return json(200, {
          entries: await transfers.refresh(loaded, stringList((await body()).paths, 1000)),
        });
      case "POST ancestry": {
        const input = await body();
        if (typeof input.repository !== "string")
          throw new SourceTransferError(400, "invalid_request");
        return json(200, {
          commits: await transfers.ancestry(
            loaded,
            input.repository,
            stringList(input.commits, 64),
          ),
        });
      }
      case "POST release": {
        const input = await body();
        const record = await transfers.release(
          loaded,
          typeof input.reason === "string" ? input.reason : "",
        );
        return json(200, { state: record.state });
      }
      case "POST commit":
        return json(200, { state: (await transfers.commit(loaded)).state });
      default:
        return json(404, { error: "not_found" });
    }
  } catch (cause) {
    if (cause instanceof SourceTransferError)
      return json(cause.status, {
        error: cause.code,
        ...(cause.status === 409 && cause.message !== cause.code ? { detail: cause.message } : {}),
      });
    return json(500, { error: "internal" });
  }
}

export { FOLDER_TRANSFER_PREFIX };
