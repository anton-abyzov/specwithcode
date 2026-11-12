// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - one file watch and one debounce timer per indexed root, outside Effect.
import * as NodeFS from "node:fs";

/*
 * Why the service refreshes the search index itself.
 *
 * fff's own watcher handles every file event as it arrives and asks libgit2
 * for the status of the changed paths each time, which re-reads and re-hashes
 * the whole `.git/index`. In a large repository with agents writing files
 * that kept a native thread busy all the time, with nothing searching. So the
 * finder is created with `disableWatch` and the service drives it instead:
 * one recursive watch per root, events under folders that never change search
 * results dropped, and the rest collapsed into at most one rescan per floor
 * interval. With no file events there is no work at all.
 */

/** Wait this long after the last change before rescanning. */
export const SEARCH_REFRESH_DEBOUNCE_MS = 2_000;

/** Shortest time between the end of one rescan and the start of the next. */
export const SEARCH_REFRESH_FLOOR_MS = 10_000;

/**
 * A rescan that took long holds the next one back by this many times its own
 * duration, so rescans of a very large tree stay a small share of a core.
 */
export const SEARCH_REFRESH_DURATION_FACTOR = 20;

/** Changes below a folder with one of these names never refresh the index. */
const IGNORED_ANYWHERE = new Set([".git", "node_modules"]);

/** Scratch and evidence folders at the top of the root: agent output, not sources. */
const IGNORED_AT_ROOT = new Set(["scratch", ".artifacts"]);

/**
 * Whether a change at `relativePath` (relative to the indexed root, either
 * separator) is dropped. Nested repositories outside these folders are project
 * sources and refresh the index like any other folder.
 */
export function isIgnoredSearchEvent(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  // The last segment is the changed entry itself: a file may carry any name,
  // but a change to an ignored folder as a whole is dropped too.
  return IGNORED_AT_ROOT.has(segments[0]!) || segments.some((s) => IGNORED_ANYWHERE.has(s));
}

export interface SearchRefreshClock {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const systemClock: SearchRefreshClock = {
  now: () => Date.now(),
  setTimeout: (run, delayMs) => {
    const handle = setTimeout(run, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SearchRefreshOptions {
  /** Rescans the index; a rejection is dropped, the next change tries again. */
  readonly rescan: () => Promise<unknown>;
  readonly clock?: SearchRefreshClock;
  readonly debounceMs?: number;
  readonly floorMs?: number;
}

export interface SearchRefresh {
  /** A file changed; `relativePath` is null when the watcher could not name it. */
  readonly notify: (relativePath: string | null) => void;
  /** Stops scheduling. A rescan already running finishes on its own. */
  readonly dispose: () => void;
}

/**
 * Collapses file changes into rescans: one starts `debounceMs` after the last
 * change, or `floorMs` after the first one still waiting when changes never
 * pause, and never sooner than the floor after the previous rescan ended.
 */
export function makeSearchRefresh(options: SearchRefreshOptions): SearchRefresh {
  const clock = options.clock ?? systemClock;
  const debounceMs = options.debounceMs ?? SEARCH_REFRESH_DEBOUNCE_MS;
  const floorMs = options.floorMs ?? SEARCH_REFRESH_FLOOR_MS;
  let disposed = false;
  let running = false;
  let timer: unknown;
  let firstPendingAt: number | undefined;
  let lastChangeAt = 0;
  let notBefore = Number.NEGATIVE_INFINITY;

  const arm = () => {
    if (disposed || running || firstPendingAt === undefined) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    const due = Math.max(Math.min(lastChangeAt + debounceMs, firstPendingAt + floorMs), notBefore);
    timer = clock.setTimeout(fire, Math.max(0, due - clock.now()));
  };

  const fire = () => {
    timer = undefined;
    if (disposed || running || firstPendingAt === undefined) return;
    firstPendingAt = undefined;
    running = true;
    const startedAt = clock.now();
    const finish = () => {
      running = false;
      const endedAt = clock.now();
      notBefore =
        endedAt + Math.max(floorMs, (endedAt - startedAt) * SEARCH_REFRESH_DURATION_FACTOR);
      // Changes that arrived during the rescan may have been missed by it.
      arm();
    };
    let rescan: Promise<unknown>;
    try {
      rescan = options.rescan();
    } catch {
      finish();
      return;
    }
    rescan.then(finish, finish);
  };

  return {
    notify: (relativePath) => {
      if (disposed) return;
      if (relativePath !== null && isIgnoredSearchEvent(relativePath)) return;
      lastChangeAt = clock.now();
      firstPendingAt ??= lastChangeAt;
      arm();
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Starts watching a root; returns how to stop. */
export type SearchRootWatch = (
  root: string,
  onChange: (relativePath: string | null) => void,
) => () => void;

/**
 * Node's recursive watch is one native stream per root on macOS and Windows.
 * On Linux Node emulates it with one inotify watch per folder, node_modules
 * included, so there fff keeps its own watcher.
 */
export const hasNativeRecursiveWatch = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "win32";

interface SharedWatch {
  readonly watcher: NodeFS.FSWatcher;
  readonly listeners: Set<(relativePath: string | null) => void>;
}

const sharedWatches = new Map<string, SharedWatch>();

/**
 * One recursive watch per root, shared by every index of that root (paths and
 * content). A root that cannot be watched gets no automatic refresh; explicit
 * refreshes still work.
 */
export const watchSearchRoot: SearchRootWatch = (root, onChange) => {
  let shared = sharedWatches.get(root);
  if (shared === undefined) {
    const listeners = new Set<(relativePath: string | null) => void>();
    let watcher: NodeFS.FSWatcher;
    try {
      watcher = NodeFS.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        const relativePath = typeof filename === "string" ? filename : null;
        for (const listener of listeners) listener(relativePath);
      });
    } catch {
      return () => undefined;
    }
    const created: SharedWatch = { watcher, listeners };
    watcher.on("error", () => {
      if (sharedWatches.get(root) === created) sharedWatches.delete(root);
      watcher.close();
    });
    sharedWatches.set(root, created);
    shared = created;
  }
  const current = shared;
  current.listeners.add(onChange);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    current.listeners.delete(onChange);
    if (current.listeners.size > 0) return;
    if (sharedWatches.get(root) === current) sharedWatches.delete(root);
    current.watcher.close();
  };
};

/** Roots watched right now. */
export const watchedSearchRootCount = (): number => sharedWatches.size;
