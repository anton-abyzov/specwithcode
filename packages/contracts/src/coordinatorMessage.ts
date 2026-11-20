/**
 * A coordinator message: one machine's coordinator tells another machine's
 * coordinator in the same linked project something it must decide or act on.
 * It informs and never steers: the receiver stores it as a queued message on
 * its own coordinator thread, and any turn it starts runs on the receiver's
 * own sign-ins and rules. Big context stays on the sender and travels as refs
 * the receiver reads on demand.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/** What a machine names when it sends and when it answers coordinator messages. */
export const COORDINATOR_MESSAGE_CAPABILITY = "coordinator-message.v1";

export const COORDINATOR_MESSAGE_TEXT_MAX = 1500;
export const COORDINATOR_MESSAGE_SUBJECT_MAX = 120;
export const COORDINATOR_MESSAGE_STEP_MAX = 200;
export const COORDINATOR_MESSAGE_REFS_MAX = 8;
export const COORDINATOR_MESSAGE_DEDUPE_KEY_MAX = 200;
/** A report or file path a message names, and the path a report read asks for. */
export const COORDINATOR_MESSAGE_PATH_MAX = 1024;
/** The only files a report ref may name: a report in an increment's reports folder. */
export const COORDINATOR_MESSAGE_REPORT_PATH =
  /^\.specweave\/increments\/(?!\.\.?\/)[^/\\]+\/reports\/(?:(?!\.\.?\/)[^/\\]+\/)*[^/\\]+\.(md|txt|html|json)$/i;
/** A direction carries at most this many messages per project in an hour; more fold into a digest. */
export const COORDINATOR_MESSAGE_HOURLY_CAP = 6;

/** The refusal for a text over the cap. */
export const COORDINATOR_MESSAGE_TOO_LONG = "Put the detail in a report and reference it.";

/**
 * The wire's own caps sit above the message limits, so a message just over
 * a limit decodes and is refused in words (`coordinatorMessageProblem`).
 */
const wireText = (max: number) => Schema.String.check(Schema.isMaxLength(max * 4));
const nonEmpty = (max: number) => wireText(max).check(Schema.isMinLength(1));

export const CoordinatorMessageId = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);
export type CoordinatorMessageId = typeof CoordinatorMessageId.Type;

export const CoordinatorMessageKind = Schema.Literals(["problem", "finding", "request", "reply"]);
export type CoordinatorMessageKind = typeof CoordinatorMessageKind.Type;

/** The one step the user is asked to take, on the machine it names. */
export const CoordinatorMessageUserStep = Schema.Struct({
  environmentId: EnvironmentId,
  text: nonEmpty(COORDINATOR_MESSAGE_STEP_MAX),
});
export type CoordinatorMessageUserStep = typeof CoordinatorMessageUserStep.Type;

/** A pointer plus a small snapshot; never the content. */
export const CoordinatorMessageRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    title: wireText(200),
    statusAtSend: Schema.optional(wireText(40)),
  }),
  Schema.Struct({
    kind: Schema.Literal("report"),
    environmentId: EnvironmentId,
    path: nonEmpty(1024),
    bytes: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    environmentId: EnvironmentId,
    path: nonEmpty(1024),
    bytes: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    url: nonEmpty(512),
    title: wireText(200),
  }),
]);
export type CoordinatorMessageRef = typeof CoordinatorMessageRef.Type;

/** What a sending coordinator writes. */
export const CoordinatorMessageBody = Schema.Struct({
  kind: CoordinatorMessageKind,
  subject: nonEmpty(COORDINATOR_MESSAGE_SUBJECT_MAX),
  text: wireText(COORDINATOR_MESSAGE_TEXT_MAX),
  userStep: Schema.optional(CoordinatorMessageUserStep),
  refs: Schema.Array(CoordinatorMessageRef).check(
    Schema.isMaxLength(COORDINATOR_MESSAGE_REFS_MAX * 2),
  ),
  replyTo: Schema.optional(CoordinatorMessageId),
  dedupeKey: Schema.optional(wireText(COORDINATOR_MESSAGE_DEDUPE_KEY_MAX)),
});
export type CoordinatorMessageBody = typeof CoordinatorMessageBody.Type;

/** True for an absolute http or https URL, the only links a card opens. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Why a message cannot be sent as written, in words the sending agent can
 * act on, or null. `tooLarge` marks a limit the detail belongs in a report
 * for. Both the sender's tool and the receiver apply it.
 */
export function coordinatorMessageProblem(
  message: CoordinatorMessageBody,
): { readonly tooLarge: boolean; readonly message: string } | null {
  const tooLarge = (text: string) => ({ tooLarge: true, message: text });
  const invalid = (text: string) => ({ tooLarge: false, message: text });
  if (message.text.length > COORDINATOR_MESSAGE_TEXT_MAX)
    return tooLarge(
      `The text is ${message.text.length} characters, over ${COORDINATOR_MESSAGE_TEXT_MAX}. ${COORDINATOR_MESSAGE_TOO_LONG}`,
    );
  if (message.subject.length > COORDINATOR_MESSAGE_SUBJECT_MAX)
    return tooLarge(`The subject is over ${COORDINATOR_MESSAGE_SUBJECT_MAX} characters.`);
  if (message.userStep !== undefined && message.userStep.text.length > COORDINATOR_MESSAGE_STEP_MAX)
    return tooLarge(
      `The user step is over ${COORDINATOR_MESSAGE_STEP_MAX} characters. ${COORDINATOR_MESSAGE_TOO_LONG}`,
    );
  if (message.refs.length > COORDINATOR_MESSAGE_REFS_MAX)
    return tooLarge(
      `A message names at most ${COORDINATOR_MESSAGE_REFS_MAX} references. ${COORDINATOR_MESSAGE_TOO_LONG}`,
    );
  if (
    message.dedupeKey !== undefined &&
    message.dedupeKey.length > COORDINATOR_MESSAGE_DEDUPE_KEY_MAX
  )
    return tooLarge(`The dedupe key is over ${COORDINATOR_MESSAGE_DEDUPE_KEY_MAX} characters.`);
  if (
    message.refs.some(
      (ref) =>
        (ref.kind === "report" || ref.kind === "file") &&
        ref.path.length > COORDINATOR_MESSAGE_PATH_MAX,
    )
  )
    return invalid(`A referenced path is over ${COORDINATOR_MESSAGE_PATH_MAX} characters.`);
  if (message.refs.some((ref) => ref.kind === "pull_request" && !isWebUrl(ref.url)))
    return invalid("A pull request reference is an http or https URL.");
  if (message.subject.trim() === "") return invalid("A message needs a subject.");
  if (message.kind === "reply" && message.replyTo === undefined)
    return invalid("A reply names the message it answers (replyTo).");
  if (message.kind !== "reply" && message.replyTo !== undefined)
    return invalid("Only a reply names replyTo.");
  return null;
}

/**
 * The key repeats merge on when the sender names none: the kind, the
 * recipient and the sorted thread refs, or the subject when there are none.
 */
export function coordinatorMessageDedupeKey(
  message: CoordinatorMessageBody,
  recipient: EnvironmentId,
): string {
  if (message.dedupeKey !== undefined && message.dedupeKey.trim() !== "")
    return message.dedupeKey.trim();
  const threads = message.refs
    .flatMap((ref) => (ref.kind === "thread" ? [`${ref.environmentId}/${ref.threadId}`] : []))
    .sort();
  const tail =
    threads.length > 0
      ? `thread:${threads.join(",")}`
      : `subject:${message.subject.trim().toLowerCase()}`;
  return `${message.kind}:${recipient}:${tail}`.slice(0, COORDINATOR_MESSAGE_DEDUPE_KEY_MAX);
}

/**
 * Where a message stands on the machine that keeps it. Incoming: settling
 * (inside the settle window), held (the project is paused or archived),
 * folded (over the hourly cap, waits for the digest), delivered (queued on
 * the coordinator thread), quiet (kept and shown, wakes no model), revoked
 * (the sender's access ended before delivery), refused (the authority it was
 * admitted under no longer holds; kept and shown, never given to the agent).
 * Outgoing: queued, delivered, read, answered, not_delivered.
 */
export const CoordinatorMessageState = Schema.Literals([
  "refused",
  "settling",
  "held",
  "folded",
  "delivered",
  "quiet",
  "revoked",
  "queued",
  "read",
  "answered",
  "not_delivered",
]);
export type CoordinatorMessageState = typeof CoordinatorMessageState.Type;

/**
 * On a conversation message: it is a coordinator message, not a user's words
 * nor a worker's report. `senderThreadId` names a thread in this environment,
 * so the peer machine travels here.
 */
export const CoordinatorPeerMessage = Schema.Struct({
  messageId: CoordinatorMessageId,
  fromEnvironmentId: EnvironmentId,
  kind: CoordinatorMessageKind,
  direction: Schema.Literals(["incoming", "outgoing"]),
});
export type CoordinatorPeerMessage = typeof CoordinatorPeerMessage.Type;

/** The project whose kept coordinator messages a window reads (`projects.coordinatorMessages`). */
export const ProjectCoordinatorMessagesInput = Schema.Struct({ projectId: ProjectId });
export type ProjectCoordinatorMessagesInput = typeof ProjectCoordinatorMessagesInput.Type;

/**
 * One message as this machine keeps it, for the conversation: the live state
 * and merge count, so a merge or a receipt updates the row without rewriting
 * the stored conversation message. `id` is this machine's record id, the one
 * a delivered message's conversation id carries.
 */
export const CoordinatorMessageView = Schema.Struct({
  id: Schema.String,
  externalId: CoordinatorMessageId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  receiverMessageId: Schema.optional(CoordinatorMessageId),
  peerEnvironmentId: EnvironmentId,
  kind: CoordinatorMessageKind,
  subject: Schema.String,
  text: Schema.String,
  userStep: Schema.optional(CoordinatorMessageUserStep),
  refs: Schema.Array(CoordinatorMessageRef),
  replyTo: Schema.optional(CoordinatorMessageId),
  count: NonNegativeInt,
  state: CoordinatorMessageState,
  /** Epoch milliseconds. */
  receivedAt: Schema.Number,
  updatedAt: Schema.Number,
  /** Outgoing: the coordinator turn that sent it, so the row sits under that turn. */
  sourceRunId: Schema.optional(Schema.String),
  /** Incoming: the coordinator turn it woke; a digest's messages share one. */
  wokenRunId: Schema.optional(Schema.String),
});
export type CoordinatorMessageView = typeof CoordinatorMessageView.Type;

export const ProjectCoordinatorMessagesSnapshot = Schema.Struct({
  messages: Schema.Array(CoordinatorMessageView),
});
export type ProjectCoordinatorMessagesSnapshot = typeof ProjectCoordinatorMessagesSnapshot.Type;
