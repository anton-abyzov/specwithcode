/**
 * Pure rules for moving a thread: the per-thread preflight wording the user
 * reads ("Minis: no .env.local"), whether the destination resumes the turn,
 * and the opening message a resumed turn starts from.
 */
import {
  type HandoffCheckpoint,
  type HandoffPreflightFailure,
  type HandoffRunEnding,
  isResumableHandoffEnding,
  type ModelSelection,
  PROVIDER_DISPLAY_NAMES,
} from "@specweave-studio/contracts";

export const HANDOFF_SEED_MAX_CHARS = 3500;
export const HANDOFF_CONTINUE_TEXT = "Continue where you left off.";

export interface PreflightProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly authStatus: "authenticated" | "unauthenticated" | "unknown";
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly aliases?: ReadonlyArray<string>;
  }>;
}

export interface PreflightFacts {
  readonly machineLabel: string;
  /** The local project explicitly linked to the source project; never matched by name. */
  readonly project: { readonly title: string; readonly inGrant: boolean } | null;
  /** The destination's newest replicated checkpoint for the thread, if any. */
  readonly checkpointSequence: number | null;
  readonly requiredSequence: number;
  /** Required ignored files (.env.local) the destination project does not hold. */
  readonly missingFiles: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly provider: PreflightProvider | null;
  /** Another machine, not the source, holds the newest lease this machine knows. */
  readonly otherHolder: string | null;
}

export function providerName(provider: {
  readonly driver: string;
  readonly displayName?: string | undefined;
}): string {
  return (
    provider.displayName ??
    (PROVIDER_DISPLAY_NAMES as Readonly<Record<string, string | undefined>>)[provider.driver] ??
    provider.driver
  );
}

/** Every check that fails, worded for the user and prefixed with the machine. */
export function preflightFailures(facts: PreflightFacts): Array<HandoffPreflightFailure> {
  const at = (message: string) => `${facts.machineLabel}: ${message}`;
  const failures: Array<HandoffPreflightFailure> = [];
  if (facts.project === null) {
    failures.push({ check: "project-link", message: at("this project is not linked here") });
  } else if (!facts.project.inGrant) {
    failures.push({ check: "grant", message: at(`no work grant for ${facts.project.title}`) });
  }
  if (facts.checkpointSequence === null || facts.checkpointSequence < facts.requiredSequence) {
    failures.push({ check: "checkpoint", message: at("no checkpoint for this thread") });
  }
  for (const path of facts.missingFiles) {
    failures.push({ check: "ignored-files", message: at(`no ${path}`) });
  }
  const provider = facts.provider;
  if (provider === null) {
    failures.push({
      check: "provider",
      message: at(`${facts.modelSelection.instanceId} is not set up`),
    });
  } else {
    const name = providerName(provider);
    if (!provider.installed) {
      failures.push({ check: "provider", message: at(`${name} not installed`) });
    } else if (!provider.enabled) {
      failures.push({ check: "provider", message: at(`${name} is off`) });
    } else if (provider.authStatus === "unauthenticated") {
      failures.push({ check: "provider", message: at(`${name} not signed in`) });
    } else if (
      provider.models.length > 0 &&
      !provider.models.some(
        (model) =>
          model.slug === facts.modelSelection.model ||
          (model.aliases ?? []).includes(facts.modelSelection.model),
      )
    ) {
      failures.push({
        check: "model",
        message: at(`model ${facts.modelSelection.model} not available on ${name}`),
      });
    }
  }
  if (facts.otherHolder !== null) {
    failures.push({
      check: "lease",
      message: at(`another machine (${facts.otherHolder}) runs this thread`),
    });
  }
  return failures;
}

/** A user Stop is final; completed, cancelled and failed runs never restart. */
export function shouldResume(ending: HandoffRunEnding): boolean {
  return isResumableHandoffEnding(ending);
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  handoff: "handed off",
  "machine-handoff": "handed off with its machine",
  sleep: "moved here when that machine went to sleep",
  "continue-here": "continued here",
  "auto-takeover": "taken over after that machine stopped answering",
};

/**
 * The opening message of a resumed turn: a fresh provider session seeded
 * from the portable checkpoint, not a migrated process. Lists the side
 * effects already done so the new session reuses them.
 */
export function handoffSeed(input: {
  readonly sourceLabel: string;
  readonly reason: string;
  readonly checkpoint: Pick<
    HandoffCheckpoint,
    "note" | "branch" | "commit" | "sideEffects" | "runEnding" | "skipped"
  >;
  readonly lastMessages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): string {
  const checkpoint = input.checkpoint;
  const lines: Array<string> = [
    HANDOFF_CONTINUE_TEXT,
    "",
    `This thread was ${REASON_TEXT[input.reason] ?? "handed off"} from ${input.sourceLabel}${
      checkpoint.runEnding === "usage-limit" ? " after its usage limit was reached" : ""
    }. Its working tree is checked out here at ${checkpoint.commit.slice(0, 12)}${
      checkpoint.branch === null ? "" : ` (branch ${checkpoint.branch})`
    }.`,
  ];
  if (checkpoint.note !== null) {
    if (checkpoint.note.done.length > 0) lines.push("", `Done: ${checkpoint.note.done}`);
    if (checkpoint.note.next.length > 0) lines.push("", `Next: ${checkpoint.note.next}`);
    if (checkpoint.note.openQuestions.length > 0) {
      lines.push("", `Open questions: ${checkpoint.note.openQuestions}`);
    }
  }
  if (checkpoint.sideEffects.length > 0) {
    lines.push("", "Do not repeat these; they are already done:");
    for (const effect of checkpoint.sideEffects.slice(-20)) {
      lines.push(`- ${effect.kind} ${effect.target}${effect.result ? ` (${effect.result})` : ""}`);
    }
  }
  if (checkpoint.skipped.length > 0) {
    lines.push(
      "",
      `Not carried over: ${checkpoint.skipped
        .slice(0, 10)
        .map((file) => file.path)
        .join(", ")}.`,
    );
  }
  const head = lines.join("\n");
  const budget = HANDOFF_SEED_MAX_CHARS - head.length - 40;
  const tail: Array<string> = [];
  let used = 0;
  for (const message of input.lastMessages.toReversed().slice(0, 4)) {
    const text = message.text.length > 600 ? `${message.text.slice(0, 599)}…` : message.text;
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
    if (used + line.length + 2 > budget) break;
    tail.unshift(line);
    used += line.length + 2;
  }
  const out = tail.length === 0 ? head : `${head}\n\nLast messages:\n${tail.join("\n\n")}`;
  return out.length > HANDOFF_SEED_MAX_CHARS ? `${out.slice(0, HANDOFF_SEED_MAX_CHARS - 1)}…` : out;
}
