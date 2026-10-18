/**
 * "Resolve conflicts" for a thread whose own pull request conflicts with its base branch. The
 * request goes to that thread, the way Claude Code steers the session that opened a pull
 * request: its agent has the branch checked out and knows why each change was made. A queued
 * message never interrupts a run in progress; it starts as soon as the thread is free.
 *
 * Which host read each request answered is remembered here, so the button stays hidden until
 * a newer read: the push that resolves the conflicts takes a sync to show, and a second press
 * in between would queue the same work twice.
 */
import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import { isAtomCommandInterrupted } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { buildResolveConflictsInThreadPrompt } from "../components/pullRequest/pullRequestDetail.logic";
import { toastManager } from "../components/ui/toast";
import { newMessageId } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import type { ThreadCardConflict } from "./projectThreadCards";

const requested = new Map<string, string>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function setRequest(key: string, syncedAt: string | null) {
  if (syncedAt === null) requested.delete(key);
  else requested.set(key, syncedAt);
  for (const listener of listeners) listener();
}

/** The host read the thread's last Resolve conflicts request answered, or null. */
export function resolveConflictsRequestedFor(ref: ScopedThreadRef): string | null {
  return requested.get(scopedThreadKey(ref)) ?? null;
}

export function useResolveConflictsRequestedFor(ref: ScopedThreadRef): string | null {
  const key = scopedThreadKey(ref);
  return useSyncExternalStore(subscribe, () => requested.get(key) ?? null);
}

type ResolveThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "runtimeMode" | "interactionMode"
>;

export interface ResolveConflictsTarget {
  readonly number: number;
  readonly url: string;
  readonly conflict: Pick<ThreadCardConflict, "headBranch" | "baseBranch"> & {
    readonly syncedAt?: string | undefined;
  };
}

/** Sends the thread its Resolve conflicts request; resolves to whether it was accepted. */
export function useResolveThreadConflicts(): (
  thread: ResolveThread,
  target: ResolveConflictsTarget,
) => Promise<boolean> {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  return useCallback(
    async (thread, target) => {
      const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
      const previous = requested.get(key) ?? null;
      if (target.conflict.syncedAt !== undefined) setRequest(key, target.conflict.syncedAt);
      const result = await startTurn({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildResolveConflictsInThreadPrompt({
              number: target.number,
              url: target.url,
              headBranch: target.conflict.headBranch,
              baseBranch: target.conflict.baseBranch,
            }),
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          dispatchMode: "queue",
        },
      });
      if (result._tag !== "Failure") {
        toastManager.add({
          type: "success",
          title: `Asked the thread to resolve the conflicts on #${target.number}`,
        });
        return true;
      }
      setRequest(key, previous);
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not send the request to resolve #${target.number}`,
        });
      }
      return false;
    },
    [startTurn],
  );
}
