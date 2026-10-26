import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ServiceUpdateBlocker,
} from "@specweave-studio/contracts";
import { presentThreadShell } from "@specweave-studio/client-runtime/state/models";
import { observeProjectThread } from "@specweave-studio/client-runtime/state/projectAttention";
import { classifyProjectActions } from "@specweave-studio/shared/projectAttention";

/** The Needs you reasons a pending request gives: an answer, an approval or a sign-in. */
const PERSON_REASONS: ReadonlySet<string> = new Set(["input", "approval", "signin"]);

/**
 * The threads the live shell shows waiting on the person for a pending request,
 * read the way Needs you and the Threads pane read them: an archived or deleted
 * thread, and one resolved after its request was asked, wait on nobody. Each
 * thread maps to its pending actions' keys, so a new request on the same
 * thread changes the map too.
 */
export function threadsWaitingOnPerson(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyMap<string, string> {
  const waiting = new Map<string, string>();
  for (const thread of threads) {
    if (thread.pendingRuntimeRequest === null) continue;
    const keys = classifyProjectActions(
      observeProjectThread(presentThreadShell(environmentId, thread), "live"),
    )
      .filter((action) => PERSON_REASONS.has(action.reason))
      .map((action) => action.key);
    if (keys.length > 0) waiting.set(thread.id, keys.join("\n"));
  }
  return waiting;
}

/** One string that changes whenever a thread starts or stops waiting on the person. */
export function waitingKey(waiting: ReadonlyMap<string, string> | null): string | null {
  return waiting === null ? null : [...waiting.values()].toSorted().join("\n");
}

/**
 * The service's blockers with every `request` the live shell no longer shows
 * waiting dropped at once: answered, or on a thread resolved or archived. The
 * service is only asked every so often, so without this an answered question
 * stays named until its next look. Without a live shell (`null`) nothing is
 * dropped; a request on no thread cannot be checked and is kept.
 */
export function keepLiveQuestionBlockers(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
  waiting: ReadonlyMap<string, string> | null,
): ReadonlyArray<ServiceUpdateBlocker> {
  if (waiting === null) return blockers;
  const kept = blockers.filter(
    (blocker) =>
      blocker.kind !== "request" || blocker.threadId === null || waiting.has(blocker.threadId),
  );
  return kept.length === blockers.length ? blockers : kept;
}
