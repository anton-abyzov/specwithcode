import type { ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";

import * as McpProviderSession from "./McpProviderSession.ts";

/**
 * Whether an agent running inside a SpecWithCode thread may still change
 * things through its MCP credential, and if not, what it should do instead.
 *
 * The credential alone proves which thread and provider instance the caller
 * belongs to; it is revoked when that provider session is released and
 * retired when the thread is archived or deleted. On top of that, a change
 * needs the caller to be the provider that runs the thread now:
 *
 * - while a turn is live, the provider instance running that turn;
 * - between turns, the thread's own provider instance, through the session
 *   that is attached for it in this server. A provider's own background
 *   agents and workflows (Claude Code's background Agent and Workflow tools,
 *   Codex subagents) keep working after the turn that started them ended,
 *   and their calls are the thread's work like any other.
 *
 * A provider the thread switched away from, or a credential no session in
 * this server holds (restored after a restart, or left by a released
 * session), can still read but changes nothing. Nor does anything a stopped
 * turn left running (see `afterStop`): Stop holds the thread until its next
 * message.
 */
export interface CallerLivenessInput {
  readonly thread: {
    readonly id: ThreadId;
    readonly archivedAt: unknown;
    /** The provider instance the thread runs on. */
    readonly providerInstanceId: ProviderInstanceId;
  };
  /** The provider instance running the thread's live turn; undefined between turns. */
  readonly activeTurnProviderInstanceId: ProviderInstanceId | undefined;
  readonly caller: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly providerInstanceId: ProviderInstanceId;
  };
}

export type CallerLiveness =
  | { readonly live: true; readonly turn: "active" | "between_turns" }
  | { readonly live: false; readonly message: string };

export function callerLiveness(input: CallerLivenessInput): CallerLiveness {
  const { thread, caller } = input;
  if (thread.archivedAt !== null && thread.archivedAt !== undefined) {
    return {
      live: false,
      message: `Thread ${thread.id} is archived, so this agent can only read. Restore the thread to change anything from it.`,
    };
  }
  const activeInstance = input.activeTurnProviderInstanceId;
  if (activeInstance !== undefined) {
    return activeInstance === caller.providerInstanceId
      ? { live: true, turn: "active" }
      : {
          live: false,
          message: `Thread ${thread.id}'s current turn runs on ${activeInstance}, and this MCP session belongs to ${caller.providerInstanceId}, a provider the thread no longer runs on. It can still read, but only ${activeInstance} can change things for this thread now. Retrying here will not help.`,
        };
  }
  if (thread.providerInstanceId !== caller.providerInstanceId) {
    return {
      live: false,
      message: `Thread ${thread.id} now runs on ${thread.providerInstanceId}, and this MCP session belongs to ${caller.providerInstanceId}, which the thread switched away from. It can still read, but only ${thread.providerInstanceId} can change things for this thread now; the thread's next message runs there. Retrying here will not help.`,
    };
  }
  if (!McpProviderSession.isLiveMcpProviderSession(caller)) {
    return {
      live: false,
      message: `This MCP session of thread ${thread.id} is no longer attached to SpecWithCode (the app restarted, or the session was released after being idle), so it can only read. Retrying will not help: the thread's next message attaches a new session with working tools.`,
    };
  }
  return { live: true, turn: "between_turns" };
}

/**
 * Whether Stop reached the thread's last turn: the turn ended interrupted, or
 * carries Stop's interrupt request (Stop on a thread whose turn had already
 * ended but left work running). Queued messages a Stop holds are not turns.
 */
export function lastTurnWasStopped(records: {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly ordinal: number;
  }>;
  readonly turnItems: ReadonlyArray<{ readonly type: string; readonly runId: string | null }>;
}): boolean {
  const lastTurn = records.runs
    .filter((run) => run.status !== "queued")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return (
    lastTurn !== undefined &&
    (lastTurn.status === "interrupted" ||
      records.turnItems.some(
        (item) => item.type === "run_interrupt_request" && item.runId === lastTurn.id,
      ))
  );
}

/**
 * `verdict` once Stop is counted: between turns, an agent a stopped turn left
 * running (a background agent or workflow, a subagent) changes nothing until
 * the thread's next message.
 */
export function afterStop(
  verdict: CallerLiveness,
  threadId: ThreadId,
  lastTurnStopped: boolean,
): CallerLiveness {
  return verdict.live && verdict.turn === "between_turns" && lastTurnStopped
    ? {
        live: false,
        message: `Thread ${threadId} was stopped, so this agent can only read until the thread gets its next message. Retrying will not help.`,
      }
    : verdict;
}
