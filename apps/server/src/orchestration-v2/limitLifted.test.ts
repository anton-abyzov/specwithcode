import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import {
  LIMIT_BLOCKED_MAX_AGE_MS,
  LIMIT_LIFTED_SENTENCE,
  accountChangeArmCommand,
  accountChangeArmLapse,
  accountChangeArmOf,
  blockerNamesUsageLimit,
  isLimitBlockedThread,
  limitBlockedContinuation,
  limitLiftedResumeText,
  limitResumeText,
} from "./limitLifted.ts";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { claudeLimitStop } from "./UsageLimitRecoveryWorker.testkit.ts";

const HOUR = 60 * 60_000;
const RESET = 5 * HOUR;
const stop = claudeLimitStop(RESET);
const resetAt = stop.usageLimitResetAt;
const recovery = (
  patch: Partial<Omit<OrchestrationV2LimitRecovery, "requestId">> & { requestId: string },
): OrchestrationV2LimitRecovery =>
  ({
    runId: stop.latestRunId,
    resetAt,
    autoResume: false,
    snooze: false,
    checkNow: false,
    explicitArm: false,
    ...patch,
  }) as OrchestrationV2LimitRecovery;
const stopWith = (
  limitRecovery: OrchestrationV2LimitRecovery,
): ProjectionLimitRecoveryCandidate => ({
  ...stop,
  limitRecovery,
});

describe("accountChangeArmCommand", () => {
  it("arms a stop nothing armed, marked with the change", () => {
    const arm = accountChangeArmCommand(stop, HOUR, HOUR);
    expect(arm?.commandId).toBe(`limit-arm:claude-limited:failed-run:${RESET}:acct:${HOUR}`);
    expect(arm?.limitRecoveryPolicyArm).toBe(true);
    expect(arm?.limitRecovery).toEqual({
      runId: stop.latestRunId,
      resetAt,
      autoResume: true,
      snooze: false,
    });
    expect(accountChangeArmOf(arm?.commandId)).toBe(HOUR);
  });

  it("keeps the snooze of a stop the rule armed with auto-continue off", () => {
    const snoozed = stopWith(
      recovery({ snooze: true, requestId: `limit-arm:claude-limited:failed-run:${RESET}` }),
    );
    expect(accountChangeArmCommand(snoozed, HOUR, HOUR)?.limitRecovery?.snooze).toBe(true);
    // Past the reset there is nothing left to snooze until.
    expect(accountChangeArmCommand(snoozed, HOUR, RESET + 1)?.limitRecovery?.snooze).toBe(false);
  });

  it("leaves a stop the person chose for", () => {
    const turnedOff = stopWith(recovery({ requestId: "web:auto-resume-off" }));
    expect(accountChangeArmCommand(turnedOff, HOUR, HOUR)).toBeNull();
  });

  it("leaves a stop that is armed already", () => {
    const armed = stopWith(
      recovery({ autoResume: true, requestId: `limit-arm:claude-limited:failed-run:${RESET}` }),
    );
    expect(accountChangeArmCommand(armed, HOUR, HOUR)).toBeNull();
  });

  it("arms a new stop whatever an earlier stop's recovery said", () => {
    const earlier = stopWith(
      recovery({ runId: RunId.make("earlier-run"), requestId: "web:auto-resume-off" }),
    );
    expect(accountChangeArmCommand(earlier, HOUR, HOUR)).not.toBeNull();
  });

  it("is nothing for a thread that is not stopped on a limit", () => {
    expect(
      accountChangeArmCommand({ ...stop, status: "completed", lastErrorClass: null }, HOUR, HOUR),
    ).toBeNull();
  });

  it("reads no change from any other arm", () => {
    expect(accountChangeArmOf(`limit-arm:claude-limited:failed-run:${RESET}`)).toBeNull();
    expect(accountChangeArmOf(`limit-arm:claude-limited:failed-run:${RESET}:policy-on`)).toBeNull();
    expect(accountChangeArmOf("web:acct:12")).toBeNull();
    expect(accountChangeArmOf(undefined)).toBeNull();
  });
});

describe("accountChangeArmLapse", () => {
  const armId = `limit-arm:claude-limited:failed-run:${RESET}:acct:${HOUR}`;
  const armed = stopWith(recovery({ autoResume: true, requestId: armId }));

  it("takes the arm back once the old reset passed", () => {
    const lapse = accountChangeArmLapse(armed, RESET + 1);
    expect(lapse?.commandId).toBe(`${armId}:lapsed`);
    expect(lapse?.limitRecoveryPolicyArm).toBe(true);
    expect(lapse?.limitRecovery).toEqual({
      runId: stop.latestRunId,
      resetAt,
      autoResume: false,
    });
    // The write reads as a rule's, never as the person turning the resume off.
    expect(accountChangeArmOf(lapse?.commandId)).toBeNull();
    expect(String(lapse?.commandId).startsWith("limit-arm:")).toBe(true);
  });

  it("keeps the arm while the old reset is ahead", () => {
    expect(accountChangeArmLapse(armed, RESET - 1)).toBeNull();
  });

  it("leaves any other arm, and a stop that is not armed", () => {
    expect(
      accountChangeArmLapse(
        stopWith(
          recovery({ autoResume: true, requestId: `limit-arm:claude-limited:failed-run:${RESET}` }),
        ),
        RESET + 1,
      ),
    ).toBeNull();
    expect(
      accountChangeArmLapse(
        stopWith(recovery({ autoResume: true, requestId: "web:auto-resume-on" })),
        RESET + 1,
      ),
    ).toBeNull();
    expect(accountChangeArmLapse(stopWith(recovery({ requestId: armId })), RESET + 1)).toBeNull();
    expect(
      accountChangeArmLapse(
        stopWith(
          recovery({ autoResume: true, runId: RunId.make("earlier-run"), requestId: armId }),
        ),
        RESET + 1,
      ),
    ).toBeNull();
  });
});

describe("limitResumeText", () => {
  const text = "Continue where you left off.";

  it("says the limit no longer applies", () => {
    expect(limitResumeText({ text, undelivered: null })).toBe(
      `${text}\n\n${LIMIT_LIFTED_SENTENCE}`,
    );
  });

  it("repeats a message the limit kept from the provider", () => {
    const resumed = limitResumeText({ text, undelivered: "Fable build reported back: done." });
    expect(resumed).toContain("Here it is again:\n\nFable build reported back: done.");
    expect(resumed.endsWith(LIMIT_LIFTED_SENTENCE)).toBe(true);
    expect(resumed).not.toContain(text);
  });

  it("says when the repeat leaves attachments behind", () => {
    const one = limitResumeText({
      text,
      undelivered: "See the screenshot.",
      undeliveredAttachments: 1,
    });
    expect(one).toContain("had an attachment this repeat does not carry");
    const two = limitResumeText({ text, undelivered: "See both.", undeliveredAttachments: 2 });
    expect(two).toContain("had 2 attachments this repeat does not carry");
    expect(limitResumeText({ text, undelivered: "No files." })).not.toContain("attachment");
  });

  it("does not repeat an earlier plain resume", () => {
    expect(limitResumeText({ text, undelivered: text })).toBe(
      `${text}\n\n${LIMIT_LIFTED_SENTENCE}`,
    );
  });

  it("does not wrap a resume that was itself refused", () => {
    const first = limitResumeText({ text, undelivered: "Worker reported back." });
    expect(limitResumeText({ text, undelivered: first })).toBe(first);
  });
});

describe("limitLiftedResumeText", () => {
  const runId = RunId.make("failed-run");
  const projection = (input: {
    readonly started: boolean;
    readonly requestId?: string;
    readonly recoveryRun?: string;
  }) =>
    ({
      thread: {
        limitRecovery:
          input.requestId === undefined
            ? null
            : { runId: input.recoveryRun ?? runId, requestId: input.requestId },
      },
      runs: [
        {
          id: runId,
          userMessageId: MessageId.make("wake"),
          startedAt: input.started ? DateTime.makeUnsafe(1) : null,
        },
      ],
      messages: [{ id: MessageId.make("wake"), text: "Fable build reported back: done." }],
    }) as unknown as Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">;
  const resume = (id: string, patch: Record<string, unknown> = {}) => ({
    commandId: id,
    creationSource: "server",
    text: "Continue where you left off.",
    usageLimitContinuationOfRunId: runId,
    ...patch,
  });
  const marked = `limit-resume:t:failed-run:${RESET}:acct:${HOUR}:limit-arm:t:failed-run:${RESET}`;
  const plain = `limit-resume:t:failed-run:${RESET}:limit-arm:t:failed-run:${RESET}`;

  it("adds the sentence to a resume its id marks with the change", () => {
    expect(limitLiftedResumeText(resume(marked), projection({ started: true }))).toBe(
      `Continue where you left off.\n\n${LIMIT_LIFTED_SENTENCE}`,
    );
  });

  it("repeats the message of a run that never started", () => {
    const resumed = limitLiftedResumeText(resume(marked), projection({ started: false }));
    expect(resumed).toContain("Fable build reported back: done.");
    expect(resumed).toContain(LIMIT_LIFTED_SENTENCE);
  });

  it("takes the change from the arm when the resume left after the old reset", () => {
    const armedForChange = `limit-arm:t:failed-run:${RESET}:acct:${HOUR}`;
    expect(
      limitLiftedResumeText(
        resume(`limit-resume:t:failed-run:${RESET}:${armedForChange}`),
        projection({ started: true, requestId: armedForChange }),
      ),
    ).toContain(LIMIT_LIFTED_SENTENCE);
    // The arm of another run says nothing about this one.
    expect(
      limitLiftedResumeText(
        resume(plain),
        projection({ started: true, requestId: armedForChange, recoveryRun: "another-run" }),
      ),
    ).toBeNull();
  });

  it("leaves a resume at the reset as it is", () => {
    expect(
      limitLiftedResumeText(
        resume(plain),
        projection({ started: false, requestId: `limit-arm:t:failed-run:${RESET}` }),
      ),
    ).toBeNull();
  });

  it("leaves every other message as it is", () => {
    const state = projection({ started: false });
    expect(limitLiftedResumeText(resume(marked, { creationSource: "web" }), state)).toBeNull();
    expect(limitLiftedResumeText(resume(`web:acct:${HOUR}:x`), state)).toBeNull();
    expect(
      limitLiftedResumeText(resume(marked, { usageLimitContinuationOfRunId: undefined }), state),
    ).toBeNull();
  });
});

describe("blockerNamesUsageLimit", () => {
  it.each([
    "the weekly Fable 5.2 limit is used up and resets on November 13, 2026 at 02:00 UTC. Wait, or move to another model?",
    "Claude's usage limit was reached; continue on Codex?",
    "The worker hit its 5-hour limit.",
    "Codex is out of usage until Friday.",
    "The worker reported: You're out of usage credits.",
    "We reached the weekly limit, wait or switch?",
    "The plan's quota is spent.",
    "The session limit is used up.",
    "Waiting for the Fable 5.2 limit to reset.",
    "You've hit your limit · resets 3pm",
    "Out of extra usage, wait or switch?",
    "The limit on Codex resets Friday; wait for it?",
    "Session limit reached, resets 9pm",
    "Max plan limit reached",
    "Copilot premium requests quota exceeded",
    "You exceeded your current quota",
    "The worker stopped. Claude hit its limit and it resets Thursday.",
  ])("takes %s for a usage limit", (blocker) => {
    expect(blockerNamesUsageLimit(blocker)).toBe(true);
  });

  it.each([
    "Pair Chrome, or skip the check?",
    "Which branch should the release go from?",
    "The PR needs your approval before I merge.",
    "Limit the change to the server, or include the web app?",
    "I need the App Store password.",
    // Limits of another kind.
    "Hit the 1500 line file limit in Orchestrator.ts",
    "The GitHub API rate limit was reached; waiting for it to reset",
    "GitHub Actions quota exhausted, CI will not run",
    "Cloudflare R2 quota exceeded",
    "Reached the session limit of 5 concurrent connections",
    "Needs your decision on the daily limit for transfers",
    "The upload limit was reached",
    // A provider's name beside "limit" that is not its usage limit.
    "Claude should limit the change to the server",
    "I will limit the Cursor rules file to 50 lines",
    "The subscription form has a character limit",
    "the 500 line limit for the Claude settings file",
    "The opus file exceeds the size limit",
    "the Codex CLI hit a rate limit from the GitHub API",
    "The Gemini API rate limit returned 429",
    "Claude hit the context limit, start a new thread?",
    "The weekly report limit is 5 pages",
    "weekly deploy limit of the CI",
    "limit the scope to Codex support only",
    "YouTube Data API quota exceeded",
    "Instagram daily post limit reached",
    "monthly Supabase egress limit",
    // The provider is named in one sentence, another limit in the next.
    "Codex finished the patch. The upload limit was reached.",
  ])("leaves %s alone", (blocker) => {
    expect(blockerNamesUsageLimit(blocker)).toBe(false);
  });
});

describe("isLimitBlockedThread", () => {
  const blocked = {
    id: ThreadId.make("coordinator"),
    status: "completed",
    latestRunId: RunId.make("run-9"),
    latestRunCompletedAt: DateTime.makeUnsafe(30 * 60_000),
    activeRunId: null,
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    pendingRuntimeRequest: null,
    reportedBlocker: "the weekly Fable 5.2 limit is used up and resets on November 13, 2026.",
    lineage: { relationshipToParent: "root" },
    creationSource: "web",
  } as unknown as OrchestrationV2ThreadShell;
  const with_ = (patch: Record<string, unknown>) =>
    ({ ...blocked, ...patch }) as unknown as OrchestrationV2ThreadShell;

  it("is a thread idle on a limit report from before the change", () => {
    expect(isLimitBlockedThread(blocked, HOUR, HOUR)).toBe(true);
  });

  it.each([
    ["a blocker about something else", { reportedBlocker: "Pair Chrome, or skip the check?" }],
    ["no blocker", { reportedBlocker: null }],
    ["a running thread", { activeRunId: RunId.make("run-10") }],
    ["a failed thread", { status: "failed" }],
    ["a settled thread", { settledOverride: "settled" }],
    ["an archived thread", { archivedAt: DateTime.makeUnsafe(40 * 60_000) }],
    ["a snoozed thread", { snoozedUntil: DateTime.makeUnsafe(2 * HOUR) }],
    ["a thread waiting on a request", { pendingRuntimeRequest: { id: "request" } }],
    ["a thread with a held queue", { heldQueuedCount: 1 }],
    ["a report written after the change", { latestRunCompletedAt: DateTime.makeUnsafe(HOUR + 1) }],
    [
      "a provider's own subagent",
      { lineage: { relationshipToParent: "subagent" }, creationSource: "provider" },
    ],
  ] as const)("is not %s", (_name, patch) => {
    expect(isLimitBlockedThread(with_(patch), HOUR, HOUR)).toBe(false);
  });

  it("is not a report older than a week", () => {
    const changedMs = LIMIT_BLOCKED_MAX_AGE_MS + HOUR;
    expect(isLimitBlockedThread(blocked, changedMs, changedMs)).toBe(false);
  });

  it("counts a snooze that has run out as over", () => {
    expect(
      isLimitBlockedThread(with_({ snoozedUntil: DateTime.makeUnsafe(HOUR - 1) }), HOUR, HOUR),
    ).toBe(true);
  });

  it("builds one message per thread, report and change", () => {
    const message = limitBlockedContinuation(blocked, "Claude", HOUR);
    expect(message.commandId).toBe(CommandId.make(`limit-lifted:coordinator:run-9:${HOUR}`));
    expect(message.messageId).toBe(message.commandId);
    expect(message.createdBy).toBe("user");
    expect(message.creationSource).toBe("server");
    expect(message.dispatchMode).toEqual({ type: "start_immediately" });
    expect(message.text).toContain("Claude on this machine is now signed in");
    // The thread may run on, or have reported, another provider.
    expect(message.text).toContain("If the limit you reported was Claude's, continue");
    expect(message.text).toContain("If it was another provider's limit");
  });
});
