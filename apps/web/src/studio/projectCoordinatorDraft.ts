import { useEffect } from "react";

interface ProjectDraftTarget {
  readonly environmentId: string;
  readonly projectId: string;
}
const queues = new Map<string, string[]>();
const listeners = new Map<string, Set<() => void>>();
const keyFor = (target: ProjectDraftTarget) =>
  JSON.stringify([target.environmentId, target.projectId]);

/** Stage a request until its exact project checkout mounts. Never starts a turn. */
export function enqueueProjectCoordinatorDraft(
  input: ProjectDraftTarget & { readonly text: string },
): void {
  if (!input.text.trim()) return;
  const key = keyFor(input);
  queues.set(key, [...(queues.get(key) ?? []), input.text]);
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Consume once into the existing composer; StrictMode remounts cannot duplicate the request. */
export function useProjectCoordinatorDraft(
  environmentId: string,
  projectId: string,
  onPrefill: (text: string) => void,
): void {
  useEffect(() => {
    const key = keyFor({ environmentId, projectId });
    const drain = () => {
      const pending = queues.get(key);
      if (!pending?.length) return;
      queues.delete(key);
      onPrefill(pending.join("\n\n"));
    };
    const subscribers = listeners.get(key) ?? new Set<() => void>();
    subscribers.add(drain);
    listeners.set(key, subscribers);
    drain();
    return () => {
      subscribers.delete(drain);
      if (!subscribers.size) listeners.delete(key);
    };
  }, [environmentId, projectId, onPrefill]);
}

/** Workspace intent is context for the coordinator, never a checkout mutation. */
export function projectWorkspaceIntentText(input: {
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}): string {
  return [
    input.branch ? `Use branch: ${input.branch}` : null,
    input.worktreePath ? `Use the existing worktree: ${input.worktreePath}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}
