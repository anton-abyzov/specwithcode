import type { ModelLabel } from "./shellModel";

type RunSelection = { readonly instanceId: string; readonly model: string };
type Run = { readonly id: string; readonly modelSelection?: RunSelection | undefined };

/**
 * The usage-limit rule continues a stopped run under a server message whose id
 * names the rule and the run it continues: `limit-fallback:<thread>:<run>`.
 */
const LIMIT_CONTINUATION = /^limit-(fallback|reset|credits|api):/;

export type LimitContinuationKind = "fallback" | "reset" | "credits" | "api";

export function limitContinuationKind(messageId: string): LimitContinuationKind | null {
  return (LIMIT_CONTINUATION.exec(messageId)?.[1] as LimitContinuationKind | undefined) ?? null;
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
  const stoppedId = message.id.slice(message.id.lastIndexOf(":") + 1);
  const ownIndex = message.runId ? runs.findIndex((run) => run.id === message.runId) : -1;
  const stopped =
    runs.find((run) => run.id === stoppedId) ?? (ownIndex > 0 ? runs[ownIndex - 1] : undefined);
  const now = ownIndex >= 0 ? runs[ownIndex]?.modelSelection : undefined;
  const limit = stopped?.modelSelection
    ? `${describe(stopped.modelSelection).provider} limit reached`
    : "Usage limit reached";
  const on = now ? describe(now).full : null;
  switch (kind) {
    case "fallback":
      return on ? `${limit} · continued on ${on}` : `${limit} · continuing on another provider`;
    case "reset":
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
