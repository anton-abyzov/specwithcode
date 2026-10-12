/**
 * What the project pane says about the coordinator's latest turn. A message
 * accepted by the host is not an answer: the run behind it can still fail (a
 * provider that cannot open a session, a reached usage limit), and the server
 * records that on the run, not as a message.
 */

interface CoordinatorShellLike {
  readonly latestRun: { readonly runId: string; readonly status: string } | null;
  readonly runtime: { readonly lastError: string | null } | null;
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
}

const FALLBACK_FAILURE = "The coordinator could not start a turn.";

/** The failure of the coordinator's latest run, or null while it is fine. */
export function coordinatorTurnFailure(
  coordinator: CoordinatorShellLike | null | undefined,
): CoordinatorTurnFailure | null {
  const run = coordinator?.latestRun;
  if (!run || run.status !== "failed") return null;
  const message = coordinator?.runtime?.lastError?.trim();
  return { runId: run.runId, message: message || FALLBACK_FAILURE };
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
