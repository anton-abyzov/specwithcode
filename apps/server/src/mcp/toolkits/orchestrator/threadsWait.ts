import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadStatus,
  OrchestratorMcpThreadWaitResult,
  RunId,
  TrimmedNonEmptyString,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isTerminalThreadStatus } from "../../../fleet/remoteWorkerMatching.ts";

/** The same budget as one `studio_thread_wait`. */
export const MAX_THREADS_WAIT_MS = 60 * 60 * 1_000;
export const DEFAULT_THREADS_WAIT_MS = 10 * 60 * 1_000;
/**
 * Each wait is asked for at most this long at a time, so a hop through the
 * Connect edge, which drops a connection idle for 100s, never sits silent
 * that long (upstream's FORWARDED_WAIT_CHUNK_MS). Local waits use it too:
 * they cost nothing to repeat.
 */
export const WAIT_CHUNK_MS = 50_000;
export const MAX_THREADS_WAITED = 20;
/** How much of each thread's last reply comes back; studio_thread_read has the rest. */
export const LAST_REPLY_EXCERPT_CHARS = 800;
/** Timeline items read back from a thread's end to find its last reply. */
const LAST_REPLY_WINDOW = 40;
const LAST_REPLY_MAX_PAGES = 5;

export const ThreadsWaitInput = Schema.Struct({
  threads: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_THREADS_WAITED))
    .annotate({
      description:
        "Threads to wait on: each a threadRef or threadLink from studio_thread_list or studio_thread_launch (a studio://thread link names its machine), or a thread id on this machine. At most 20.",
    }),
  mode: Schema.optional(Schema.Literals(["any", "all"])).annotate({
    description:
      "'all' (default) returns when every thread is done; 'any' returns as soon as one is.",
  }),
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description:
      "Wait budget for the whole call, default 10 minutes, at most 60. A timeout does not interrupt any thread.",
  }),
});
export type ThreadsWaitInput = typeof ThreadsWaitInput.Type;

export const ThreadsWaitEntry = Schema.Struct({
  ref: Schema.String,
  machine: Schema.String.annotate({
    description: "'local' for this machine, else the machine's label from studio_machine_list.",
  }),
  threadId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(RunId),
  status: Schema.NullOr(OrchestratorMcpThreadStatus),
  done: Schema.Boolean,
  lastReply: Schema.NullOr(Schema.String),
  lastReplyTruncated: Schema.Boolean,
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
export type ThreadsWaitEntry = typeof ThreadsWaitEntry.Type;

export const ThreadsWaitResult = Schema.Struct({
  mode: Schema.Literals(["any", "all"]),
  timedOut: Schema.Boolean,
  threads: Schema.Array(ThreadsWaitEntry),
});
export type ThreadsWaitResult = typeof ThreadsWaitResult.Type;

/**
 * How one thread is waited on and read: the same routed calls as
 * `studio_thread_wait` and `studio_thread_read`, so every access check
 * applies to each thread as it would to a single call.
 */
export interface ThreadsWaitOps<R> {
  readonly wait: (
    ref: string,
    timeoutMs: number,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure, R>;
  readonly read: (
    ref: string,
    page: {
      readonly afterPosition?: number;
      readonly limit: number;
      readonly maxCharsPerItem: number;
    },
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure, R>;
}

type Waited =
  | { readonly kind: "result"; readonly result: OrchestratorMcpThreadWaitResult }
  | { readonly kind: "error"; readonly error: OrchestratorMcpFailure };

const isDone = (result: OrchestratorMcpThreadWaitResult) =>
  !result.timedOut && isTerminalThreadStatus(result.status);

const clampTimeout = (timeoutMs: number | undefined) =>
  Math.min(
    MAX_THREADS_WAIT_MS,
    Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs! : DEFAULT_THREADS_WAIT_MS),
  );

/** The latest assistant message in a thread, read back from its end; null when it has none. */
const lastReplyOf = <R>(ops: ThreadsWaitOps<R>, ref: string) =>
  Effect.gen(function* () {
    const head = yield* ops.read(ref, { limit: 1, maxCharsPerItem: 1 });
    // Inherited items sit ahead of a thread's own, so this start can only fall short of the end.
    let afterPosition = Math.max(-1, head.thread.itemCount - LAST_REPLY_WINDOW - 1);
    let last: { readonly text: string; readonly truncated: boolean } | null = null;
    for (let page = 0; page < LAST_REPLY_MAX_PAGES; page++) {
      const read = yield* ops.read(ref, {
        afterPosition,
        limit: 100,
        maxCharsPerItem: LAST_REPLY_EXCERPT_CHARS,
      });
      for (const item of read.items)
        if (item.type === "assistant_message" && item.text !== null)
          last = { text: item.text, truncated: item.textTruncated };
      if (!read.hasMore || read.nextPosition === null) break;
      afterPosition = read.nextPosition;
    }
    if (last === null) return { lastReply: null, lastReplyTruncated: false };
    const cut = last.text.length > LAST_REPLY_EXCERPT_CHARS;
    return {
      lastReply: cut ? `${last.text.slice(0, LAST_REPLY_EXCERPT_CHARS)}…` : last.text,
      lastReplyTruncated: cut || last.truncated,
    };
  }).pipe(Effect.orElseSucceed(() => ({ lastReply: null, lastReplyTruncated: false })));

/**
 * Waits on several threads, here or on other machines, until all of them
 * (or, in `any` mode, one of them) finish or the budget runs out. One
 * thread's failure, such as an unreachable machine, is reported in its row
 * and never fails the call. Nothing is interrupted on timeout.
 */
export const waitThreads = Effect.fn("mcp.waitThreads")(function* <R>(
  input: ThreadsWaitInput,
  ops: ThreadsWaitOps<R>,
) {
  const mode = input.mode ?? "all";
  const deadline = (yield* Clock.currentTimeMillis) + clampTimeout(input.timeoutMs);
  const latest = new Map<number, Waited>();
  const firstDone = yield* Deferred.make<void>();

  const follow = (ref: string, index: number): Effect.Effect<void, never, R> =>
    Effect.gen(function* () {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return;
      const waited: Waited = yield* ops.wait(ref, Math.min(remaining, WAIT_CHUNK_MS)).pipe(
        Effect.map((result) => ({ kind: "result" as const, result })),
        Effect.catch((error) => Effect.succeed({ kind: "error" as const, error })),
      );
      latest.set(index, waited);
      if (waited.kind === "error") return;
      if (isDone(waited.result)) {
        yield* Deferred.succeed(firstDone, undefined);
        return;
      }
      return yield* follow(ref, index);
    });

  const all = Effect.forEach(input.threads, follow, { concurrency: "unbounded", discard: true });
  yield* mode === "all" ? all : Effect.raceFirst(all, Deferred.await(firstDone));

  // A wait cut short by another thread finishing first, or never answered, is asked once more.
  yield* Effect.forEach(
    input.threads,
    (ref, index) => {
      const known = latest.get(index);
      if (known?.kind === "error" || (known?.kind === "result" && isDone(known.result)))
        return Effect.void;
      return ops.wait(ref, 1).pipe(
        Effect.tap((result) => Effect.sync(() => latest.set(index, { kind: "result", result }))),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (known === undefined) latest.set(index, { kind: "error", error });
          }),
        ),
      );
    },
    { concurrency: "unbounded", discard: true },
  );

  const threads = yield* Effect.forEach(
    input.threads,
    (ref, index) =>
      Effect.gen(function* () {
        const waited = latest.get(index);
        if (waited === undefined || waited.kind === "error")
          return {
            ref,
            machine: "unknown",
            threadId: null,
            runId: null,
            status: null,
            done: false,
            lastReply: null,
            lastReplyTruncated: false,
            error:
              waited === undefined
                ? { code: "timeout", message: "The wait ran out before this thread answered." }
                : { code: waited.error.code, message: waited.error.message },
          } satisfies ThreadsWaitEntry;
        const { result } = waited;
        return {
          ref,
          machine: result.machine?.label ?? "local",
          threadId: result.threadId,
          runId: result.runId,
          status: result.status,
          done: isDone(result),
          ...(yield* lastReplyOf(ops, ref)),
        } satisfies ThreadsWaitEntry;
      }),
    { concurrency: "unbounded" },
  );

  const settled = (entry: ThreadsWaitEntry) => entry.done || entry.error !== undefined;
  return {
    mode,
    timedOut:
      mode === "all"
        ? !threads.every(settled)
        : !threads.some((entry) => entry.done) && !threads.every(settled),
    threads,
  } satisfies ThreadsWaitResult;
});
