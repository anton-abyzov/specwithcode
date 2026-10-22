import type { ModelSelection } from "@specweave-studio/contracts";

type RunSelection = { readonly instanceId: string; readonly model: string };
type Run = { readonly id: string; readonly modelSelection?: RunSelection | undefined };

/**
 * The usage-limit rule continues a stopped run under a server message whose id
 * names the rule and ends with the run it continues: `limit-fallback:<thread>:<run>`,
 * or `limit-fallback:<thread>:hop-N:<run>` after a fallback could not open.
 * `limit-return:` goes home after the reset; `provider-fallback:` moves off a
 * provider that could not start, which is no limit.
 */
const LIMIT_CONTINUATION = /^(?:limit-(fallback|reset|credits|api|return)|(provider-fallback)):/;

export type LimitContinuationKind =
  | "fallback"
  | "reset"
  | "credits"
  | "api"
  | "return"
  | "provider-fallback";

export function limitContinuationKind(messageId: string): LimitContinuationKind | null {
  const match = LIMIT_CONTINUATION.exec(messageId);
  return ((match?.[1] ?? match?.[2]) as LimitContinuationKind | undefined) ?? null;
}

/** The run a continuation's id ends with; run ids hold colons, so the longest match wins. */
function continuedRun<R extends Run>(messageId: string, runs: readonly R[]): R | undefined {
  let found: R | undefined;
  for (const run of runs)
    if (messageId.endsWith(`:${run.id}`) && run.id.length > (found?.id.length ?? -1)) found = run;
  return found;
}

/**
 * The thread runs on a limit fallback: the last usage-limit continuation moved
 * it off `original`, and no later run has gone back. Null once a run returns to
 * the original provider or the thread's next turn is set there, and after a
 * move off a provider that could not start, which has nothing to go back to.
 */
export function limitFallbackPairing(
  messages: ReadonlyArray<{ readonly id: string; readonly runId?: string | null | undefined }>,
  runs: readonly Run[],
  current: RunSelection,
): { readonly original: RunSelection; readonly stoppedRunId: string } | null {
  const continuation = messages.findLast((message) => {
    const kind = limitContinuationKind(message.id);
    return kind === "fallback" || kind === "provider-fallback";
  });
  if (continuation === undefined || limitContinuationKind(continuation.id) !== "fallback")
    return null;
  const stopped = continuedRun(continuation.id, runs);
  const original = stopped?.modelSelection;
  if (stopped === undefined || original === undefined || current.instanceId === original.instanceId)
    return null;
  const stoppedRunId = stopped.id;
  const ownIndex = continuation.runId ? runs.findIndex((run) => run.id === continuation.runId) : -1;
  const returned = runs
    .slice(ownIndex >= 0 ? ownIndex + 1 : runs.length)
    .some((run) => run.modelSelection?.instanceId === original.instanceId);
  return returned ? null : { original, stoppedRunId };
}

/** Compact authoritative display, independent of local composer drafts. */
export function threadModelIdentity(input: {
  thread: ModelSelection;
  running?: ModelSelection | null;
  fallbackFrom?: ModelSelection | null;
}) {
  const current = input.running ?? input.thread;
  const same = (a: RunSelection, b: RunSelection) =>
    a.instanceId === b.instanceId && a.model === b.model;
  const preferred =
    input.fallbackFrom && !same(current, input.fallbackFrom)
      ? input.fallbackFrom
      : !same(current, input.thread)
        ? input.thread
        : null;
  return {
    current,
    preferred,
    kind:
      preferred === null ? null : input.fallbackFrom ? ("fallback" as const) : ("running" as const),
  };
}
