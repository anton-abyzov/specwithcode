/**
 * What the project pane says about the coordinator's latest turn. A message
 * accepted by the host is not an answer: the run behind it can still fail (a
 * provider that cannot open a session, a reached usage limit), and the server
 * records that on the run, not as a message.
 */

interface CoordinatorShellLike {
  readonly latestRun: { readonly runId: string; readonly status: string } | null;
  readonly runtime: {
    readonly lastError: string | null;
    readonly lastErrorClass?: string | null;
    readonly usageLimitResetAt?: string | null;
  } | null;
}

interface CoordinatorMessageLike {
  readonly id: string;
  readonly role: string;
  readonly createdBy?: string | undefined;
  readonly text: string;
  readonly runId?: string | null | undefined;
}

interface CoordinatorRunLike {
  readonly id: string;
  readonly userMessageId: string;
  readonly ordinal: number;
  readonly status: string;
}

export interface CoordinatorTurnFailure {
  readonly runId: string;
  readonly message: string;
  /** The host's failure class, such as "usage_limit"; null when it named none. */
  readonly errorClass?: string | null;
  /** When the reached usage limit resets, as the host observed it. */
  readonly resetAt?: string | null;
}

const FALLBACK_FAILURE = "The coordinator could not start a turn.";

/** The failure of the coordinator's latest run, or null while it is fine. */
export function coordinatorTurnFailure(
  coordinator: CoordinatorShellLike | null | undefined,
): CoordinatorTurnFailure | null {
  const run = coordinator?.latestRun;
  if (!run || run.status !== "failed") return null;
  const runtime = coordinator?.runtime;
  const message = runtime?.lastError?.trim();
  return {
    runId: run.runId,
    message: message || FALLBACK_FAILURE,
    errorClass: runtime?.lastErrorClass ?? null,
    resetAt: runtime?.usageLimitResetAt ?? null,
  };
}

function messageRunFailed(
  message: CoordinatorMessageLike,
  runs: ReadonlyArray<CoordinatorRunLike> | undefined,
  latestFailure: CoordinatorTurnFailure | null,
): boolean {
  let latest: CoordinatorRunLike | null = null;
  for (const run of runs ?? []) {
    if (run.userMessageId !== message.id) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  if (latest !== null) return latest.status === "failed";
  return latestFailure !== null && message.runId === latestFailure.runId;
}

/**
 * Starter tasks the coordinator already holds: a user message with the task's
 * request whose run did not fail. Read from the coordinator thread, so it
 * survives a reload, and a failed send offers the task again.
 */
export function sentStarterIds(
  suggestions: ReadonlyArray<{ readonly id: string; readonly prompt: string }>,
  projection:
    | {
        readonly messages: ReadonlyArray<CoordinatorMessageLike>;
        readonly runs?: ReadonlyArray<CoordinatorRunLike>;
      }
    | null
    | undefined,
  latestFailure: CoordinatorTurnFailure | null,
): ReadonlySet<string> {
  const sent = new Set<string>();
  if (!projection) return sent;
  for (const suggestion of suggestions) {
    const prompt = suggestion.prompt.trim();
    const delivered = projection.messages.some(
      (message) =>
        message.role === "user" &&
        (message.createdBy ?? "user") === "user" &&
        message.text.trim() === prompt &&
        !messageRunFailed(message, projection.runs, latestFailure),
    );
    if (delivered) sent.add(suggestion.id);
  }
  return sent;
}

/** The highest run ordinal the coordinator's projection holds; -1 with none. */
export function latestOrdinal(
  runs: ReadonlyArray<{ readonly ordinal: number }> | null | undefined,
): number {
  let latest = -1;
  for (const run of runs ?? []) if (run.ordinal > latest) latest = run.ordinal;
  return latest;
}
