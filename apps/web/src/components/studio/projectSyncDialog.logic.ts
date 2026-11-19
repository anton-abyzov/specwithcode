/**
 * What the Sync dialog shows, worked out from what the two machines answer. Sync is Git
 * first: each machine fetches from its remote and fast-forwards. The plan is the contract's
 * (`planProjectSync`); this file only turns steps, extras and results into rows and words.
 * Kept free of UI imports so the dialog, its fixture and tests share one rule.
 *
 * Every sentence here is a whole English phrase with `{slot}` values, translated where it
 * is shown. A value Git or another machine wrote (a reason, a branch) is passed as a slot.
 *
 * @module projectSyncDialog.logic
 */
import {
  PROJECT_SYNC_RPC_METHODS,
  planProjectSync,
  PROJECT_SYNC_MAX_LISTED,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  projectSyncUpstreamGoneDetail,
  type ProjectSyncExtraItem,
  type ProjectSyncExtraResult,
  type ProjectSyncFetchResult,
  type ProjectSyncInventoryResult,
  type ProjectSyncLeftOutFile,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncRepositoryExtras,
  type ProjectSyncRunInput,
  type ProjectSyncStatusResult,
  type ProjectSyncStep,
  type ProjectSyncStepResult,
} from "@specweave-studio/contracts";

/** Words on a row: an English phrase and its `{slot}` values, translated where shown. */
export interface SyncText {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
  /** Slots that hold a branch or file name and are shown in the code font. */
  readonly code?: readonly string[];
}

/** The two machines of one sync, in the order the title names them. */
export type SyncSide = "a" | "b";
export const otherSide = (side: SyncSide): SyncSide => (side === "a" ? "b" : "a");

const count = (n: number, one: string, many: string, values: Record<string, string> = {}) =>
  n === 1 ? { text: one, values } : { text: many, values: { ...values, n: String(n) } };

/** A reason as a slot: no trailing period, because the sentence around it has its own. */
const reasonSlot = (detail: string | null) => (detail ?? "").trim().replace(/[.\s]+$/u, "");

// ---------------------------------------------------------------------------
// Failures of a whole machine
// ---------------------------------------------------------------------------

export type SyncFailureKind =
  | "needs-update"
  | "offline"
  | "read-only"
  | "not-found"
  | "personal"
  | "not-git"
  | "unreadable"
  /** The window may no longer sync this pair: the line is the menu's own reason. */
  | "blocked"
  | "failed";

export interface SyncFailure {
  readonly kind: SyncFailureKind;
  readonly line: SyncText;
}

const tagOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null ? (cause as { _tag?: unknown })._tag : undefined;
const messageOf = (cause: unknown) =>
  typeof cause === "string"
    ? cause
    : typeof cause === "object" && cause !== null
      ? String((cause as { reason?: unknown; message?: unknown }).reason ?? "") ||
        String((cause as { message?: unknown }).message ?? "")
      : "";

const SYNC_CALLS = new Set<string>(Object.values(PROJECT_SYNC_RPC_METHODS));
const UNKNOWN_CALL = /^Unknown request tag: (\S+)$/u;

/**
 * A server from before Sync does not know the call: the answer is a defect that is exactly
 * the text naming one of Sync's own calls, as a string or a plain error. A typed failure
 * that happens to hold those words is not one. Nothing else means "needs update".
 */
export const isUnknownSyncCall = (cause: unknown): boolean => {
  const text =
    typeof cause === "string"
      ? cause
      : cause instanceof Error && tagOf(cause) === undefined
        ? cause.message
        : null;
  const call = text === null ? null : UNKNOWN_CALL.exec(text.trim());
  return call !== null && SYNC_CALLS.has(call[1]!);
};

/** Why one machine could not take part, in the order the causes are told apart. */
export function syncFailure(cause: unknown, machine: string): SyncFailure {
  if (isUnknownSyncCall(cause))
    return {
      kind: "needs-update",
      line: {
        text: 'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.',
        values: { machine },
      },
    };
  const tag = tagOf(cause);
  // An answer with a value this version's contract does not list fails to decode as a whole.
  if (tag === "SchemaError")
    return {
      kind: "unreadable",
      line: {
        text: "{machine} answered in a way this version does not read. Update SpecWithCode on this machine, then check again.",
        values: { machine },
      },
    };
  if (tag === "EnvironmentRpcUnavailableError")
    return {
      kind: "offline",
      line: {
        text: "{machine} is offline. Sync needs both machines connected.",
        values: { machine },
      },
    };
  if (tag === "EnvironmentAuthorizationError")
    return {
      kind: "read-only",
      line: {
        text: "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.",
        values: { machine },
      },
    };
  if (tag === "ProjectSyncError") {
    const code = (cause as { code?: unknown }).code;
    if (code === "not_found")
      return {
        kind: "not-found",
        line: { text: "{machine} does not have this project.", values: { machine } },
      };
    if (code === "personal")
      return {
        kind: "personal",
        line: { text: "A personal project is not synced between machines." },
      };
    if (code === "invalid")
      return {
        kind: "not-git",
        line: {
          text: 'The project folder on {machine} is not a Git repository. Use "Compare all files…".',
          values: { machine },
        },
      };
  }
  const reason = reasonSlot(messageOf(cause));
  return {
    kind: "failed",
    line: reason
      ? {
          text: "{machine} could not sync: {reason}.",
          values: { machine, reason },
        }
      : {
          text: "{machine} did not answer. Check the connection, then check again.",
          values: { machine },
        },
  };
}

// ---------------------------------------------------------------------------
// One repository on one machine: what Sync does there, and says
// ---------------------------------------------------------------------------

/** moves: Sync changes it. done: nothing to do or it was done. held: left alone, with why. */
export type StepTone = "moves" | "done" | "held" | "failed";

export interface StepLine {
  readonly tone: StepTone;
  /** The one sentence of the state's row (AC-11). */
  readonly sentence: SyncText;
  /** Facts the sentence does not state: uncommitted files, a thread at work, a late change. */
  readonly facts: readonly SyncText[];
  /** Git's or the setting's own words, shown as they came; null when the sentence holds them. */
  readonly detail: string | null;
}

/** What a machine said of a checkout's upstream; an older machine sends only `upstream`. */
export type UpstreamFacts = Pick<
  ProjectSyncRepositoryFacts,
  "upstream" | "otherUpstream" | "upstreamGone" | "unreadDetail"
>;

/**
 * Sentences a machine sends as a refusal's `detail` with no reason of their own. One that
 * is known is shown translated; any other is shown as it came.
 */
const ORIGIN_NOT_ASKED = "origin could not be asked whether the branch is still there.";
const CLONE_LEFTOVER =
  "A clone that was stopped left this folder behind, and it could not be removed.";
/** The machine's own English, matched and never shown translated as it is. */
export const KNOWN_REFUSAL_DETAILS: readonly string[] = [ORIGIN_NOT_ASKED, CLONE_LEFTOVER];

/** Two lines say the same thing when only case, spacing or a closing period differ. */
const sameWords = (text: string) =>
  text.trim().replace(/\.$/u, "").replace(/\s+/gu, " ").toLowerCase();

const uncommittedFact = (n: number) => count(n, "1 uncommitted file", "{n} uncommitted files");

/**
 * The sentence for a step, before it runs ("plan") or after ("result"). A step that is
 * level with its upstream reads "Up to date" also while it has uncommitted files or a
 * running thread, so those two facts are added to every step whose sentence does not
 * already state them: a bare "Up to date" is never shown for such a checkout.
 */
export function stepLine(
  step: ProjectSyncStep,
  phase: "plan" | "result",
  ran: {
    readonly moved: number;
    readonly downgraded: boolean;
    readonly movedUnverified?: boolean | undefined;
  } | null = null,
  upstream: UpstreamFacts | null = null,
): StepLine {
  const facts: SyncText[] = [];
  // Git was asked to move it and the outcome could not be read: never "moved", never "not moved".
  const unverified = phase === "result" && ran?.movedUnverified === true;
  // A refusal says its own reason: Git refusing a merge or a clone is no change of the plan.
  if (ran?.downgraded && step.reason !== "refused" && !unverified)
    facts.push({ text: "Changed since the plan" });
  if (step.uncommitted > 0 && step.reason !== "uncommitted")
    facts.push(uncommittedFact(step.uncommitted));
  if (step.inUseBy !== null && step.reason !== "in-use")
    facts.push({ text: "In use by {thread}", values: { thread: step.inUseBy } });
  // What the machine sent beside the step goes under the sentence as sent, for every reason.
  // A case passes null only where its sentence already carries those words, and a detail
  // that repeats what the row says is not shown twice.
  const line = (
    tone: StepTone,
    sentence: SyncText,
    detail: string | null = step.detail,
  ): StepLine => {
    const said = [sentence, ...facts].map((text) => sameWords(readSyncText(text)));
    const sent = detail?.trim() ? detail : null;
    return {
      tone,
      sentence,
      facts,
      detail: sent !== null && said.includes(sameWords(sent)) ? null : sent,
    };
  };
  const remote = step.remote ?? "";
  if (unverified)
    return line(
      "failed",
      {
        text: "May have moved forward: the result could not be read. Check it before working in it",
      },
      step.detail === PROJECT_SYNC_UNVERIFIED_DETAIL ? null : step.detail,
    );
  switch (step.reason) {
    case "behind": {
      // A result names what moved; a plan names what the fetch found.
      const n = phase === "result" ? (ran?.moved ?? 0) : step.behind;
      // Nothing moved, or the machine could not read where the checkout ended: never "Moved
      // forward". What it sent says why.
      if (phase === "result" && n <= 0) return line("held", { text: "Not moved" });
      return phase === "result"
        ? line("done", count(n, "Moved forward 1 commit", "Moved forward {n} commits"))
        : line("moves", count(n, "Moves forward 1 commit", "Moves forward {n} commits"));
    }
    case "missing":
      return phase === "result"
        ? line("done", { text: "Cloned from {remote}", values: { remote } })
        : line("moves", { text: "Clones it from {remote}", values: { remote } });
    case "up-to-date":
      return line("done", { text: "Up to date" });
    case "not-pushed":
      return line(
        "held",
        count(
          step.ahead,
          "1 commit not pushed (listed as an extra)",
          "{n} commits not pushed (listed as an extra)",
        ),
      );
    case "diverged": {
      const values = { a: String(step.ahead), b: String(step.behind) };
      const text =
        step.ahead === 1
          ? "Has 1 commit of its own and is {b} behind. Not moved"
          : "Has {a} commits of its own and is {b} behind. Not moved";
      return line("held", { text, values: step.ahead === 1 ? { b: values.b } : values });
    }
    case "uncommitted":
      // Nothing of the checkout is known: it is held, and the machine's own sentence says why.
      if (step.detail === PROJECT_SYNC_STATE_UNREAD_DETAIL)
        return line("held", { text: "Not moved: its state could not be read" }, null);
      if (upstream?.unreadDetail != null)
        return line("held", { text: "Could not be read. Not moved" });
      // No count: the machine could not read the checkout's state, and says so itself.
      if (step.uncommitted <= 0)
        return line(
          "held",
          step.detail?.trim()
            ? { text: "Not moved" }
            : { text: "Not moved: its state could not be read" },
        );
      return line(
        "held",
        count(
          step.uncommitted,
          "Not moved forward: 1 uncommitted file",
          "Not moved forward: {n} uncommitted files",
        ),
      );
    case "in-use":
      return line("held", { text: "In use by {thread}", values: { thread: step.inUseBy ?? "" } });
    case "other-branch":
      return line("held", {
        text: "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out",
        values: { branch: step.branch ?? "" },
        code: ["branch"],
      });
    case "detached":
      return line("held", { text: "Not on a branch. Not moved" });
    case "no-upstream": {
      // Which of the two it is comes from the machine's facts, never from its English.
      const other = upstream?.otherUpstream ?? null;
      if (other !== null)
        return line(
          "held",
          {
            text: "Follows {name}, which is not a branch of origin. Not moved",
            values: { name: other },
            code: ["name"],
          },
          null,
        );
      const tracked = upstream?.upstream ?? null;
      // Found gone by the fetch, or by the question Sync asks right before it moves.
      if (
        tracked !== null &&
        (upstream?.upstreamGone === true || step.detail === projectSyncUpstreamGoneDetail(tracked))
      )
        return line(
          "held",
          {
            text: "{upstream} is no longer on origin. Not moved",
            values: { upstream: tracked },
            code: ["upstream"],
          },
          null,
        );
      // Any other reason a machine gives for counting an upstream as none goes below as sent.
      return line("held", { text: "No upstream. Its commits are listed as an extra" });
    }
    case "fetch-failed":
      return line(
        "failed",
        reasonSlot(step.detail)
          ? {
              text: "Could not fetch: {reason}. The other repositories continue",
              values: { reason: reasonSlot(step.detail) },
            }
          : { text: "Could not fetch. The other repositories continue" },
        // The reason is in the sentence.
        null,
      );
    case "no-remote":
    case "missing-no-remote":
      return line("held", { text: 'Not in Git on a remote. Use "Compare all files…"' });
    case "fetch-config":
      return line("held", {
        text: "Not fetched: this repository mirrors its remote, and a fetch would move its branches",
      });
    case "refused":
      if (step.detail === ORIGIN_NOT_ASKED)
        return line(
          "failed",
          {
            text: "Sync did not change it: origin could not be asked whether the branch is still there",
          },
          null,
        );
      return line(
        "failed",
        reasonSlot(step.detail)
          ? {
              text: "Sync did not change it: {reason}",
              values: { reason: reasonSlot(step.detail) },
            }
          : { text: "Sync did not change it" },
        // The reason is in the sentence.
        null,
      );
    default:
      // A reason from a newer server: say what it sent, never a guess.
      return line("held", { text: "Not moved" }, step.detail ?? String(step.reason));
  }
}

/** Every word of a line as one English string, for tests and for screen readers. */
export const readSyncText = (text: SyncText) =>
  text.text.replace(/\{(\w+)\}/gu, (slot, name: string) => text.values?.[name] ?? slot);
export const readStepLine = (line: StepLine) =>
  [line.sentence, ...line.facts].map(readSyncText).join(" · ");

// ---------------------------------------------------------------------------
// The plan: a row per repository, a cell per machine
// ---------------------------------------------------------------------------

export interface SyncNames {
  readonly project: string;
  readonly a: string;
  readonly b: string;
}

export interface SyncCell {
  /** False when the repository is missing on this machine. */
  readonly present: boolean;
  readonly branch: string | null;
  readonly step: ProjectSyncStep;
  /** What the machine said of the upstream; null where the repository is missing. */
  readonly upstream: UpstreamFacts | null;
  readonly line: StepLine;
}

export interface SyncRow {
  readonly path: string;
  /** The repository's name as shown: the project for its own folder, else the path. */
  readonly name: string;
  readonly a: SyncCell;
  readonly b: SyncCell;
}

export interface SyncPlan {
  readonly rows: readonly SyncRow[];
  readonly steps: Readonly<Record<SyncSide, readonly ProjectSyncStep[]>>;
  /** Machines whose folder could not be scanned in full: only the top repository is listed. */
  readonly scanLimited: readonly SyncSide[];
  /** Whether any repository would be moved forward or cloned. */
  readonly moves: boolean;
  /**
   * The fetch each machine's run goes by, from that machine's own fetch answer. Null where
   * the machine sent none or does not move by the guarded fast-forward: it is never asked to
   * move anything, and its rows say it needs an update.
   */
  readonly fetchIds: Readonly<Record<SyncSide, string | null>>;
}

export const repositoryName = (path: string, project: string) => (path === "." ? project : path);

const sortPaths = (paths: Iterable<string>) =>
  [...new Set(paths)].toSorted((left, right) =>
    left === "." ? -1 : right === "." ? 1 : left.localeCompare(right),
  );

/** The plan both machines' fetches lead to. Each machine plans against the other's branch. */
export function syncPlan(
  fetched: Readonly<Record<SyncSide, ProjectSyncFetchResult>>,
  names: SyncNames,
): SyncPlan {
  const fetchIds = {
    a: guardedFetchId(fetched.a),
    b: guardedFetchId(fetched.b),
  };
  // Without its own fetch to go by, a machine fetches only: nothing there is moved or cloned.
  const fetchOnly = (side: SyncSide, list: readonly ProjectSyncStep[]) =>
    fetchIds[side] !== null
      ? list
      : list.map((step) =>
          step.action === "fast-forward" || step.action === "clone"
            ? { ...step, action: "fetch" as const }
            : step,
        );
  const planned = {
    a: planProjectSync(fetched.a.repositories, fetched.b.repositories),
    b: planProjectSync(fetched.b.repositories, fetched.a.repositories),
  };
  const needsUpdate = {
    a: new Set(fetchIds.a === null ? planned.a.filter(moving).map((step) => step.path) : []),
    b: new Set(fetchIds.b === null ? planned.b.filter(moving).map((step) => step.path) : []),
  };
  const steps = { a: fetchOnly("a", planned.a), b: fetchOnly("b", planned.b) };
  const held = {
    a: new Set(fetched.a.repositories.map((item) => item.path)),
    b: new Set(fetched.b.repositories.map((item) => item.path)),
  };
  const byPath = {
    a: new Map(steps.a.map((step) => [step.path, step])),
    b: new Map(steps.b.map((step) => [step.path, step])),
  };
  const cell = (side: SyncSide, path: string): SyncCell | null => {
    const step = byPath[side].get(path);
    if (!step) return null;
    const upstream = fetched[side].repositories.find((item) => item.path === path) ?? null;
    return {
      present: held[side].has(path),
      branch: step.branch,
      step,
      upstream,
      line: needsUpdate[side].has(path)
        ? {
            tone: "held",
            sentence: {
              text:
                planned[side].find((item) => item.path === path)?.action === "clone"
                  ? "Needs update: not cloned"
                  : "Needs update: fetched only, not moved forward",
            },
            facts: [],
            detail: null,
          }
        : stepLine(step, "plan", null, upstream),
    };
  };
  const rows: SyncRow[] = [];
  for (const path of sortPaths([...byPath.a.keys(), ...byPath.b.keys()])) {
    const a = cell("a", path);
    const b = cell("b", path);
    if (a && b) rows.push({ path, name: repositoryName(path, names.project), a, b });
  }
  return {
    rows,
    steps,
    scanLimited: (["a", "b"] as const).filter((side) => fetched[side].scanLimited),
    moves: [...steps.a, ...steps.b].some(moving),
    fetchIds,
  };
}

const moving = (step: ProjectSyncStep) => step.action === "fast-forward" || step.action === "clone";

/** The fetch id a run may go by: only from a machine that moves by the guarded fast-forward. */
const guardedFetchId = (answer: ProjectSyncFetchResult): string | null =>
  answer.guardedFastForward === true && answer.fetchId ? answer.fetchId : null;

/**
 * What the result's title may claim. "in-sync": every repository ended as a synced one and
 * nothing else is known to differ. "finished": Git is level, yet a checkout has uncommitted
 * files or a thread at work, a folder was not scanned in full, or work Git does not carry
 * is still on one machine. "open": something was not moved, not sent or not answered.
 */
export type SyncResultTitle = "in-sync" | "finished" | "open";

export function syncResultTitle(input: {
  readonly rows: readonly SyncResultRow[];
  readonly scanLimited: boolean;
  /** A machine did not run its part, an extra stayed or was not sent, or a folder was left. */
  readonly failed: boolean;
  /** Work is still listed under "Only on {machine}", or a machine's list could not be read. */
  readonly workRemains: boolean;
  /** Both machines answered after the run, and the answers match (`statusesProveInSync`). */
  readonly proven: boolean;
}): SyncResultTitle {
  const cells = input.rows.flatMap((row) => [row.a, row.b]);
  if (input.failed || cells.some((cell) => !cell.done)) return "open";
  // Done steps prove nothing about equal checkouts: a clone lands on the default branch, and
  // two fast-forwards can follow different upstreams. Something a machine said beside a
  // step, such as a state it could not read, also keeps the title from claiming it.
  return input.proven &&
    !input.scanLimited &&
    !input.workRemains &&
    cells.every((cell) => cell.line.facts.length === 0 && cell.line.detail === null)
    ? "in-sync"
    : "finished";
}

/**
 * Whether two statuses read after a run prove the machines are in sync: the same
 * repositories, each on the same branch at the same commit, with nothing uncommitted, and
 * both folders scanned in full. A status that did not come proves nothing.
 */
/** The paths a machine's status says it could not read; none without a status. */
export const unreadPaths = (status: ProjectSyncStatusResult | null): ReadonlySet<string> =>
  new Set(status?.repositories.filter((item) => item.unread === true).map((item) => item.path));

export function statusesProveInSync(
  a: ProjectSyncStatusResult | null,
  b: ProjectSyncStatusResult | null,
  /** Every repository the result shows: each needs a fresh read on both machines. */
  shown: readonly string[],
): boolean {
  if (!a || !b || a.scanLimited || b.scanLimited) return false;
  const here = new Map(a.repositories.map((item) => [item.path, item]));
  const there = new Map(b.repositories.map((item) => [item.path, item]));
  // A path listed twice, or on one machine only, is not a read of that repository on both.
  if (here.size === 0 || here.size !== a.repositories.length) return false;
  if (there.size !== b.repositories.length || there.size !== here.size) return false;
  if (!shown.every((path) => here.has(path) && there.has(path))) return false;
  return a.repositories.every((mine) => {
    const other = there.get(mine.path);
    return (
      other !== undefined &&
      mine.branch !== null &&
      mine.branch === other.branch &&
      mine.head !== null &&
      mine.head === other.head &&
      mine.clean &&
      other.clean &&
      mine.unread !== true &&
      other.unread !== true
    );
  });
}

/** Whether a machine still has work Git does not carry after its ticked extras were sent. */
export const extrasRemain = (
  extras: SyncExtras,
  ticked: ReadonlySet<string>,
  allSent: boolean,
): boolean => extras.lines.some((line) => !(line.tickable && ticked.has(line.id) && allSent));

/** A folder a machine reports that is no repository of the plan, such as a stopped clone's. */
export interface SyncLeftover {
  readonly side: SyncSide;
  readonly path: string;
  readonly sentence: SyncText;
}

/** Answers for folders outside the plan: a result is never dropped for having no row. */
export function syncLeftovers(
  plan: SyncPlan,
  ran: Readonly<
    Record<SyncSide, { readonly results: readonly ProjectSyncStepResult[] | null } | null>
  >,
): SyncLeftover[] {
  const out: SyncLeftover[] = [];
  for (const side of ["a", "b"] as const) {
    const planned = new Set(plan.steps[side].map((step) => step.path));
    for (const answer of ran[side]?.results ?? []) {
      if (planned.has(answer.path)) continue;
      const values = { path: answer.path };
      const reason = reasonSlot(answer.detail);
      out.push({
        side,
        path: answer.path,
        sentence:
          answer.detail === CLONE_LEFTOVER
            ? {
                text: "A clone that was stopped left {path} behind, and it could not be removed",
                values,
                code: ["path"],
              }
            : reason
              ? { text: "{path}: {reason}", values: { ...values, reason }, code: ["path"] }
              : { text: "{path}: Sync did not change it", values, code: ["path"] },
      });
    }
  }
  return out;
}

/** What one machine is asked to do. It is a proposal: the server reads each repository again. */
export function syncRunInput(
  projectId: ProjectSyncRunInput["projectId"],
  steps: readonly ProjectSyncStep[],
  /** The machine's own fetch. Without one there is no run: a run never goes by none. */
  fetchId: string | null,
): (ProjectSyncRunInput & { readonly fetchId: string }) | null {
  if (fetchId === null) return null;
  return {
    projectId,
    fetchId,
    fastForward: steps
      .filter((step) => step.action === "fast-forward")
      .map((step) => ({ path: step.path, otherBranch: step.otherBranch })),
    clone: steps
      .filter((step) => step.action === "clone" && step.remote !== null)
      .map((step) => ({ path: step.path, remote: step.remote ?? "" })),
  };
}

export const runHasWork = (
  input: ProjectSyncRunInput | null,
): input is ProjectSyncRunInput & {
  readonly fetchId: string;
} =>
  input !== null &&
  input.fetchId !== undefined &&
  (input.fastForward.length > 0 || input.clone.length > 0);

// ---------------------------------------------------------------------------
// Extras: work Git does not carry, listed per machine, each line unticked
// ---------------------------------------------------------------------------

export type ExtraLineKind =
  | "not-pushed"
  | "only-here"
  | "uncommitted"
  | "stashes"
  | "not-listed"
  | "unread"
  | "only-here-unknown";

export interface ExtraLine {
  /** Stable within one machine's list: the tick is kept by it. */
  readonly id: string;
  readonly kind: ExtraLineKind;
  readonly path: string;
  readonly repository: string;
  readonly label: SyncText;
  readonly helper: SyncText | null;
  /** Branch names under a "branches only here" line, shown in the code font. */
  readonly branches: readonly string[];
  /** False for a line that cannot travel: stashes, and branches past the list's end. */
  readonly tickable: boolean;
  /** What the machine said, shown as sent: why a list could not be read. */
  readonly detail?: string | null;
}

export interface LeftOutLine {
  readonly id: string;
  readonly path: string;
  readonly repository: string;
  readonly file: string;
  readonly reason: ProjectSyncLeftOutFile["reason"];
  readonly label: SyncText;
  /** "Send anyway" is offered for a finding in the content and for a file not checked. */
  readonly sendAnyway: boolean;
}

export interface SyncExtras {
  readonly lines: readonly ExtraLine[];
  readonly leftOut: readonly LeftOutLine[];
  /** Left-out files past the end of the list. */
  readonly leftOutNotListed: number;
}

/**
 * The family of branches extras arrive under. The sender names itself and the receiver makes
 * that name safe for Git and may add a suffix, so the exact ref is known only from a receipt:
 * before sending, the name this window shows for a machine is never put into a branch name.
 */
const ARRIVAL_FAMILY = "swc/from-…/";

const repositoryExtras = (
  item: ProjectSyncRepositoryExtras,
  names: { readonly project: string; readonly source: string; readonly target: string },
): { lines: ExtraLine[]; leftOut: LeftOutLine[] } => {
  const repository = repositoryName(item.path, names.project);
  const prefix = ARRIVAL_FAMILY;
  const base = { path: item.path, repository, branches: [] as readonly string[] };
  const lines: ExtraLine[] = [];
  // Nothing of this repository's extras is known: its counts are placeholders, never shown.
  if (item.unreadDetail != null)
    return {
      lines: [
        {
          ...base,
          id: `unread:${item.path}`,
          kind: "unread",
          label: {
            text: "{repository} could not be read: what is only on {machine} is not known",
            values: { repository, machine: names.source },
          },
          helper: null,
          detail: item.unreadDetail,
          tickable: false,
        },
      ],
      leftOut: [],
    };
  // Which branches origin has could not be judged: none is called "only here".
  if (item.onlyHereUnknown === true)
    lines.push({
      ...base,
      id: `only-here-unknown:${item.path}`,
      kind: "only-here-unknown",
      label: {
        text: "Which branches of {repository} are only on {machine} could not be read",
        values: { repository, machine: names.source },
      },
      helper: null,
      tickable: false,
    });
  for (const branch of item.notPushed)
    lines.push({
      ...base,
      id: `not-pushed:${item.path}:${branch.branch}`,
      kind: "not-pushed",
      label: {
        ...count(
          branch.commits,
          "1 commit on {branch} that was never pushed",
          "{n} commits on {branch} that were never pushed",
          { branch: branch.branch },
        ),
        code: ["branch"],
      },
      helper: {
        text: "Sent straight to {target} over the link between the machines, as a branch under {name}. Nothing goes to GitHub.",
        values: { target: names.target, name: prefix },
        code: ["name"],
      },
      tickable: true,
    });
  if (item.onlyHere.length > 0)
    lines.push({
      ...base,
      id: `only-here:${item.path}`,
      kind: "only-here",
      label: count(
        item.onlyHere.length,
        "1 branch that exists only on {machine}",
        "{n} branches that exist only on {machine}",
        { machine: names.source },
      ),
      helper: {
        text: "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.",
        values: { target: names.target, name: prefix },
        code: ["name"],
      },
      branches: item.onlyHere.map((branch) => branch.branch),
      tickable: true,
    });
  const files = item.changedFiles + item.untrackedFiles;
  if (files > 0)
    lines.push({
      ...base,
      id: `uncommitted:${item.path}`,
      kind: "uncommitted",
      label: count(
        files,
        "1 uncommitted file in {repository}",
        "{n} uncommitted files in {repository}",
        { repository },
      ),
      helper: {
        text: "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.",
        values: { target: names.target, source: names.source, name: prefix },
        code: ["name"],
      },
      tickable: true,
    });
  if (item.stashes > 0)
    lines.push({
      ...base,
      id: `stashes:${item.path}`,
      kind: "stashes",
      label: count(item.stashes, "1 stash in {repository}", "{n} stashes in {repository}", {
        repository,
      }),
      helper: { text: "Stashes stay. Compare all files… can bring them" },
      tickable: false,
    });
  if (item.branchesNotListed > 0)
    lines.push({
      ...base,
      id: `not-listed:${item.path}`,
      kind: "not-listed",
      label: count(
        item.branchesNotListed,
        "1 more branch in {repository} is not listed",
        "{n} more branches in {repository} are not listed",
        { repository },
      ),
      helper: null,
      tickable: false,
    });
  const leftOut = item.leftOut.map((file): LeftOutLine => {
    const label: SyncText =
      file.reason === "name"
        ? {
            text: "A secret by its name. It stays on {source}: Sync does not send secrets.",
            values: { source: names.source },
          }
        : file.reason === "content"
          ? file.kind
            ? { text: "Looks like a {kind}", values: { kind: file.kind } }
            : { text: "Looks like a secret" }
          : { text: "Not checked" };
    return {
      id: `left-out:${item.path}:${file.path}`,
      path: item.path,
      repository,
      file: file.path,
      reason: file.reason,
      label,
      // A secret by its name is never sent this way.
      sendAnyway: file.reason !== "name",
    };
  });
  return { lines, leftOut };
};

/** What is only on `source`, as lines a person can tick to send to `target`. */
export function syncExtras(
  inventory: ProjectSyncInventoryResult,
  names: { readonly project: string; readonly source: string; readonly target: string },
): SyncExtras {
  const lines: ExtraLine[] = [];
  const leftOut: LeftOutLine[] = [];
  let leftOutNotListed = 0;
  for (const item of inventory.repositories) {
    const part = repositoryExtras(item, names);
    lines.push(...part.lines);
    leftOut.push(...part.leftOut);
    leftOutNotListed += item.leftOutNotListed;
  }
  return { lines, leftOut, leftOutNotListed };
}

/**
 * The items one machine sends for its ticked lines, in calls of at most the contract's
 * list size. "Send anyway" counts only for files of a repository whose uncommitted work is
 * ticked, and never for a secret by its name.
 */
export function extraItems(
  inventory: ProjectSyncInventoryResult,
  extras: SyncExtras,
  ticked: ReadonlySet<string>,
  sendAnyway: ReadonlySet<string>,
): Array<Array<ProjectSyncExtraItem>> {
  const items: ProjectSyncExtraItem[] = [];
  const byPath = new Map(inventory.repositories.map((item) => [item.path, item]));
  for (const line of extras.lines) {
    if (!line.tickable || !ticked.has(line.id)) continue;
    const repository = byPath.get(line.path);
    if (!repository) continue;
    if (line.kind === "not-pushed") {
      const branch = repository.notPushed.find(
        (item) => `not-pushed:${line.path}:${item.branch}` === line.id,
      );
      if (branch) items.push({ kind: "branch", path: line.path, branch: branch.branch });
    } else if (line.kind === "only-here") {
      for (const branch of repository.onlyHere)
        items.push({ kind: "branch", path: line.path, branch: branch.branch });
    } else if (line.kind === "uncommitted") {
      items.push({
        kind: "uncommitted",
        path: line.path,
        sendAnyway: extras.leftOut
          .filter((file) => file.path === line.path && file.sendAnyway && sendAnyway.has(file.id))
          .map((file) => file.file)
          .slice(0, PROJECT_SYNC_MAX_LISTED),
      });
    }
  }
  const calls: Array<Array<ProjectSyncExtraItem>> = [];
  for (let at = 0; at < items.length; at += PROJECT_SYNC_MAX_LISTED)
    calls.push(items.slice(at, at + PROJECT_SYNC_MAX_LISTED));
  return calls;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface SyncResultCell {
  /** Null when a clone was asked for and no answer came: it may be there or not. */
  readonly present: boolean | null;
  /** The branch the machine's answer names; null also when nobody confirmed one. */
  readonly branch: string | null;
  readonly line: StepLine;
  /** Whether this repository is as Sync leaves a synced one: moved, cloned or up to date. */
  readonly done: boolean;
}

export interface SyncResultRow {
  readonly path: string;
  readonly name: string;
  readonly a: SyncResultCell;
  readonly b: SyncResultCell;
}

/**
 * The result per repository. A step the machine ran reads as its answer; a step that was
 * never sent keeps the plan's sentence, which states where the repository stands; a step
 * that was sent and got no answer says so.
 */
export function syncResultRows(
  plan: SyncPlan,
  ran: Readonly<
    Record<
      SyncSide,
      {
        readonly results: readonly ProjectSyncStepResult[] | null;
        /** False when the call was never made: its rows keep the plan's sentence. */
        readonly sent?: boolean;
      } | null
    >
  >,
  /** Paths each machine's status after the run says it could not read. */
  unread: Readonly<Record<SyncSide, ReadonlySet<string>>> = { a: new Set(), b: new Set() },
): SyncResultRow[] {
  const cell = (side: SyncSide, planned: SyncCell): SyncResultCell => {
    const got = result(side, planned);
    if (!unread[side].has(planned.step.path) || !got.done) return got;
    const answer = ran[side]?.results?.find((item) => item.path === planned.step.path);
    // A move the run confirmed stays a receipt, apart from the state that is unknown now.
    if (answer && (answer.moved > 0 || answer.reason === "missing"))
      return {
        ...got,
        line: {
          ...got.line,
          facts: [...got.line.facts, { text: "Its state could not be read after the run" }],
        },
        done: false,
      };
    return {
      present: got.present,
      branch: null,
      line: {
        tone: "held",
        sentence: { text: "Could not be read. Not moved" },
        facts: [],
        detail: null,
      },
      done: false,
    };
  };
  const result = (side: SyncSide, planned: SyncCell): SyncResultCell => {
    const asked =
      ran[side]?.sent !== false &&
      (planned.step.action === "fast-forward" || planned.step.action === "clone");
    const answer = ran[side]?.results?.find((item) => item.path === planned.step.path);
    if (answer) {
      const line = stepLine(
        answer,
        "result",
        {
          moved: answer.moved,
          downgraded: answer.downgraded,
          movedUnverified: answer.movedUnverified,
        },
        // The branch can go from origin after the fetch: the answer says so, the facts name it.
        planned.upstream,
      );
      return {
        // A clone leaves the repository there, on the branch it checked out.
        present: planned.present || answer.reason === "missing",
        // What the machine read at the run is the truth, also when it is on no branch now.
        branch: answer.branch,
        line,
        done: line.tone === "done",
      };
    }
    if (asked)
      return {
        // A clone may have finished before its answer was lost: unknown, never "Not there".
        present: planned.step.action === "clone" ? null : planned.present,
        branch: null,
        line: {
          tone: "failed",
          // The call failed or timed out; a repository asked before it may have moved.
          sentence: {
            text: 'No answer came for this repository, and it may have moved. "Check again" shows where it stands',
          },
          facts: [],
          detail: null,
        },
        done: false,
      };
    return {
      present: planned.present,
      branch: planned.branch,
      line: planned.line,
      done: planned.line.tone === "done",
    };
  };
  return plan.rows.map((row) => ({
    path: row.path,
    name: row.name,
    a: cell("a", row.a),
    b: cell("b", row.b),
  }));
}

/**
 * sent: a receipt says it arrived. stays: a receipt says it did not travel, with why.
 * unknown: it was sent and no answer came back, so it may have arrived. not-sent: it never
 * left the machine.
 */
export type ExtraResultState = "sent" | "stays" | "unknown" | "not-sent";

export interface ExtraResultLine {
  readonly state: ExtraResultState;
  /** What was asked for: a branch name, or null for uncommitted work. */
  readonly branch: string | null;
  readonly repository: string;
  readonly sentence: SyncText;
  readonly facts: readonly SyncText[];
  /** The size of what travelled, such as "4.1 MB"; null when nothing did. */
  readonly size: string | null;
  /** What the other machine said, shown under the sentence as sent; null when it holds it. */
  readonly detail: string | null;
}

/** Why a send that failed as a whole did or did not leave the machine. */
export function extrasSendOutcome(cause: unknown): "unknown" | "not-sent" {
  // The machine answered before it sent anything: it does not know the call, this window
  // may not ask it, or it refused the request as a whole.
  if (isUnknownSyncCall(cause)) return "not-sent";
  const tag = tagOf(cause);
  if (tag === "EnvironmentAuthorizationError") return "not-sent";
  // No connection to the machine when the call was made: it was never handed over.
  if (tag === "EnvironmentRpcUnavailableError") return "not-sent";
  const code = (cause as { code?: unknown } | null)?.code;
  // Only the refusals known to come before the first send. Any other code may follow one.
  if (
    tag === "ProjectSyncError" &&
    (code === "not_found" || code === "personal" || code === "invalid")
  )
    return "not-sent";
  // Git stopped part way, the link dropped under way or the answer could not be read: it may
  // have arrived.
  return "unknown";
}

const extraKey = (item: {
  readonly kind: string;
  readonly path: string;
  readonly branch?: string | null;
}) => `${item.kind}\u0000${item.path}\u0000${item.branch ?? ""}`;

/**
 * One line per item of a call, in the order asked. An item the reply names reads as its
 * receipt. One it does not name, or a call with no reply (`receipts` null), reads by
 * `without`: "unknown" when the call left the machine, "not-sent" when it never did.
 */
export function extraBatchLines(
  items: readonly ProjectSyncExtraItem[],
  receipts: readonly ProjectSyncExtraResult[] | null,
  names: { readonly project: string; readonly source: string; readonly target: string },
  without: "unknown" | "not-sent",
): ExtraResultLine[] {
  const left = new Map<string, ProjectSyncExtraResult[]>();
  for (const receipt of receipts ?? []) {
    const key = extraKey(receipt);
    left.set(key, [...(left.get(key) ?? []), receipt]);
  }
  const lines = items.map((item): ExtraResultLine => {
    const receipt = left.get(extraKey(item))?.shift();
    if (receipt) return extraResultLine(receipt, names);
    return {
      state: without,
      branch: item.kind === "branch" ? item.branch : null,
      repository: repositoryName(item.path, names.project),
      sentence:
        without === "unknown"
          ? {
              text: "No answer came back. It may have arrived on {target}: check {target} before sending again.",
              values: { target: names.target },
            }
          : { text: "Not sent." },
      facts: [],
      size: null,
      detail: null,
    };
  });
  // A receipt for something that was not asked is still shown: nothing a machine says is dropped.
  for (const rest of left.values())
    for (const receipt of rest) lines.push(extraResultLine(receipt, names));
  return lines;
}

const KNOWN_STAYS = new Set([
  "nothing-to-send",
  "missing-branch",
  "file-too-large",
  "too-many-files",
  "bundle-too-large",
  "needs-update",
  "unreachable",
  "refused",
  "failed",
]);

const megabytes = (bytes: number) =>
  bytes <= 0
    ? null
    : bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** One sent extra: the branch it arrived as and the next step, or why it stays. */
export function extraResultLine(
  result: ProjectSyncExtraResult,
  names: { readonly project: string; readonly source: string; readonly target: string },
): ExtraResultLine {
  const { source, target } = names;
  const repository = repositoryName(result.path, names.project);
  const name = result.arrivedAs ?? "";
  const facts: SyncText[] = [];
  const base = { branch: result.branch, repository };
  // Files the snapshot left out are named whether it arrived or stayed.
  const leftOut = result.leftOut.length + result.leftOutNotListed;
  const leftOutFact = leftOut > 0 ? [count(leftOut, "1 file left out", "{n} files left out")] : [];
  if (result.status === "sent") {
    if (result.includedCommits > 0)
      facts.push({
        ...count(
          result.includedCommits,
          "Includes 1 commit not pushed on {branch}",
          "Includes {n} commits not pushed on {branch}",
          { branch: result.includedBranch ?? "" },
        ),
        code: ["branch"],
      });
    facts.push(...leftOutFact);
    // No branch name came with it: say it was sent, with what the machine said, never "branch .".
    if (name === "")
      return {
        ...base,
        state: "sent",
        detail: null,
        sentence: result.landed
          ? { text: "Sent to {target}: {reason}.", values: { target, reason: result.landed } }
          : { text: "Sent to {target}.", values: { target } },
        facts,
        size: megabytes(result.bytes),
      };
    const sentence: SyncText =
      result.landed === "unchanged"
        ? {
            text: "{target} already has it as branch {name}.",
            values: { target, name },
            code: ["name"],
          }
        : result.landed === "checked-out"
          ? {
              // The answer does not say which branch is checked out there: it is the one
              // this would have arrived as, never the source's own name.
              text: "The branch it would arrive as is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.",
              values: { target, name },
              code: ["name"],
            }
          : result.landed === "beside"
            ? {
                text: "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.",
                values: { target, name },
                code: ["name"],
              }
            : {
                text: "On {target} as branch {name}. To use it there, check it out or merge it.",
                values: { target, name },
                code: ["name"],
              };
    return {
      ...base,
      state: "sent",
      sentence,
      facts,
      size: megabytes(result.bytes),
      detail: null,
    };
  }
  facts.push(...leftOutFact);
  // A reason this version does not know is shown as the machine sent it.
  const detail =
    reasonSlot(result.detail) ||
    (KNOWN_STAYS.has(String(result.stays)) ? "" : String(result.stays ?? ""));
  // `told`: the sentence has no slot for what the other machine said, so it goes under it.
  const stays = (
    text: string,
    values: Record<string, string> = {},
    told = false,
  ): ExtraResultLine => {
    const sentence: SyncText = { text, values: { source, target, ...values } };
    const sent = told && result.detail?.trim() ? result.detail : null;
    return {
      ...base,
      state: "stays",
      sentence,
      facts,
      size: null,
      detail: sent !== null && sameWords(sent) !== sameWords(readSyncText(sentence)) ? sent : null,
    };
  };
  switch (result.stays) {
    case "nothing-to-send":
      return stays("Nothing to send: {target} would get no new work.");
    case "missing-branch":
      return stays("Stays on {source}: the branch is no longer there.");
    case "file-too-large":
    case "too-many-files":
    case "bundle-too-large":
      return detail
        ? stays('Stays on {source}: {reason}. "Compare all files…" can bring it.', {
            reason: detail,
          })
        : stays('Stays on {source}: it is over a size limit. "Compare all files…" can bring it.');
    case "needs-update":
      return stays("Stays on {source}: update SpecWithCode on {target} first.", {}, true);
    case "unreachable": {
      // The source lost its link to the target, perhaps after the target wrote the branch:
      // nobody knows whether it arrived. What the source said goes under it, once.
      const sentence: SyncText = {
        text: "No answer came back. It may have arrived on {target}: check {target} before sending again.",
        values: { target },
      };
      const said = result.detail?.trim() ? result.detail : null;
      return {
        ...base,
        state: "unknown",
        sentence,
        facts,
        size: null,
        detail:
          said !== null && sameWords(said) !== sameWords(readSyncText(sentence)) ? said : null,
      };
    }
    default:
      return detail
        ? stays("Stays on {source}: {reason}.", { reason: detail })
        : stays("Stays on {source}: it could not be sent.");
  }
}
