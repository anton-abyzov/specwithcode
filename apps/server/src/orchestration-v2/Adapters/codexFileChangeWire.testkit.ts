import * as CodexClient from "@specweave-studio/effect-codex-app-server/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** In-memory JSON-RPC peer; the production client and decoder handle every frame. */
export const makeCodexFileChangeWirePeer = (reply: (method: string) => Effect.Effect<unknown>) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    const responses = new Map<string, Deferred.Deferred<Record<string, unknown>>>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const send = (frame: unknown) => Queue.offer(input, encoder.encode(`${encodeFrame(frame)}\n`));
    let remainder = "";
    let requestIndex = 0;
    const processChunk = (chunk: string | Uint8Array) =>
      Effect.gen(function* () {
        remainder += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame = decodeFrame(line);
          if (typeof frame.method === "string") {
            if (frame.id !== undefined)
              yield* send({ id: frame.id, result: yield* reply(frame.method) });
          } else {
            const deferred = responses.get(String(frame.id));
            if (!deferred) return yield* Effect.die("Unexpected JSON-RPC approval response.");
            yield* Deferred.succeed(deferred, frame);
          }
        }
      });
    const client = yield* CodexClient.make(
      Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stdout: () => Sink.forEach(processChunk),
        stderr: () => Sink.drain,
      }),
    );
    let barrier: Deferred.Deferred<void> | undefined;
    yield* client.handleUnknownServerNotification((method) =>
      method === "test/flush" && barrier
        ? Deferred.succeed(barrier, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    return {
      client,
      notify: (method: string, params: unknown) => send({ method, params }),
      flush: Effect.gen(function* () {
        barrier = yield* Deferred.make<void>();
        yield* send({ method: "test/flush" });
        yield* Deferred.await(barrier);
      }),
      request: (method: string, params: unknown) =>
        Effect.gen(function* () {
          const id = `peer-${++requestIndex}`;
          const deferred = yield* Deferred.make<Record<string, unknown>>();
          responses.set(id, deferred);
          yield* send({ id, method, params });
          const response = yield* Deferred.await(deferred);
          responses.delete(id);
          if (response.error !== undefined) return yield* Effect.die(response.error);
          return response.result;
        }),
    };
  });
