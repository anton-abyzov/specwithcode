/**
 * The SpecWeave increment progress of some threads of one project, keyed by
 * thread id. The ledger changes outside Studio's events, so the answer is
 * refreshed on a slow timer while the page is visible and after one of the
 * threads moves (an agent turn is when tasks get claimed and done), at most
 * once per timer period and never while a read is still in flight.
 */
import {
  AuthFilesystemReadScope,
  THREAD_INCREMENT_PROGRESS_MAX_THREADS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { projectWorkspace } from "./projectWorkspace";

const REFRESH_MS = 15_000;

/** Bumped after every hand-made link change, so increment progress queries read again. */
export const incrementLinkRevisionAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("plan-progress:link-revision"),
);
const EMPTY = new Map<string, ThreadIncrementProgress>();
const NO_THREADS: ReadonlySet<string> = new Set();

/** What one progress query says about its threads. */
export interface ThreadIncrementState {
  /** The increment each bound thread works on, by thread id. */
  readonly progress: ReadonlyMap<string, ThreadIncrementProgress>;
  /** Threads that changed code with no increment, small fix or "No increment needed". */
  readonly unplanned: ReadonlySet<string>;
}
const EMPTY_STATE: ThreadIncrementState = { progress: EMPTY, unplanned: NO_THREADS };

/**
 * When to refresh one progress query. A busy thread moves many times a
 * minute, and each refresh used to restart the read in flight, so the server
 * never finished one. Thread activity now waits for the trailing edge of the
 * refresh period; a hand-made link refreshes as soon as no read is in flight.
 */
export function makeProgressRefreshGate(options: {
  readonly refresh: () => void;
  readonly periodMs?: number;
  readonly now?: () => number;
}) {
  const periodMs = options.periodMs ?? REFRESH_MS;
  const now = options.now ?? Date.now;
  // The query reads once on mount.
  let lastRefreshAt = now();
  let pending = false;
  let wanted: "none" | "after-period" | "now" = "none";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    lastRefreshAt = now();
    wanted = "none";
    options.refresh();
  };
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (wanted === "none" || pending) return;
    const wait = wanted === "now" ? 0 : lastRefreshAt + periodMs - now();
    if (wait > 0) timer = setTimeout(flush, wait);
    else run();
  };

  return {
    /** One of the threads moved. */
    activity: () => {
      if (wanted === "none") wanted = "after-period";
      flush();
    },
    /** A link was made by hand. */
    linkChanged: () => {
      wanted = "now";
      flush();
    },
    /** The slow timer fired while the page is visible. */
    tick: () => {
      if (!pending) run();
    },
    /** Whether the query is reading; a refresh owed meanwhile runs when it settles. */
    setPending: (next: boolean) => {
      pending = next;
      flush();
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

interface ThreadIncrementQueryInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Changes when any of the threads moves, such as their newest updatedAt. */
  readonly activityKey?: string | null;
}

export function useThreadIncrementProgress(
  input: ThreadIncrementQueryInput,
): ReadonlyMap<string, ThreadIncrementProgress> {
  return useThreadIncrementState(input).progress;
}

/** The progress of the threads, and which of them changed code without a plan. */
export function useThreadIncrementState(input: ThreadIncrementQueryInput): ThreadIncrementState {
  const canRead = useEnvironmentScope(input.environmentId, AuthFilesystemReadScope);
  const threadIds = useMemo(
    () => [...new Set(input.threadIds)].toSorted().slice(0, THREAD_INCREMENT_PROGRESS_MAX_THREADS),
    [input.threadIds],
  );
  const idsKey = threadIds.join(",");
  const atom = useMemo(
    () =>
      canRead && input.environmentId !== null && input.projectId !== null && threadIds.length > 0
        ? projectWorkspace.threadIncrementProgress({
            environmentId: input.environmentId,
            input: { projectId: input.projectId, threadIds },
          })
        : null,
    // Keyed by the joined ids, so a new array with the same ids keeps the query.
    [canRead, input.environmentId, input.projectId, idsKey],
  );
  const query = useEnvironmentQuery(atom);
  const { refresh, isPending } = query;
  const gate = useMemo(
    () => (atom === null ? null : makeProgressRefreshGate({ refresh })),
    [atom, refresh],
  );
  useEffect(() => () => gate?.dispose(), [gate]);
  useEffect(() => gate?.setPending(isPending), [gate, isPending]);

  useEffect(() => {
    if (gate === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") gate.tick();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [gate]);

  // Only a change in activity or in a hand-made link refreshes; the first read happens on mount.
  const linkRevision = useAtomValue(incrementLinkRevisionAtom);
  const activityKey = input.activityKey ?? "";
  const lastSeen = useRef({ activityKey, linkRevision });
  useEffect(() => {
    const previous = lastSeen.current;
    lastSeen.current = { activityKey, linkRevision };
    if (gate === null) return;
    if (previous.linkRevision !== linkRevision) gate.linkChanged();
    else if (previous.activityKey !== activityKey) gate.activity();
  }, [gate, activityKey, linkRevision]);

  return useMemo(() => {
    const threads = query.data?.threads ?? [];
    const unplanned = query.data?.unplanned ?? [];
    if (threads.length === 0 && unplanned.length === 0) return EMPTY_STATE;
    return {
      progress:
        threads.length === 0 ? EMPTY : new Map(threads.map((entry) => [entry.threadId, entry])),
      unplanned: unplanned.length === 0 ? NO_THREADS : new Set<string>(unplanned),
    };
  }, [query.data]);
}

/**
 * Increment progress for a project's thread list: the threads on the
 * project's own machine, newest first, up to the query's limit.
 */
export function useProjectThreadIncrementProgress(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  }>,
): ThreadIncrementState {
  const local = useMemo(
    () =>
      threads
        .filter((thread) => thread.environmentId === environmentId && thread.archivedAt === null)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, THREAD_INCREMENT_PROGRESS_MAX_THREADS),
    [environmentId, threads],
  );
  return useThreadIncrementState({
    environmentId,
    projectId: local[0]?.projectId ?? null,
    threadIds: local.map((thread) => thread.id),
    activityKey: local[0]?.updatedAt ?? null,
  });
}
