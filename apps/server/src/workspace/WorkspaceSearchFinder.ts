// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - per-call deadlines and the load retry window for the fff workers, outside Effect.
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";

import type {
  DirSearchOptions,
  DirSearchResult,
  GrepOptions,
  GrepResult,
  InitOptions,
  MixedSearchResult,
  Result,
  SearchOptions,
  SearchResult,
} from "@ff-labs/fff-node";

/**
 * The file finder as the workspace search index uses it. Every call is
 * asynchronous so the finder can live off the event loop thread, and
 * `destroy` never waits.
 */
export interface SearchFinder {
  readonly isScanning: () => Promise<boolean>;
  readonly waitForIndexReady: (timeoutMs: number) => Promise<Result<boolean>>;
  readonly scanFiles: () => Promise<Result<void>>;
  readonly fileSearch: (query: string, options: SearchOptions) => Promise<Result<SearchResult>>;
  readonly directorySearch: (
    query: string,
    options: DirSearchOptions,
  ) => Promise<Result<DirSearchResult>>;
  readonly mixedSearch: (
    query: string,
    options: SearchOptions,
  ) => Promise<Result<MixedSearchResult>>;
  readonly grep: (query: string, options: GrepOptions) => Promise<Result<GrepResult>>;
  readonly destroy: () => void;
}

export interface SearchFinderBackend {
  readonly create: (options: InitOptions) => Promise<Result<SearchFinder>>;
}

// fff-node stays external to the CLI bundle because it dlopens a native
// library. A static `import` of an external package is a hard error inside a
// Node single-executable (only built-ins resolve there), so load it through
// `require`, which reads from the real filesystem in every runtime.
const requireForFff = NodeModule.createRequire(import.meta.url);
const loadFff = () => requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

/**
 * fff on the calling thread, for tests only: a native call that waits on a
 * lock blocks the thread that made it, so the service never uses this. A
 * process must not use it alongside the worker backend either, since ffi-rs
 * cannot be called from two threads at once (see below).
 */
export const inProcessFinderBackend: SearchFinderBackend = {
  create: async (options) => {
    const result = loadFff().FileFinder.create(options);
    if (!result.ok) return result;
    const finder = result.value;
    return {
      ok: true,
      value: {
        isScanning: async () => finder.isScanning(),
        waitForIndexReady: (timeoutMs) => finder.waitForIndexReady(timeoutMs),
        scanFiles: async () => finder.scanFiles(),
        fileSearch: async (query, options) => finder.fileSearch(query, options),
        directorySearch: async (query, options) => finder.directorySearch(query, options),
        mixedSearch: async (query, options) => finder.mixedSearch(query, options),
        grep: async (query, options) => finder.grep(query, options),
        destroy: () => finder.destroy(),
      },
    };
  },
};

/**
 * A finder call failed because its worker is gone (deadline missed, crash or
 * destroyed), not because fff answered with an error. Only this means the
 * index is dead and has to be rebuilt.
 */
export class SearchFinderLostError extends Error {
  override readonly name = "SearchFinderLostError";
}

export const isSearchFinderLost = (cause: unknown): cause is SearchFinderLostError =>
  cause instanceof SearchFinderLostError;

/*
 * Why fff runs in one worker thread.
 *
 * fff's native threads (the scan and the file watcher) hold the picker's lock
 * while they read files, and every call into fff (search, rescan, destroy)
 * waits for that lock. A read that never returns, such as one on an FSKit
 * DeviceFS or a network mount, then blocks the caller forever: on 1.0.170 the
 * idle-TTL `destroy` ran on the event loop thread and the whole service
 * stopped answering HTTP. Skipping destroy while a scan runs would not be
 * enough, since the watcher takes the same lock outside any scan.
 *
 * So fff runs in a worker thread and each call has a deadline, counted from
 * the moment the worker starts the call, so time spent queued behind another
 * index's slow call never counts against it. A call that misses its deadline
 * retires the worker: every pending call fails with SearchFinderLostError and
 * each index rebuilds on a fresh worker the next time it is used. The retired
 * worker is first asked to destroy its finders and exit, which it does as soon
 * as the stuck call returns; if it is still stuck after
 * RETIRED_WORKER_GRACE_MS it is terminated. A thread stuck in a kernel read
 * stays parked, and so do fff's threads waiting on its lock, since nothing can
 * destroy a finder whose lock is held: those finders leak, the price of
 * keeping search alive. The event loop thread only ever
 * posts messages, and fff never runs on it: a worker that cannot load fff
 * fails index creation instead.
 *
 * Every index shares that one worker, and fff is never called from two
 * threads at once. fff-node calls the library through ffi-rs, which keeps its
 * open libraries and resolved symbols in one process-wide HashMap with no lock
 * (`static mut LIBRARY_MAP`), and every call looks its symbol up there, adding
 * it on first use. Two threads calling at once race on that map: with one
 * worker per index, creating and searching six indexes at once crashed the
 * process (SIGSEGV on Linux CI, SIGBUS on macOS) or spun it forever in more
 * than half of local runs, and never with one shared worker. For the same
 * reason a replacement worker starts only after the retired one has exited,
 * or after RETIRED_WORKER_GRACE_MS, once that worker can only be parked
 * inside a native fff call rather than in ffi-rs's own lookup.
 */
export const SEARCH_FINDER_WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
let FileFinder;
try {
  ({ FileFinder } = createRequire(workerData.requireFrom)("@ff-labs/fff-node"));
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "loadFailed", error: String((error && error.message) || error) });
}
const finders = new Map();
const OPERATIONS = new Set([
  "isScanning", "waitForIndexReady", "scanFiles", "fileSearch",
  "directorySearch", "mixedSearch", "grep",
]);
parentPort.on("message", async (message) => {
  const { id, op, handle, args } = message;
  if (op === "shutdown") {
    // Retired: free every index's native threads and watchers, then exit.
    for (const finder of finders.values()) {
      try { finder.destroy(); } catch {}
    }
    finders.clear();
    process.exit(0);
  }
  // The call's deadline starts now, not when it was queued.
  parentPort.postMessage({ type: "start", id });
  try {
    let value;
    if (op === "create") {
      const result = FileFinder.create(args[0]);
      if (result.ok) {
        finders.set(id, result.value);
        value = { ok: true, value: id };
      } else {
        value = result;
      }
    } else if (op === "destroy") {
      const finder = finders.get(handle);
      finders.delete(handle);
      if (finder) finder.destroy();
    } else if (OPERATIONS.has(op)) {
      const finder = finders.get(handle);
      if (!finder) throw new Error("The search index was already destroyed.");
      value = await finder[op](...args);
    } else {
      throw new Error("Unknown search index operation " + op + ".");
    }
    parentPort.postMessage({ type: "reply", id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ type: "reply", id, ok: false, error: String((error && error.message) || error) });
  }
});
`;

/** Deadline for one fff call; a healthy call takes milliseconds. */
export const SEARCH_FINDER_CALL_TIMEOUT_MS = 20_000;

/** How long a worker that could not load fff fails new indexes fast. */
export const SEARCH_FINDER_LOAD_RETRY_MS = 60_000;

/**
 * How long a replacement worker waits for the retired one to exit. A worker
 * still running after this is parked inside a native fff call, so it no
 * longer touches ffi-rs's symbol map.
 */
export const RETIRED_WORKER_GRACE_MS = 2_000;

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly op: string;
  readonly timeoutMs: number;
  /** Set once the worker has started the call. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface WorkerState {
  readonly worker: NodeWorkerThreads.Worker;
  readonly pending: Map<number, PendingCall>;
  /** Resolves once fff is loaded, or with why it was not. */
  readonly loaded: Promise<string | undefined>;
  /** Resolves once the worker thread has exited. */
  readonly exited: Promise<void>;
  /** Indexes created on this worker and not yet destroyed. */
  openIndexes: number;
  alive: boolean;
}

export class SearchFinderWorkerHost {
  #nextId = 1;
  #spawned = 0;
  #loadFailure: { readonly reason: string; readonly until: number } | undefined;
  readonly #callTimeoutMs: number;
  readonly #loadRetryMs: number;
  readonly #retiredGraceMs: number;
  readonly #workerSource: string;
  /** The one worker every index uses, while it is alive. */
  #current: WorkerState | undefined;
  #starting: Promise<WorkerState> | undefined;
  /** Settles when the last retired worker has exited, or its grace ran out. */
  #retiredExit: Promise<void> = Promise.resolve();

  constructor(
    options: {
      readonly callTimeoutMs?: number;
      readonly loadRetryMs?: number;
      readonly retiredWorkerGraceMs?: number;
      readonly workerSource?: string;
    } = {},
  ) {
    this.#callTimeoutMs = options.callTimeoutMs ?? SEARCH_FINDER_CALL_TIMEOUT_MS;
    this.#loadRetryMs = options.loadRetryMs ?? SEARCH_FINDER_LOAD_RETRY_MS;
    this.#retiredGraceMs = options.retiredWorkerGraceMs ?? RETIRED_WORKER_GRACE_MS;
    this.#workerSource = options.workerSource ?? SEARCH_FINDER_WORKER_SOURCE;
  }

  /** Why the last worker could not load fff, while new indexes fail fast for it. */
  get unavailableReason(): string | undefined {
    const failure = this.#loadFailure;
    return failure && Date.now() < failure.until ? failure.reason : undefined;
  }

  /** Live worker threads: 0 or 1, since every index shares one. */
  get workerCount(): number {
    return this.#current?.alive ? 1 : 0;
  }

  /** Workers started so far. */
  get spawnCount(): number {
    return this.#spawned;
  }

  /** Indexes open on the live worker. */
  get openIndexCount(): number {
    return this.#current?.alive ? this.#current.openIndexes : 0;
  }

  /** The live worker, or a new one once the retired one is out of ffi-rs. */
  #acquire(): Promise<WorkerState> {
    const current = this.#current;
    if (current?.alive) return Promise.resolve(current);
    if (this.#starting) return this.#starting;
    const starting = this.#retiredExit.then(() => {
      const state = this.#spawn();
      this.#current = state;
      return state;
    });
    this.#starting = starting;
    const clear = () => {
      if (this.#starting === starting) this.#starting = undefined;
    };
    starting.then(clear, clear);
    return starting;
  }

  #spawn(): WorkerState {
    const pending = new Map<number, PendingCall>();
    let settleLoaded: (failure: string | undefined) => void = () => {};
    const loaded = new Promise<string | undefined>((resolve) => {
      settleLoaded = resolve;
    });
    let settleExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      settleExited = resolve;
    });
    const worker = new NodeWorkerThreads.Worker(this.#workerSource, {
      eval: true,
      workerData: { requireFrom: import.meta.url },
    });
    // Only a worker with calls in flight keeps the process alive, so an idle
    // index never holds up shutdown.
    worker.unref();
    this.#spawned += 1;
    const state: WorkerState = {
      worker,
      pending,
      loaded,
      exited,
      openIndexes: 0,
      alive: true,
    };
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") settleLoaded(undefined);
      else if (message.type === "loadFailed") settleLoaded(message.error);
      else if (message.type === "start") {
        const call = pending.get(message.id);
        if (!call || call.timer !== undefined || !state.alive) return;
        call.timer = setTimeout(
          () =>
            this.#retire(
              state,
              `The search index worker did not answer '${call.op}' within ${call.timeoutMs} ms.`,
            ),
          call.timeoutMs,
        );
        call.timer.unref?.();
      } else {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (call.timer !== undefined) clearTimeout(call.timer);
        if (pending.size === 0) worker.unref();
        if (message.ok) call.resolve(message.value);
        else call.reject(new Error(message.error));
      }
    });
    const fail = (reason: string) => {
      settleLoaded(reason);
      this.#retire(state, reason);
    };
    worker.on("error", (error) => fail(`The search index worker failed: ${error.message}`));
    worker.on("exit", (code) => {
      settleExited();
      fail(`The search index worker exited with code ${code}.`);
    });
    return state;
  }

  /**
   * Fails every pending call of this worker and asks it to destroy its finders
   * and exit. A worker still stuck after the grace period is terminated.
   */
  #retire(state: WorkerState, reason: string) {
    if (!state.alive) return;
    state.alive = false;
    if (this.#current === state) this.#current = undefined;
    for (const call of state.pending.values()) {
      if (call.timer !== undefined) clearTimeout(call.timer);
      call.reject(new SearchFinderLostError(reason));
    }
    state.pending.clear();
    state.worker.unref();
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      state.worker.postMessage({ op: "shutdown" });
    } catch {
      // The worker is already gone.
    }
    // The next worker must not call ffi-rs while this one still can, so it
    // waits for this one to exit, or for the grace period, after which this
    // one is terminated and can only be parked inside a native call.
    const graceMs = this.#retiredGraceMs;
    const previous = this.#retiredExit;
    this.#retiredExit = Promise.all([
      previous,
      Promise.race([
        state.exited,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            void state.worker.terminate().catch(() => undefined);
            resolve();
          }, graceMs).unref?.(),
        ),
      ]),
    ]).then(() => undefined);
  }

  #call(
    state: WorkerState,
    op: string,
    handle: number | undefined,
    args: ReadonlyArray<unknown>,
    timeoutMs = this.#callTimeoutMs,
  ): Promise<unknown> {
    if (!state.alive) {
      return Promise.reject(
        new SearchFinderLostError("The search index worker was stopped; rebuild the index."),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // The deadline starts when the worker reports it has started the call.
      state.pending.set(id, { resolve, reject, op, timeoutMs, timer: undefined });
      if (state.pending.size === 1) state.worker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      state.worker.postMessage({ id, op, handle, args });
    });
  }

  readonly create = async (options: InitOptions): Promise<Result<SearchFinder>> => {
    const unavailable = this.unavailableReason;
    if (unavailable !== undefined) {
      return { ok: false, error: `Workspace search is unavailable: ${unavailable}` };
    }
    let state: WorkerState;
    try {
      state = await this.#acquire();
    } catch (error) {
      return this.#loadFailed(error instanceof Error ? error.message : String(error));
    }
    const loadFailure = await state.loaded;
    if (loadFailure !== undefined) {
      this.#retire(state, loadFailure);
      return this.#loadFailed(loadFailure);
    }
    const created = (await this.#call(state, "create", undefined, [options])) as Result<number>;
    if (!created.ok) return created;
    const handle = created.value;
    state.openIndexes += 1;
    let destroyed = false;
    const call = <A>(op: string, args: ReadonlyArray<unknown>, timeoutMs?: number) =>
      (destroyed
        ? Promise.reject(new SearchFinderLostError("The search index was destroyed."))
        : this.#call(state, op, handle, args, timeoutMs)) as Promise<A>;
    return {
      ok: true,
      value: {
        isScanning: () => call("isScanning", []),
        // fff polls for up to `timeoutMs` itself; the deadline only covers a hang.
        waitForIndexReady: (timeoutMs) =>
          call("waitForIndexReady", [timeoutMs], timeoutMs + this.#callTimeoutMs),
        scanFiles: () => call("scanFiles", []),
        fileSearch: (query, options) => call("fileSearch", [query, options]),
        directorySearch: (query, options) => call("directorySearch", [query, options]),
        mixedSearch: (query, options) => call("mixedSearch", [query, options]),
        grep: (query, options) => call("grep", [query, options]),
        // Fire and forget. The worker stays up for the other indexes; a destroy
        // that waits on a stuck lock retires it at the deadline.
        destroy: () => {
          if (destroyed) return;
          const destroying = call("destroy", []);
          destroyed = true;
          state.openIndexes -= 1;
          void destroying.catch(() => undefined);
        },
      },
    };
  };

  #loadFailed(reason: string): Result<SearchFinder> {
    this.#loadFailure = { reason, until: Date.now() + this.#loadRetryMs };
    return { ok: false, error: `Workspace search is unavailable: ${reason}` };
  }
}

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "loadFailed"; readonly error: string }
  | { readonly type: "start"; readonly id: number }
  | { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "reply"; readonly id: number; readonly ok: false; readonly error: string };

/** fff in one shared worker thread; the production backend. */
export const workerFinderBackend: SearchFinderBackend = new SearchFinderWorkerHost();
