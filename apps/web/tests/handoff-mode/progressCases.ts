/**
 * The Hand off dialog's progress cases (1390 AC-21, AC-31): each partial result a hand off
 * can end in, built from real transfer records through the real row logic.
 *
 * The "Stays" reasons are read from the server's own source, so a reason added there shows
 * up here without editing this file, and verify.mjs fails if one is not rendered.
 *
 * To add a case when a surface lands on main (#707, #717, the T-12 follow-up): add an entry
 * to HANDOFF_PROGRESS_CASES, then move its key out of PENDING_CASES in verify.mjs.
 */
import type {
  EnvironmentId,
  HandoffTransferRecord,
  HandoffTransferState,
  HandoffTransferTrigger,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

import {
  progressRow,
  type HandOffTrackOut,
} from "../../src/components/handoff/handOffProgress.logic";
import type { HandOffProgressViewRow } from "../../src/components/handoff/HandOffProgress";
import runnerSource from "../../../server/src/handoff/HandoffTransferRunner.ts?raw";
import followSource from "../../../server/src/handoff/handoffFollow.ts?raw";
import resumeSource from "../../../server/src/handoff/handoffResume.ts?raw";

const M4 = "env-m4" as EnvironmentId;
const MINIS = "env-minis" as EnvironmentId;

/** Every top-level string constant of a server file: `const NAME =\n  "text";`. */
function constants(source: string): Array<{ name: string; text: string }> {
  return [
    ...source.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]+) =\s*"((?:[^"\\]|\\.)*)";/gm),
  ].map((match) => ({ name: match[1]!, text: JSON.parse(`"${match[2]!}"`) as string }));
}

/** The words a stayed or refused thread carries, with where each comes from. */
export const STAYS_REASONS: ReadonlyArray<{
  readonly name: string;
  readonly text: string;
  readonly state: "stayed" | "failed";
}> = [
  ...constants(runnerSource).map((entry) => ({
    ...entry,
    // The runner's refusals end a record "failed"; everything else it says ends it "stayed".
    state: entry.name === "NO_MACHINE_ACCEPTED" ? ("failed" as const) : ("stayed" as const),
  })),
  ...constants(followSource)
    .filter((entry) => entry.name === "FOLLOW_NOT_RECORDED")
    .map((entry) => ({ ...entry, state: "failed" as const })),
  ...constants(resumeSource)
    .filter((entry) => entry.name === "UNSETTLED_CHILD_REFUSAL")
    .map((entry) => ({ ...entry, state: "failed" as const })),
  // needsUpdateWaits(label) is a function in the runner: its one wording, for Minis.
  {
    name: "needsUpdateWaits",
    text: "Minis needs an update before it can say whether it continued this thread. The thread stays paused until then.",
    state: "stayed",
  },
  // A step-2 refusal comes back in the destination's own words (HandoffMoves, needs_grant).
  {
    name: "needs_grant",
    text: "Not moved: Minis no longer lets M4 start work there.",
    state: "failed",
  },
  {
    name: "bundle-too-large",
    text: "The checkpoint is over the 2 GB limit, so the thread stays here.",
    state: "stayed",
  },
];

/** A next step the user can press, by its accessible name, or the word "Wait" (not a control). */
export type ExpectedControl = "Resume here" | "Wait" | "Open on Minis" | "Try again" | null;

export interface ExpectedRow {
  readonly state: string;
  readonly control: ExpectedControl;
  /** The exact "Stays" reason under the row, or null when none is shown. */
  readonly reason: string | null;
}

/**
 * What the dialog must show for each input record state, written out by hand from AC-21 and
 * the progress view's contract. Never derived from `progressRow`: a wrong mapping in the
 * shipped logic must disagree with this table.
 */
export const EXPECTED_BY_INPUT: Readonly<
  Record<HandoffTransferState, { readonly state: string; readonly control: ExpectedControl }>
> = {
  pending: { state: "pending", control: null },
  held: { state: "held", control: "Resume here" },
  sent: { state: "waiting", control: "Wait" },
  accepted: { state: "waiting", control: "Wait" },
  unknown: { state: "waiting", control: "Wait" },
  resumed: { state: "resumed", control: "Open on Minis" },
  ready: { state: "ready", control: "Open on Minis" },
  stayed: { state: "stayed", control: null },
  failed: { state: "failed", control: "Try again" },
};

export type FixtureRow = HandOffProgressViewRow & { readonly expected: ExpectedRow };

let serial = 0;
function record(
  state: HandoffTransferState,
  title: string,
  extra: Partial<HandoffTransferRecord> = {},
): FixtureRow {
  serial += 1;
  const threadId = `t-${serial}` as ThreadId;
  const value: HandoffTransferRecord = {
    operationId: `op-${serial}` as never,
    batchId: "batch-1" as never,
    lineage: { sourceEnvironmentId: M4, sourceThreadId: threadId, epoch: 1 },
    projectId: "p1" as ProjectId,
    targetEnvironmentId: MINIS,
    sequence: 3,
    disposition: "resume",
    state,
    legacy: false,
    candidates: [],
    trigger: { kind: "manual" },
    reason: "manual",
    modelSelection: null,
    receipt:
      state === "resumed" || state === "ready"
        ? {
            threadId: `${threadId}-there` as ThreadId,
            machineLabel: "Minis",
            modelSelection: null,
            resumed: state === "resumed",
            notice: null,
          }
        : null,
    detail: null,
    createdAt: "2026-11-19T20:00:00.000Z",
    updatedAt: "2026-11-19T20:00:05.000Z",
    sentAt: state === "sent" || state === "accepted" ? "2026-11-19T20:00:02.000Z" : null,
    ...extra,
  };
  const detail = extra.detail ?? null;
  return {
    ...progressRow(value),
    title,
    expected: {
      ...EXPECTED_BY_INPUT[state],
      reason: state === "stayed" || state === "failed" ? detail : null,
    },
  };
}

export interface HandoffProgressCase {
  readonly key: string;
  /** What the case shows, for the receipt. */
  readonly label: string;
  readonly trigger: HandoffTransferTrigger;
  readonly rows: ReadonlyArray<FixtureRow>;
  readonly incomplete?: boolean;
  readonly trackOut?: HandOffTrackOut;
  readonly rowNotice?: { readonly operationId: string; readonly text: string };
  readonly error?: string;
}

const manual: HandoffTransferTrigger = { kind: "manual" };

function build(): HandoffProgressCase[] {
  serial = 0;
  const heldForNotice = record("held", "Held when the window asked to release it");
  return [
    {
      key: "states",
      label: "one row in each state a transfer record can be in",
      trigger: manual,
      rows: [
        record("pending", "Pending: not held yet"),
        record("held", "Held: paused here, not sent yet"),
        record("sent", "Sent: waiting for Minis"),
        record("accepted", "Accepted: waiting for Minis to start it"),
        record("unknown", "No answer: in doubt"),
        record("resumed", "Resumed on Minis"),
        record("ready", "Installed idle on Minis", { disposition: "ready" }),
        record("stayed", "Stayed here", { detail: STAYS_REASONS[0]!.text }),
        record("failed", "Refused by Minis", {
          detail: "Minis did not take it: the project is not linked there.",
        }),
      ],
    },
    {
      key: "partial",
      label: "a partly successful batch: two arrived, one stayed, one refused, one in doubt",
      trigger: manual,
      rows: [
        record("resumed", "Fix the release build"),
        record("ready", "Write the release notes", { disposition: "ready" }),
        record("stayed", "Migrate settings storage", {
          detail: "Its turn did not stop in 45 seconds, so the thread stays here.",
        }),
        record("failed", "Phone pairing review", {
          detail: "Not moved: Minis no longer lets M4 start work there.",
        }),
        record("sent", "Checkpoint replication tests"),
      ],
      error: "Minis stopped answering while the last thread was sent.",
    },
    {
      key: "stays",
      label: "every reason a thread stays or is refused, one row each",
      trigger: manual,
      rows: STAYS_REASONS.map((reason) =>
        record(reason.state, `Stays: ${reason.name}`, { detail: reason.text }),
      ),
    },
    {
      key: "release-refused",
      label: "Resume here pressed on a hold that is being sent now",
      trigger: manual,
      rows: [heldForNotice, record("resumed", "Fix the release build")],
      rowNotice: {
        operationId: heldForNotice.operationId,
        text: "It is being sent now, so it was not released. Nothing changed.",
      },
    },
    {
      key: "incomplete",
      label: "the machine no longer keeps every record of this hand off",
      trigger: manual,
      rows: [record("resumed", "Fix the release build")],
      incomplete: true,
    },
    {
      key: "automatic",
      label: "an automatic start at a usage limit",
      trigger: { kind: "automatic", reason: "Claude Max limit reached on M4" },
      rows: [
        record("resumed", "Fix the release build", {
          trigger: { kind: "automatic", reason: "Claude Max limit reached on M4" },
        }),
        record("stayed", "Write the release notes", {
          detail: "Hand off automatically is off for this thread.",
        }),
      ],
    },
    {
      key: "track-out",
      label: "the track is out on every machine: nothing moves",
      trigger: { kind: "automatic", reason: "Complex track out" },
      rows: [],
      trackOut: {
        track: "Complex",
        staying: 3,
        resets: [
          { machineLabel: "Minis", resetsAt: "2026-11-19T23:00:00.000Z" },
          { machineLabel: "M5", resetsAt: null },
        ],
      },
    },
    {
      key: "track-out-unknown",
      label: "the track is out and no sign-in reports a reset",
      trigger: { kind: "automatic", reason: "Complex track out" },
      rows: [],
      trackOut: { track: "Complex", staying: 1, resets: [{ machineLabel: "M5", resetsAt: null }] },
    },
  ];
}

export const HANDOFF_PROGRESS_CASES: ReadonlyArray<HandoffProgressCase> = build();

export function handoffProgressCase(key: string | null): HandoffProgressCase {
  return HANDOFF_PROGRESS_CASES.find((entry) => entry.key === key) ?? HANDOFF_PROGRESS_CASES[0]!;
}
