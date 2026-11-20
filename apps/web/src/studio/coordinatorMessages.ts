import type { CoordinatorMessageView } from "@specweave-studio/contracts";

/**
 * Coordinator messages between linked machines in the conversation (1427 AC-18, AC-19).
 * The receiver posts each delivered message, or a digest of several, under an id that
 * carries this machine's record id; the kept record carries its live state.
 */
const SINGLE = /^coordinator-message:(cm-[0-9a-f]{40}):\d+(?::\d+)?$/;
const DIGEST = /^coordinator-message-digest:(cm-[0-9a-f]{40}):[0-9a-f]{24}$/;

export type CoordinatorMessageRow = {
  /** This machine's record id of the message, or of a digest's first message. */
  readonly recordId: string;
  readonly digest: boolean;
};

/** Null for every conversation message the receiver did not post. */
export function coordinatorMessageRow(messageId: string): CoordinatorMessageRow | null {
  const single = SINGLE.exec(messageId);
  if (single) return { recordId: single[1]!, digest: false };
  const digest = DIGEST.exec(messageId);
  return digest ? { recordId: digest[1]!, digest: true } : null;
}

/**
 * The kept messages a conversation row shows: the one message, or every
 * message the digest's turn carried, oldest first. Empty when the record is
 * not (yet) in the list, so the row falls back to its own text.
 */
export function rowMessages(
  row: CoordinatorMessageRow,
  byId: ReadonlyMap<string, CoordinatorMessageView>,
  all: readonly CoordinatorMessageView[],
): CoordinatorMessageView[] {
  const first = byId.get(row.recordId);
  if (first === undefined) return [];
  if (!row.digest || first.wokenRunId === undefined) return [first];
  return all
    .filter(
      (each) =>
        each.direction === "incoming" &&
        (each.id === first.id || each.wokenRunId === first.wokenRunId),
    )
    .toSorted((a, b) => a.receivedAt - b.receivedAt);
}

/** A problem with a step opens; the rest show as one line that opens on a click. */
export function coordinatorMessageStartsOpen(message: CoordinatorMessageView): boolean {
  return message.kind === "problem" && message.userStep !== undefined;
}

/** Either id a reply may name: the sender's or the one the receiver gave it. */
function answers(reply: CoordinatorMessageView, message: CoordinatorMessageView): boolean {
  if (reply.kind !== "reply" || reply.replyTo === undefined || reply.id === message.id)
    return false;
  return reply.replyTo === message.externalId || reply.replyTo === message.receiverMessageId;
}

/** The replies that answer a message, oldest first. */
export function repliesTo(
  message: CoordinatorMessageView,
  all: readonly CoordinatorMessageView[],
): CoordinatorMessageView[] {
  return all
    .filter((each) => answers(each, message))
    .toSorted((a, b) => a.receivedAt - b.receivedAt);
}

/**
 * The messages the "Messages between coordinators" view lists, oldest first: every
 * message that answers none other kept here, so each reply shows once, under its message.
 */
export function coordinatorMessageRoots(
  all: readonly CoordinatorMessageView[],
): CoordinatorMessageView[] {
  return all
    .filter((message) => !all.some((other) => answers(message, other)))
    .toSorted((a, b) => a.receivedAt - b.receivedAt);
}

export type CoordinatorMessageStateLabel = {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly tone: "muted" | "positive" | "warning";
};

/** What the row says about where the message stands, in words a person reads. */
export function coordinatorMessageStateLabel(
  message: Pick<CoordinatorMessageView, "state" | "direction">,
  machine: string,
): CoordinatorMessageStateLabel | null {
  switch (message.state) {
    case "queued":
      return { text: "Queued", tone: "muted" };
    case "delivered":
      return message.direction === "outgoing" ? { text: "Delivered", tone: "positive" } : null;
    case "read":
      return { text: "Read", tone: "positive" };
    case "answered":
      return { text: "Answered", tone: "positive" };
    case "not_delivered":
      return {
        text: "Not delivered: {machine} was offline for 24 hours",
        values: { machine },
        tone: "warning",
      };
    case "revoked":
      return { text: "{machine}'s access was revoked", values: { machine }, tone: "warning" };
    case "held":
      return { text: "Waiting: this project is paused", tone: "muted" };
    case "settling":
    case "folded":
      return { text: "Arriving", tone: "muted" };
    case "quiet":
    case "refused":
      return null;
  }
}

export const COORDINATOR_MESSAGE_KIND_LABELS = {
  problem: "Problem",
  finding: "Finding",
  request: "Request",
  reply: "Reply",
} as const satisfies Record<CoordinatorMessageView["kind"], string>;

/**
 * Outgoing messages placed under the coordinator turn that sent them. One whose
 * turn is not in the window shows at the end, so none is lost.
 */
export function placeOutgoingMessages(
  messages: readonly CoordinatorMessageView[],
  rows: readonly { readonly id: string; readonly runId?: string | null | undefined }[],
): {
  readonly byRow: ReadonlyMap<string, readonly CoordinatorMessageView[]>;
  readonly rest: readonly CoordinatorMessageView[];
} {
  const lastRowOfRun = new Map<string, string>();
  for (const row of rows) if (row.runId) lastRowOfRun.set(row.runId, row.id);
  const byRow = new Map<string, CoordinatorMessageView[]>();
  const rest: CoordinatorMessageView[] = [];
  const outgoing = messages
    .filter((message) => message.direction === "outgoing")
    .toSorted((a, b) => a.receivedAt - b.receivedAt);
  for (const message of outgoing) {
    const rowId = message.sourceRunId ? lastRowOfRun.get(message.sourceRunId) : undefined;
    if (rowId === undefined) rest.push(message);
    else byRow.set(rowId, [...(byRow.get(rowId) ?? []), message]);
  }
  return { byRow, rest };
}

/**
 * The step to notify about, once per message (1427 AC-19): only an incoming
 * message with a step, never one already notified, so a merged repeat, a
 * reload or a second refresh stays silent.
 */
export function stepsToNotify(
  messages: readonly CoordinatorMessageView[],
  notified: ReadonlySet<string>,
): CoordinatorMessageView[] {
  return messages.filter(
    (message) =>
      message.direction === "incoming" &&
      message.userStep !== undefined &&
      (message.state === "delivered" || message.state === "quiet") &&
      !notified.has(message.id),
  );
}

/** A step that arrived this long before the window opened still notifies once. */
export const COORDINATOR_STEP_RECENT_MS = 10 * 60_000;

export function coordinatorStepEventKey(environmentId: string, messageId: string): string {
  return JSON.stringify([environmentId, "coordinator-step", messageId]);
}

/** The steps to raise now: new, with a step, and not older than the window's baseline. */
export function stepsToRaise(
  messages: readonly CoordinatorMessageView[],
  raised: ReadonlySet<string>,
  since: number,
): CoordinatorMessageView[] {
  return stepsToNotify(messages, raised).filter((message) => message.receivedAt >= since);
}

/** The desktop notification for a step: the machine first, then who sent it. */
export function stepNotification(input: {
  readonly step: string;
  readonly stepMachine: string;
  readonly sender: string;
  readonly project: string;
  readonly tx: (text: string, values: Readonly<Record<string, string>>) => string;
}): { readonly title: string; readonly body: string } {
  return {
    title: input.tx("On {machine}: {step}", { machine: input.stepMachine, step: input.step }),
    body: input.tx("From {machine}'s coordinator · {project}", {
      machine: input.sender,
      project: input.project,
    }),
  };
}

/** Every phrase the coordinator message rows and notifications add, for the catalog check. */
export const COORDINATOR_MESSAGE_PHRASES = [
  "From {machine}'s coordinator",
  "To {machine}'s coordinator",
  "On {machine}: {step}",
  "From {machine}'s coordinator · {project}",
  "{count} more messages",
  "Sent {count} times",
  "Open {machine}'s coordinator",
  "Messages between coordinators",
  "Show the whole conversation",
  "No messages between coordinators yet.",
  "Queued",
  "Delivered",
  "Read",
  "Answered",
  "Arriving",
  "Waiting: this project is paused",
  "Not delivered: {machine} was offline for 24 hours",
  "{machine}'s access was revoked",
  "Problem",
  "Finding",
  "Request",
  "Reply",
  "Thread on {machine}",
  "Report on {machine}",
  "File on {machine}",
  "Pull request",
] as const;
