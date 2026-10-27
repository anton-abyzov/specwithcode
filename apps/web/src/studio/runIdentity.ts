import type { ModelLabel } from "./shellModel";

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
 * One readable line in place of the resent request, which would otherwise show
 * as a second copy of the user's message: "Claude Code limit reached · continued
 * on Codex · GPT-6.1-Sol".
 */
export function limitContinuationNote(
  message: { readonly id: string; readonly runId?: string | null | undefined },
  runs: readonly Run[],
  describe: (selection: RunSelection) => ModelLabel,
): string | null {
  const kind = limitContinuationKind(message.id);
  if (kind === null) return null;
  const ownIndex = message.runId ? runs.findIndex((run) => run.id === message.runId) : -1;
  const stopped = continuedRun(message.id, runs) ?? (ownIndex > 0 ? runs[ownIndex - 1] : undefined);
  const now = ownIndex >= 0 ? runs[ownIndex]?.modelSelection : undefined;
  const limit = stopped?.modelSelection
    ? `${describe(stopped.modelSelection).provider} limit reached`
    : "Usage limit reached";
  const on = now ? describe(now).full : null;
  switch (kind) {
    case "fallback":
      return on ? `${limit} · continued on ${on}` : `${limit} · continuing on another provider`;
    case "provider-fallback": {
      const failed = stopped?.modelSelection
        ? `${describe(stopped.modelSelection).provider} could not start`
        : "Provider could not start";
      return on ? `${failed} · continued on ${on}` : `${failed} · continuing on another provider`;
    }
    case "reset":
    case "return":
      return on ? `Usage limit reset · continued on ${on}` : "Usage limit reset · continued";
    case "credits":
      return `${limit} · continued${on ? ` on ${on}` : ""} with banked credits`;
    case "api":
      return `${limit} · continued${on ? ` on ${on}` : ""} with API credits`;
  }
}

/**
 * The server continues a turn cut off by a restart under a message whose id
 * names why it stopped: `message:update-continuation:<run>` for a service
 * update, `message:restart-continuation:<run>` for any other restart.
 */
const RESTART_CONTINUATION = /^message:(update|restart)-continuation:/;

/** One quiet line in place of the automatic "Continue where you left off." */
export function restartContinuationNote(message: { readonly id: string }): string | null {
  const kind = RESTART_CONTINUATION.exec(message.id)?.[1];
  if (kind === undefined) return null;
  return kind === "update" ? "Resumed after update" : "Resumed after restart";
}

/**
 * The server sends `/compact` on its own before an idle thread's prompt cache
 * lapses (`message:idle-compact:<thread>:<time>`) and when a request
 * overflowed the context (`context-compact:<thread>:<run>`).
 */
export function automaticCompactionNote(message: {
  readonly id: string;
  readonly createdBy?: string;
}): string | null {
  if (message.createdBy !== "system") return null;
  if (message.id.startsWith("message:idle-compact:")) {
    return "Compacting automatically before the idle thread's prompt cache expires";
  }
  if (message.id.startsWith("context-compact:")) {
    return "Compacting automatically because the context was full";
  }
  return null;
}

export { limitFallbackPairing } from "@specweave-studio/shared/threadModelIdentity";
