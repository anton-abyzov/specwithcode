/**
 * The SpecWeave increment progress of some threads of one project, keyed by
 * thread id. The ledger changes outside Studio's events, so the answer is
 * refreshed on a slow timer while the page is visible and whenever one of the
 * threads moves (an agent turn is when tasks get claimed and done).
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

export function useThreadIncrementProgress(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Changes when any of the threads moves, such as their newest updatedAt. */
  readonly activityKey?: string | null;
}): ReadonlyMap<string, ThreadIncrementProgress> {
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
  const { refresh } = query;

  useEffect(() => {
    if (atom === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [atom, refresh]);

  // Only a change in activity or in a hand-made link refreshes; the first read happens on mount.
  const linkRevision = useAtomValue(incrementLinkRevisionAtom);
  const activityKey = `${input.activityKey ?? ""}\u0000${linkRevision}`;
  const lastActivity = useRef(activityKey);
  useEffect(() => {
    if (lastActivity.current === activityKey) return;
    lastActivity.current = activityKey;
    if (atom !== null) refresh();
  }, [atom, activityKey, refresh]);

  return useMemo(() => {
    const threads = query.data?.threads;
    if (!threads || threads.length === 0) return EMPTY;
    return new Map(threads.map((entry) => [entry.threadId, entry]));
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
): ReadonlyMap<string, ThreadIncrementProgress> {
  const local = useMemo(
    () =>
      threads
        .filter((thread) => thread.environmentId === environmentId && thread.archivedAt === null)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, THREAD_INCREMENT_PROGRESS_MAX_THREADS),
    [environmentId, threads],
  );
  return useThreadIncrementProgress({
    environmentId,
    projectId: local[0]?.projectId ?? null,
    threadIds: local.map((thread) => thread.id),
    activityKey: local[0]?.updatedAt ?? null,
  });
}
