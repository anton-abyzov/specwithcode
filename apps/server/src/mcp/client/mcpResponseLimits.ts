/**
 * Limits on what another MCP server may send to this one when it acts as the
 * client. The SDK validates each answer with zod, which keeps one issue per
 * invalid array item: a 1 MB `{"content":[0,0,...]}` costs close to 1 GB of
 * heap. A byte limit alone does not bound that, so incoming messages are also
 * counted before the SDK sees them.
 */
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

/** Per HTTP answer from a fleet machine or Figma; screenshots come back as base64, twice. */
export const MCP_CLIENT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
/** One stdio message from a project connection; its call output is cut to 256 KiB anyway. */
export const MCP_STDIO_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Array items plus object fields in one message, far above any real tool list or answer. */
export const MCP_CLIENT_MAX_JSON_VALUES = 100_000;

export type McpAnswerLimit = "bytes" | "values";

const TOO_LARGE_TEXT = "The MCP server's answer was too large";
const STDIO_OVERFLOW = /ReadBuffer exceeded maximum size of (\d+) bytes/u;

/** An answer refused for its size, never a network failure. */
export class McpAnswerTooLargeError extends Error {
  readonly limit: McpAnswerLimit;
  /** The request it answered, when known. */
  readonly requestId: RequestId | undefined;

  constructor(limit: McpAnswerLimit, max: number | undefined, requestId?: RequestId) {
    const unit = limit === "bytes" ? "bytes" : "JSON values";
    super(
      max === undefined
        ? `${TOO_LARGE_TEXT} (over its ${limit === "bytes" ? "byte" : "value"} limit).`
        : `${TOO_LARGE_TEXT}: more than ${max.toLocaleString("en-US")} ${unit}.`,
    );
    this.name = "McpAnswerTooLargeError";
    this.limit = limit;
    this.requestId = requestId;
  }
}

/** The size refusal behind `error`, also after the SDK wrapped or re-created it. */
const asAnswerTooLarge = (error: unknown): McpAnswerTooLargeError | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof McpAnswerTooLargeError) return current;
    const data =
      current instanceof McpError ? (current.data as { answerTooLarge?: unknown }) : null;
    if (data?.answerTooLarge === "bytes" || data?.answerTooLarge === "values")
      return new McpAnswerTooLargeError(data.answerTooLarge, undefined);
    const overflow = STDIO_OVERFLOW.exec(current.message);
    if (overflow) return new McpAnswerTooLargeError("bytes", Number(overflow[1]));
    // The SDK's SSE reader keeps only the text of the error it saw.
    if (current.message.includes(TOO_LARGE_TEXT))
      return new McpAnswerTooLargeError("bytes", undefined);
    current = current.cause;
  }
  return undefined;
};

/** Whether a failed call was refused for the size of its answer. */
export const isMcpAnswerTooLarge = (error: unknown): boolean =>
  asAnswerTooLarge(error) !== undefined;

/** The JSON-RPC id of an outgoing request body, to fail only that call. */
const requestIdOf = (body: RequestInit["body"] | undefined): RequestId | undefined => {
  if (typeof body !== "string" || body.length > 1024 * 1024) return undefined;
  try {
    const message: unknown = JSON.parse(body);
    return isJSONRPCRequest(message) ? message.id : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Passes `response` through while counting its bytes. A declared length over
 * the limit is refused at once; a stream that passes it fails and its source
 * is cancelled, so the rest is never read.
 */
export const capResponseBytes = (
  response: Response,
  maxBytes: number,
  init?: RequestInit,
): Response => {
  const requestId = requestIdOf(init?.body);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpAnswerTooLargeError("bytes", maxBytes, requestId);
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let seen = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBytes) {
        const error = new McpAnswerTooLargeError("bytes", maxBytes, requestId);
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** `fetchImpl` with every response capped at `maxBytes`. */
export const cappedFetch =
  (fetchImpl: typeof fetch, maxBytes: number): typeof fetch =>
  async (input, init) =>
    capResponseBytes(await fetchImpl(input, init), maxBytes, init);

/**
 * Array items plus object fields in `value`, counted without recursion so a
 * deeply nested answer cannot overflow the stack. Stops as soon as the count
 * passes `limit`, so the result is exact only up to `limit + 1`.
 */
export const countJsonValues = (value: unknown, limit: number): number => {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (Array.isArray(current)) {
      count += current.length;
      if (count > limit) return count;
      for (const item of current) if (typeof item === "object" && item !== null) stack.push(item);
      continue;
    }
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      count += 1;
      if (count > limit) return count;
      const item = (current as Record<string, unknown>)[key];
      if (typeof item === "object" && item !== null) stack.push(item);
    }
  }
  return count;
};

const isResponse = (
  message: JSONRPCMessage,
): message is Extract<JSONRPCMessage, { readonly id: RequestId }> =>
  "id" in message && ("result" in message || "error" in message);

/** A transport whose incoming messages are counted before the SDK validates them. */
export class GuardedTransport<T extends Transport = Transport> implements Transport {
  readonly inner: T;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?:
    | (<M extends JSONRPCMessage>(message: M, extra?: MessageExtraInfo) => void)
    | undefined;
  readonly setProtocolVersion?: ((version: string) => void) | undefined;
  readonly #maxJsonValues: number;
  /** Requests sent and not answered yet, so a size refusal can answer them. */
  readonly #pending = new Set<RequestId>();

  constructor(inner: T, options: { readonly maxJsonValues: number }) {
    this.inner = inner;
    this.#maxJsonValues = options.maxJsonValues;
    if (inner.setProtocolVersion)
      this.setProtocolVersion = (version) => inner.setProtocolVersion?.(version);
    inner.onclose = () => {
      this.#pending.clear();
      this.onclose?.();
    };
    inner.onerror = (error) => this.#failed(error);
    inner.onmessage = (message, extra) => this.#received(message, extra);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const id = isJSONRPCRequest(message) ? message.id : undefined;
    if (id !== undefined) this.#pending.add(id);
    try {
      await this.inner.send(message, options);
    } catch (error) {
      if (id !== undefined) this.#pending.delete(id);
      throw error;
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** Answers `id` with the refusal instead of the message that was too large. */
  #refuse(id: RequestId, error: McpAnswerTooLargeError, extra?: MessageExtraInfo) {
    this.#pending.delete(id);
    this.onmessage?.(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: ErrorCode.InternalError,
          message: error.message,
          data: { answerTooLarge: error.limit },
        },
      },
      extra,
    );
  }

  #received(message: JSONRPCMessage, extra?: MessageExtraInfo) {
    const response = isResponse(message);
    if (countJsonValues(message, this.#maxJsonValues) > this.#maxJsonValues) {
      const error = new McpAnswerTooLargeError(
        "values",
        this.#maxJsonValues,
        response ? message.id : undefined,
      );
      if (response) this.#refuse(message.id, error, extra);
      else this.onerror?.(error);
      return;
    }
    if (response) this.#pending.delete(message.id);
    this.onmessage?.(message, extra);
  }

  #failed(error: Error) {
    const tooLarge = asAnswerTooLarge(error);
    if (tooLarge === undefined) {
      this.onerror?.(error);
      return;
    }
    // Only the request it answered when that is known; otherwise the
    // connection lost its place in the stream and every waiting call fails.
    const ids =
      tooLarge.requestId === undefined
        ? [...this.#pending]
        : this.#pending.has(tooLarge.requestId)
          ? [tooLarge.requestId]
          : [];
    for (const id of ids) this.#refuse(id, tooLarge);
    this.onerror?.(tooLarge);
  }
}

/**
 * Wraps `transport` so a message with more than `maxJsonValues` values never
 * reaches the SDK: an answer becomes an error for that request alone, and a
 * notification or server request is dropped and reported through `onerror`.
 * A byte limit the transport reports fails the waiting calls the same way.
 * The real transport stays reachable as `inner`.
 */
export const guardTransport = <T extends Transport>(
  transport: T,
  options: { readonly maxJsonValues: number },
): GuardedTransport<T> => new GuardedTransport(transport, options);
