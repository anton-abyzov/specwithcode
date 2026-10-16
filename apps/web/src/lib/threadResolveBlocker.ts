import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/models";

import type { ThreadShell } from "../types";

type ResolveBlockerShell = Pick<ThreadShell, "title" | "runtime" | "hasPendingApprovals">;

function elapsedLabel(startedAt: string | null | undefined, nowMs: number): string | null {
  if (startedAt == null) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started) || nowMs < started) return null;
  const minutes = Math.floor((nowMs - started) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * What still runs in a thread and keeps Resolve from settling it, in words the
 * user can act on. Null when nothing blocks. Pending questions the agent asked
 * by message are not listed: Resolve dismisses those itself.
 */
export function describeThreadResolveBlocker(
  thread: ResolveBlockerShell,
  nowMs: number,
): string | null {
  const parts: string[] = [];
  const runtime = thread.runtime;
  if (threadRuntimeIsActive(runtime)) {
    if (runtime?.status === "running") {
      const elapsed = elapsedLabel(runtime.activityStartedAt, nowMs);
      parts.push(
        elapsed === null ? "a turn is still running" : `a turn has been running for ${elapsed}`,
      );
    } else if (runtime?.status === "waiting") {
      parts.push("a turn is waiting on background work");
    } else {
      parts.push("a turn is about to start");
    }
  }
  if (thread.hasPendingApprovals) parts.push("an approval is waiting for you");
  if (parts.length === 0) return null;
  const sentence = parts.join(" and ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function threadStopAndResolveMessage(thread: ResolveBlockerShell, blocker: string): string {
  const title = thread.title.trim().length > 0 ? thread.title.trim() : "this thread";
  return [
    `Stop and resolve "${title}"?`,
    "",
    `${blocker}.`,
    "Stopping ends that work. Everything it already posted stays in the thread.",
  ].join("\n");
}
