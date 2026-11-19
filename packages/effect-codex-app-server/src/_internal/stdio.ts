import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

/** How much of the process's error output is kept to explain an exit. */
const STDERR_TAIL_LIMIT = 8_192;
/** How long an exit waits for the rest of the error output to arrive. */
const STDERR_SETTLE_MS = 500;
const SUMMARY_LIMIT = 300;
const ERROR_LINE = /^(?:[A-Za-z]*Error|error|fatal|panic|thread '.*' panicked)\b[:\s]?/;
const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2})|Bearer\s+\S+/g;

export const appendStderrTail = (current: string, chunk: string): string =>
  (current + chunk).slice(-STDERR_TAIL_LIMIT);

/**
 * The one line of a process's error output that says why it stopped: the last
 * line that names an error, else the last line. Stack frames and Node's
 * banner are skipped, token-like text is masked, and it is cut to one sentence's length.
 */
export const summarizeStderr = (stderr: string): string | undefined => {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^at\s/.test(line) &&
        !/^Node\.js v\d/.test(line) &&
        !/^\^+$/.test(line) &&
        !/^(?:throw|file:\/\/|node:internal)/.test(line),
    );
  const picked = lines.findLast((line) => ERROR_LINE.test(line)) ?? lines.at(-1);
  if (picked === undefined) return undefined;
  const masked = picked.replace(SECRET, "[hidden]");
  return masked.length > SUMMARY_LIMIT ? `${masked.slice(0, SUMMARY_LIMIT - 1)}…` : masked;
};

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  readStderr?: Effect.Effect<string>,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) =>
      (readStderr ?? Effect.succeed("")).pipe(
        Effect.map((stderr) => {
          const reason = code === 0 ? undefined : summarizeStderr(stderr);
          return new CodexError.CodexAppServerProcessExitedError({
            code,
            pid: handle.pid,
            ...(reason ? { stderr: reason } : {}),
          });
        }),
      ),
  });

/**
 * Keeps the tail of a child's error output, and reads it once the output has
 * ended or settled, so an exit can say why.
 */
export const collectStderrTail = Effect.fn("collectStderrTail")(function* (
  handle: Pick<ChildProcessSpawner.ChildProcessHandle, "stderr">,
) {
  const tail = yield* Ref.make("");
  const ended = yield* Deferred.make<void>();
  const decoder = new TextDecoder();
  yield* Stream.runForEach(handle.stderr, (chunk) =>
    Ref.update(tail, (current) =>
      appendStderrTail(current, decoder.decode(chunk, { stream: true })),
    ),
  ).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(ended, undefined)), Effect.forkScoped);
  return Deferred.await(ended).pipe(
    Effect.timeoutOption(STDERR_SETTLE_MS),
    Effect.andThen(Ref.get(tail)),
  );
});
