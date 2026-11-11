/**
 * What follows once a usage limit stops applying because its provider
 * instance was signed in to another subscription that has room: the stop is
 * armed and resumed without waiting for the old account's reset, the resume
 * says so and repeats a message the limit swallowed, and a thread whose last
 * report waits on a usage limit is continued once.
 *
 * @module limitLifted
 */
import {
  CommandId,
  MessageId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { accountChangeOf, isLimitRecoveryCandidate } from "./usageLimitRecovery.ts";

const POLICY_ARM_PREFIX = "limit-arm:";
const ACCOUNT_ARM = /^limit-arm:.*:acct:(\d+)$/;

/**
 * The arm that lets a limit stop resume because its instance moved to another
 * subscription with room (see `accountChangeShowsRoom`), for a stop nothing
 * armed: auto-continue at the reset is off. Signing in to another subscription
 * is the person's own go-ahead, and the project's
 * `autoApproveSubscriptionChange` is its switch, so the caller sends this only
 * while that is on. Null when the stop is already armed, or when a person
 * chose for this stop (turned its resume off, or stopped the thread): their
 * choice carries a request id that is not a policy arm's.
 */
export function accountChangeArmCommand(
  thread: ProjectionLimitRecoveryCandidate,
  changedMs: number,
  nowMs: number,
): Extract<OrchestrationV2ServerCommand, { type: "thread.metadata.update" }> | null {
  if (!isLimitRecoveryCandidate(thread) || !thread.latestRunId) return null;
  const resetAt = thread.usageLimitResetAt ?? null;
  const recovery = thread.limitRecovery;
  const own = recovery?.runId === thread.latestRunId && recovery.resetAt === resetAt;
  if (
    own &&
    (recovery.autoResume || !String(recovery.requestId ?? "").startsWith(POLICY_ARM_PREFIX))
  )
    return null;
  const resetMs = Date.parse(resetAt ?? "");
  return {
    type: "thread.metadata.update",
    commandId: CommandId.make(
      `${POLICY_ARM_PREFIX}${thread.id}:${thread.latestRunId}:${resetMs}:acct:${changedMs}`,
    ),
    threadId: thread.id,
    limitRecoveryPolicyArm: true,
    limitRecovery: {
      runId: thread.latestRunId,
      resetAt,
      autoResume: true,
      // The recovery's own snooze stays while its reset is ahead; a resume for
      // the new account ends it early (see recoverySnoozeBlocks).
      snooze: own === true && recovery?.snooze === true && resetMs > nowMs,
    },
  };
}

/** When the account changed, read from an `accountChangeArmCommand` id, or null for any other arm. */
export function accountChangeArmOf(requestId: string | undefined): number | null {
  const match = requestId === undefined ? null : ACCOUNT_ARM.exec(requestId);
  return match ? Number(match[1]) : null;
}

/** What a resume adds once the limit it waited on is gone. Also how a repeat of it is recognized. */
export const LIMIT_LIFTED_SENTENCE =
  "The usage limit that stopped this thread no longer applies: the provider is now signed in to a different subscription that has room. Do not wait for the old reset, and do not report that limit as a blocker.";

const PLAIN_CONTINUE = /^continue where you left off\.?$/i;

/**
 * The text of a resume sent because the account changed. `undelivered` is the
 * message of a stopped run that never reached the provider (refused before
 * its session opened), which "continue" alone would lose: a worker's "reported
 * back" wake, for one.
 */
export function limitResumeText(input: {
  readonly text: string;
  readonly undelivered: string | null;
  /** Attachments of the undelivered message; the repeat carries its text only. */
  readonly undeliveredAttachments?: number;
}): string {
  const undelivered = input.undelivered?.trim() ?? "";
  // A resume that was itself refused already carries both parts.
  if (undelivered.includes(LIMIT_LIFTED_SENTENCE)) return undelivered;
  const attachments = input.undeliveredAttachments ?? 0;
  const lead =
    undelivered === "" || PLAIN_CONTINUE.test(undelivered)
      ? input.text
      : `A usage limit stopped the last message before the provider saw it. Here it is again:\n\n${undelivered}${
          attachments === 0
            ? ""
            : `\n\n(That message had ${attachments === 1 ? "an attachment" : `${attachments} attachments`} this repeat does not carry. Ask for ${attachments === 1 ? "it" : "them"} again if the work needs ${attachments === 1 ? "it" : "them"}.)`
        }`;
  return `${lead}\n\n${LIMIT_LIFTED_SENTENCE}`;
}

/**
 * The text usage-limit recovery's resume carries when the account change is
 * what allowed it, or null for every other message: the resume's own id marks
 * the change, or the arm that allowed it does (a resume sent after the old
 * reset passed has no mark of its own).
 */
export function limitLiftedResumeText(
  command: {
    readonly commandId: string;
    readonly creationSource?: string | undefined;
    readonly text: string;
    readonly usageLimitContinuationOfRunId?: string | undefined;
    readonly manualContinuationOfRunId?: string | undefined;
  },
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
): string | null {
  if (command.creationSource !== "server" || !command.commandId.startsWith("limit-resume:"))
    return null;
  const runId = command.usageLimitContinuationOfRunId ?? command.manualContinuationOfRunId;
  if (runId === undefined) return null;
  const recovery = projection.thread.limitRecovery;
  const changedMs =
    accountChangeOf(command.commandId) ??
    (recovery?.runId === runId ? accountChangeArmOf(recovery.requestId) : null);
  if (changedMs === null) return null;
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const kept =
    run !== undefined && run.startedAt === null
      ? projection.messages.find((message) => message.id === run.userMessageId)
      : undefined;
  return limitResumeText({
    text: command.text,
    undelivered: kept?.text ?? null,
    undeliveredAttachments: kept?.attachments?.length ?? 0,
  });
}

/**
 * Whether a report's blocker is a provider usage limit: a closed set of
 * wordings, so a question about anything else, or a limit of another kind (a
 * file size, an API's rate limit, a storage quota), is not taken for one.
 */
export function blockerNamesUsageLimit(blocker: string): boolean {
  return USAGE_LIMIT_WORDING.test(blocker);
}

/** Providers, model families and the word a plan's limit is named by. */
const LIMIT_OWNER = String.raw`(?:claude|codex|fable|opus|sonnet|haiku|gpt|copilot|gemini|cursor|grok|muse|devin|opencode|subscription)`;

/** Any character that does not end a sentence; the dot of a version ("5.2") does not. */
const IN_SENTENCE = String.raw`(?:[^.?!\n]|\.(?=\d))`;

const USAGE_LIMIT_WORDING = new RegExp(
  [
    // "usage limit", "out of usage", "usage credits", "extra usage", "usage quota"
    String.raw`\busage\s+(?:limits?|caps?|credits|quota)\b`,
    String.raw`\bout of (?:extra )?usage\b`,
    String.raw`\b(?:plan|subscription)(?:'s)?\s+quota\b`,
    // "weekly Fable 5.2 limit", "5-hour limit": windows only a plan has
    String.raw`\b(?:weekly|5[- ]hour|five[- ]hour)\s+(?:\S+\s+){0,2}limits?\b`,
    // "Claude's limit", "the limit on Codex", within one sentence
    String.raw`\b${LIMIT_OWNER}\b${IN_SENTENCE}{0,40}\blimits?\b`,
    String.raw`\blimits?\b${IN_SENTENCE}{0,40}\b${LIMIT_OWNER}\b`,
    // "hit your limit", "reached its session limit": a limit that is someone's
    String.raw`\b(?:hit|reached|exhausted)\s+(?:your|its|their|our|my)\s+(?:\S+\s+){0,2}limits?\b`,
    // "the session limit is used up": spent, where another kind of limit is "reached"
    String.raw`\blimits?\s+(?:is|are|was|were|has been|have been)\s+(?:used up|exhausted|spent)\b`,
  ].join("|"),
  "i",
);

/** A report older than this is not woken for an account change. */
export const LIMIT_BLOCKED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

type LimitBlockedShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "activeRunId"
  | "archivedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "pendingRuntimeRequest"
  | "reportedBlocker"
  | "lineage"
  | "creationSource"
  | "heldQueuedCount"
>;

/**
 * Whether a thread sits idle on a report that names a usage limit as its
 * blocker, written before the account changed at `changedMs`. Nothing else
 * holds it: it is not running, settled, archived, snoozed, waiting on a
 * request or on a held queue, and it can take a message.
 */
export function isLimitBlockedThread(
  shell: LimitBlockedShell,
  changedMs: number,
  nowMs: number,
): boolean {
  const completedMs =
    shell.latestRunCompletedAt == null ? null : DateTime.toEpochMillis(shell.latestRunCompletedAt);
  return (
    shell.status === "completed" &&
    shell.latestRunId !== null &&
    shell.activeRunId === null &&
    shell.archivedAt === null &&
    shell.settledOverride !== "settled" &&
    shell.pendingRuntimeRequest === null &&
    (shell.heldQueuedCount ?? 0) === 0 &&
    !(shell.snoozedUntil != null && DateTime.toEpochMillis(shell.snoozedUntil) > nowMs) &&
    !isProviderNativeSubagentThread(shell) &&
    completedMs !== null &&
    completedMs < changedMs &&
    changedMs - completedMs <= LIMIT_BLOCKED_MAX_AGE_MS &&
    typeof shell.reportedBlocker === "string" &&
    blockerNamesUsageLimit(shell.reportedBlocker)
  );
}

/**
 * The one message a limit-blocked thread gets for an account change. Its id
 * is fixed by the report's run and the change, so a later sweep or a restart
 * sends nothing new, and as a user-role message it ends the Blocked state.
 */
export function limitBlockedContinuation(
  shell: Pick<OrchestrationV2ThreadShell, "id" | "latestRunId">,
  providerName: string,
  changedMs: number,
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> {
  const id = `limit-lifted:${shell.id}:${shell.latestRunId}:${changedMs}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId: shell.id,
    // The change may be on another provider than the one the report meant, so
    // the agent is told which one changed and left to judge.
    text: `Your last report named a usage limit as its blocker. ${providerName} on this machine is now signed in to a different subscription that has room. If the limit you reported was ${providerName}'s, continue the work now and do not wait for the old reset. If it was another provider's limit, or the work waits on something else, say so.`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}
