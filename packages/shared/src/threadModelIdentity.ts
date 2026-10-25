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

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` are one model; the bracket names a variant. */
export function baseModelSlug(model: string): string {
  const bracket = model.indexOf("[");
  return bracket > 0 ? model.slice(0, bracket) : model;
}

/** Same provider instance and the same model, whatever variant the provider reports. */
export function sameRunModel(a: RunSelection, b: RunSelection): boolean {
  return a.instanceId === b.instanceId && baseModelSlug(a.model) === baseModelSlug(b.model);
}

/**
 * The thread runs on a limit fallback: the last usage-limit continuation moved
 * it off `original`, to another provider or to another model on the same one
 * (a fallback order of GPT-6.1-Sol, then GPT-6-Astra), and no later run has gone back. Null once a run returns to
 * the original provider or the thread's next turn is set there, and after a
 * move off a provider that could not start, which has nothing to go back to.
 * Without such a continuation, a thread that started on a stand-in
 * (`launchFallbackFrom`) pairs with that model until a run goes there or the
 * thread's next turn is set there (see launchFallbackPairing).
 */
export function limitFallbackPairing(
  messages: ReadonlyArray<{ readonly id: string; readonly runId?: string | null | undefined }>,
  runs: readonly Run[],
  current: RunSelection,
  launchFallbackFrom?: RunSelection | null,
): {
  readonly original: RunSelection;
  readonly stoppedRunId: string;
  readonly launched?: true;
} | null {
  return (
    limitContinuationPairing(messages, runs, current) ??
    launchFallbackPairing(launchFallbackFrom, runs, current)
  );
}

/**
 * What a thread keeps of `launchFallbackFrom` when its model selection moves
 * from `from` to `to`. A move by the server (a usage pre-switch, a limit
 * fallback or way back, a move off a provider that could not start) keeps it;
 * a pick of another model by the user or an agent ends the stand-in for good,
 * so picking the launch model back later does not bring it back.
 */
export function launchFallbackAfterMove<T extends RunSelection>(
  launchFallbackFrom: T | null | undefined,
  from: RunSelection,
  to: RunSelection,
  byServer: boolean,
): T | null | undefined {
  if (launchFallbackFrom == null || byServer || sameRunModel(from, to)) return launchFallbackFrom;
  return null;
}

/**
 * A thread whose launch moved off `launchFallbackFrom` for lack of room stands
 * in for it while it is not set on the original and no run of the thread has
 * gone there. A pick of another model by hand clears the field at write time
 * (see launchFallbackAfterMove); a server move away and back keeps it.
 * The shell SQL in ProjectionStore mirrors this rule.
 */
function launchFallbackPairing(
  launchFallbackFrom: RunSelection | null | undefined,
  runs: readonly Run[],
  current: RunSelection,
): {
  readonly original: RunSelection;
  readonly stoppedRunId: string;
  readonly launched: true;
} | null {
  if (launchFallbackFrom == null || sameRunModel(current, launchFallbackFrom)) return null;
  const returned = runs.some(
    (run) =>
      run.modelSelection !== undefined && sameRunModel(run.modelSelection, launchFallbackFrom),
  );
  return returned
    ? null
    : {
        original: launchFallbackFrom,
        stoppedRunId: `launch:${launchFallbackFrom.instanceId}:${launchFallbackFrom.model}`,
        launched: true,
      };
}

function limitContinuationPairing(
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
  if (stopped === undefined || original === undefined || sameRunModel(current, original))
    return null;
  const stoppedRunId = stopped.id;
  const ownIndex = continuation.runId ? runs.findIndex((run) => run.id === continuation.runId) : -1;
  const returned = runs
    .slice(ownIndex >= 0 ? ownIndex + 1 : runs.length)
    .some((run) => run.modelSelection !== undefined && sameRunModel(run.modelSelection, original));
  return returned ? null : { original, stoppedRunId };
}

/** Compact authoritative display, independent of local composer drafts. */
export function threadModelIdentity(input: {
  thread: ModelSelection;
  running?: ModelSelection | null;
  fallbackFrom?: ModelSelection | null;
  /** The fallback dates from the thread's launch, not a usage-limit stop. */
  launched?: boolean;
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
    ...(preferred !== null && input.fallbackFrom && input.launched ? { launched: true } : {}),
  };
}
