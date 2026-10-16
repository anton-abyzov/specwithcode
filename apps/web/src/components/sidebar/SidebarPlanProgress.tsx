/**
 * "3/5" for sidebar rows. Rows read their SpecWeave increment with one query
 * per project rather than per row, for the newest threads up to the query's
 * limit; every row falls back to the agent's todo list on the thread shell.
 */
import {
  THREAD_INCREMENT_PROGRESS_MAX_THREADS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/models";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { compactThreadPlan, type ThreadPlanCompact } from "../../studio/threadPlanProgress";
import { useThreadIncrementProgress } from "../../studio/useThreadIncrementProgress";

const IncrementProgressLoader = memo(function IncrementProgressLoader(props: {
  groupKey: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadIds: ReadonlyArray<ThreadId>;
  activityKey: string;
  onChange: (groupKey: string, progress: ReadonlyMap<string, ThreadIncrementProgress>) => void;
}) {
  const progress = useThreadIncrementProgress(props);
  const { groupKey, onChange } = props;
  useEffect(() => onChange(groupKey, progress), [groupKey, onChange, progress]);
  return null;
});

export function useSidebarThreadPlans(allThreads: ReadonlyArray<EnvironmentThreadShell>): {
  plans: ReadonlyMap<string, ThreadPlanCompact>;
  loaders: ReactNode;
} {
  const groups = useMemo(() => {
    const byProject = new Map<string, EnvironmentThreadShell[]>();
    const newestFirst = allThreads.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    for (const thread of newestFirst) {
      if (thread.archivedAt !== null) continue;
      const key = `${thread.environmentId}\u0000${thread.projectId}`;
      const threads = byProject.get(key) ?? [];
      if (threads.length < THREAD_INCREMENT_PROGRESS_MAX_THREADS) threads.push(thread);
      byProject.set(key, threads);
    }
    return [...byProject].map(([key, threads]) => ({
      key,
      environmentId: threads[0]!.environmentId,
      projectId: threads[0]!.projectId,
      threadIds: threads.map((thread) => thread.id),
      activityKey: threads.reduce(
        (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
        "",
      ),
    }));
  }, [allThreads]);

  const [progressByGroup, setProgressByGroup] = useState(
    () => new Map<string, ReadonlyMap<string, ThreadIncrementProgress>>(),
  );
  const onChange = useCallback(
    (groupKey: string, progress: ReadonlyMap<string, ThreadIncrementProgress>) =>
      setProgressByGroup((current) =>
        current.get(groupKey) === progress ? current : new Map(current).set(groupKey, progress),
      ),
    [],
  );

  const plans = useMemo(() => {
    const result = new Map<string, ThreadPlanCompact>();
    for (const thread of allThreads) {
      const increment =
        progressByGroup.get(`${thread.environmentId}\u0000${thread.projectId}`)?.get(thread.id) ??
        null;
      const plan = compactThreadPlan(increment, thread.planProgress ?? null);
      if (plan !== null) {
        result.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), plan);
      }
    }
    return result;
  }, [allThreads, progressByGroup]);

  const loaders = groups.map((group) => (
    <IncrementProgressLoader
      key={group.key}
      groupKey={group.key}
      environmentId={group.environmentId}
      projectId={group.projectId}
      threadIds={group.threadIds}
      activityKey={group.activityKey}
      onChange={onChange}
    />
  ));
  return { plans, loaders };
}
