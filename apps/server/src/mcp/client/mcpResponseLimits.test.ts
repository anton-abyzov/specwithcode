import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vite-plus/test";

import {
  MCP_CLIENT_MAX_JSON_VALUES,
  McpAnswerTooLargeError,
  capResponseBytes,
  cappedFetch,
  countJsonValues,
  guardTransport,
  isMcpAnswerTooLarge,
} from "./mcpResponseLimits.ts";

const MiB = 1024 * 1024;

/** A body of `chunks` chunks of `size` bytes that records how far it was read. */
const countedBody = (chunks: number, size: number) => {
  const state = { pulled: 0, cancelled: false as unknown };
  const chunk = new Uint8Array(size).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      state.cancelled = reason ?? true;
    },
  });
  return { body, state };
};

describe("countJsonValues", () => {
  it("counts array items and object fields, flat and nested", () => {
    expect(countJsonValues(0, 10)).toBe(0);
    expect(countJsonValues([1, 2, 3], 10)).toBe(3);
    expect(countJsonValues({ a: 1, b: "x" }, 10)).toBe(2);
    expect(countJsonValues({ a: [1, { b: [2, 3] }], c: null }, 100)).toBe(7);
  });

  it("walks a 1,000,000-deep answer without overflowing the stack and stops early", () => {
    let deep: unknown = 0;
    for (let index = 0; index < 1_000_000; index += 1) deep = [deep];
    expect(countJsonValues(deep, 2_000_000)).toBe(1_000_000);
    expect(countJsonValues(deep, 10)).toBe(11);
    const wide = Array.from({ length: 1_000_000 }, () => ({ a: 1 }));
    // Stops at the array itself, before visiting a single item.
    expect(countJsonValues(wide, 10)).toBe(1_000_000);
    expect(countJsonValues({ items: wide.slice(0, 50) }, 60)).toBe(61);
  });
});

describe("capResponseBytes", () => {
  it("stops a streamed body past the limit and cancels its source", async () => {
    const { body, state } = countedBody(100, MiB);
    const capped = capResponseBytes(new Response(body), 4 * MiB);
    const error = await capped.arrayBuffer().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpAnswerTooLargeError);
    expect((error as McpAnswerTooLargeError).limit).toBe("bytes");
    expect((error as Error).message).toMatch(/answer was too large: more than 4,194,304 bytes/);
    // Read one chunk past the limit, never the other 95 MiB.
    expect(state.pulled).toBeLessThanOrEqual(6);
    expect(state.cancelled).toBeInstanceOf(McpAnswerTooLargeError);
  });

  it("passes a body under the limit through unchanged", async () => {
    const { body } = countedBody(3, MiB);
    const capped = capResponseBytes(new Response(body, { status: 201 }), 4 * MiB);
    expect(capped.status).toBe(201);
    expect((await capped.arrayBuffer()).byteLength).toBe(3 * MiB);
  });

  it("refuses a declared Content-Length over the limit before reading, for that request", async () => {
    const { body, state } = countedBody(100, MiB);
    const response = new Response(body, { headers: { "content-length": String(100 * MiB) } });
    const fetchImpl = (async () => response) as unknown as typeof fetch;
    const error = await cappedFetch(fetchImpl, 4 * MiB)("http://127.0.0.1/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }),
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpAnswerTooLargeError);
    expect((error as McpAnswerTooLargeError).requestId).toBe(7);
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(state.cancelled).not.toBe(false);
  });
});

/** A transport that records what the guard asks of it. */
const recordingTransport = () => {
  const calls: string[] = [];
  const sent: JSONRPCMessage[] = [];
  const transport: Transport & { sessionId?: string | undefined } = {
    sessionId: "session-1",
    start: async () => {
      calls.push("start");
    },
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {
      calls.push("close");
    },
    setProtocolVersion: (version) => {
      calls.push(`version:${version}`);
    },
  };
  return { transport, calls, sent };
};

describe("guardTransport", () => {
  const big = { content: Array.from({ length: 101 }, () => 0) };

  it("turns an oversized answer into an error for that id only", async () => {
    const { transport } = recordingTransport();
    const guarded = guardTransport(transport, { maxJsonValues: 100 });
    const received: Array<[JSONRPCMessage, MessageExtraInfo | undefined]> = [];
    guarded.onmessage = (message, extra) => received.push([message, extra]);
    await guarded.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    await guarded.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    const extra = { authInfo: { token: "t", clientId: "c", scopes: [] } };
    transport.onmessage?.({ jsonrpc: "2.0", id: 1, result: big }, extra);
    const normal = { jsonrpc: "2.0" as const, id: 2, result: { content: [] } };
    transport.onmessage?.(normal, extra);
    expect(received).toHaveLength(2);
    expect(received[0]![0]).toMatchObject({
      id: 1,
      error: {
        message: expect.stringMatching(/answer was too large/),
        data: { answerTooLarge: "values" },
      },
    });
    expect(received[0]![1]).toBe(extra);
    // The normal answer is the same object, with its second argument untouched.
    expect(received[1]![0]).toBe(normal);
    expect(received[1]![1]).toBe(extra);
  });

  it("drops an oversized notification or server request and reports it", () => {
    const { transport } = recordingTransport();
    const guarded = guardTransport(transport, { maxJsonValues: 100 });
    const received: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    guarded.onmessage = (message) => received.push(message);
    guarded.onerror = (error) => errors.push(error);
    transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/message", params: big });
    transport.onmessage?.({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage", params: big });
    expect(received).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => isMcpAnswerTooLarge(error))).toBe(true);
  });

  it("delegates start, send, close, sessionId and the protocol version", async () => {
    const { transport, calls, sent } = recordingTransport();
    const guarded = guardTransport(transport, { maxJsonValues: 100 });
    let closed = false;
    guarded.onclose = () => {
      closed = true;
    };
    await guarded.start();
    const message = { jsonrpc: "2.0" as const, id: 3, method: "ping" };
    await guarded.send(message);
    expect(sent).toEqual([message]);
    expect(guarded.sessionId).toBe("session-1");
    transport.sessionId = "session-2";
    expect(guarded.sessionId).toBe("session-2");
    guarded.setProtocolVersion?.("2025-11-25");
    await guarded.close();
    transport.onclose?.();
    expect(closed).toBe(true);
    expect(calls).toEqual(["start", "version:2025-11-25", "close"]);
    expect(guarded.inner).toBe(transport);
    // Errors that are not about size pass through as they are.
    const errors: Error[] = [];
    guarded.onerror = (error) => errors.push(error);
    const network = new Error("socket hang up");
    transport.onerror?.(network);
    expect(errors).toEqual([network]);
  });

  it("fails every waiting call when the transport reports a byte overflow", async () => {
    const { transport } = recordingTransport();
    const guarded = guardTransport(transport, { maxJsonValues: 100 });
    const received: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    guarded.onmessage = (message) => received.push(message);
    guarded.onerror = (error) => errors.push(error);
    await guarded.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    await guarded.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} });
    // What the SDK's stdio reader reports before it closes the connection.
    transport.onerror?.(new Error("ReadBuffer exceeded maximum size of 8388608 bytes"));
    expect(received.map((message) => ("id" in message ? message.id : null))).toEqual([4, 5]);
    expect(JSON.stringify(received)).toMatch(/more than 8,388,608 bytes/);
    expect(errors[0]).toBeInstanceOf(McpAnswerTooLargeError);
  });
});

describe("a real SDK client behind the guard", () => {
  it("rejects a 1 MB answer of bare zeros without the SDK validating it", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // About 1 MB as JSON: "0," per item.
    const zeros = Array.from({ length: 500_000 }, () => 0);
    serverSide.onmessage = (message) => {
      if (!("id" in message) || !("method" in message)) return;
      if (message.method === "initialize")
        void serverSide.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "hostile", version: "1" },
          },
        });
      else if (message.method === "ping")
        void serverSide.send({ jsonrpc: "2.0", id: message.id, result: {} });
      else if (message.method === "tools/call")
        void serverSide.send({ jsonrpc: "2.0", id: message.id, result: { content: zeros } });
    };
    await serverSide.start();
    const client = new Client({ name: "limits-test", version: "1" });
    await client.connect(guardTransport(clientSide, { maxJsonValues: MCP_CLIENT_MAX_JSON_VALUES }));
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const error = await client
      .callTool({ name: "anything", arguments: {} })
      .catch((cause: unknown) => cause);
    const grown = process.memoryUsage().heapUsed - before;
    // @effect-diagnostics-next-line globalConsole:off -- the measured growth, for the record.
    console.info(`heapUsed grew by ${(grown / MiB).toFixed(1)} MB across the 1 MB call`);
    expect(isMcpAnswerTooLarge(error)).toBe(true);
    expect((error as Error).message).toMatch(/answer was too large: more than 100,000 JSON values/);
    expect(grown).toBeLessThan(50 * MiB);
    // The connection is still usable.
    expect(await client.ping()).toEqual({});
    await client.close();
  });
});
