/**
 * SpecWeave on demand (1396), the parts every surface shares: the card in the
 * thread, the Board tab's off and unfinished states, the line above the
 * composer and the thread's increment label. Pure, so each surface and its
 * tests read the same words and the same rules.
 */
import type {
  ProjectWorkspaceReadResult,
  SpecweaveSetupRequest,
  SpecweaveSetupRequestState,
  SpecweaveState,
} from "@specweave-studio/contracts";

// ── Words ───────────────────────────────────────────────────────────────

export const SPECWEAVE_CARD_HEADING = "Set up SpecWeave to plan this";
export const SPECWEAVE_CARD_TEXT =
  "A plan is a short spec with tasks, kept in your repository. It also puts this project's work on a board.";
/** "What it adds", shown under its disclosure on the card and openly on the Board. */
export const SPECWEAVE_ADDS: ReadonlyArray<string> = [
  ".specweave/",
  "Agent skills in .claude/ and .agents/",
  "Sections in AGENTS.md and CLAUDE.md",
  "Rules in .gitignore and .gitattributes",
];
export const SPECWEAVE_ADDS_LABEL = "What it adds";
export const SPECWEAVE_REVIEW_NOTE = "The new files are left for you to review and commit.";
/** Shown before the press in a folder without Git; the press then sends `initGit`. */
export const SPECWEAVE_GIT_SENTENCE =
  "This folder is not a Git repository yet, so this also starts one here.";
export const SPECWEAVE_PLAN_WITHOUT = "Plan without it";
export const SPECWEAVE_OPEN_BOARD = "Open the Board";
export const SPECWEAVE_INSTALL_NODE = "Install Node.js";
export const SPECWEAVE_RETRY = "Retry";
export const SPECWEAVE_NOT_NOW = "Not now";

export const BOARD_OFF_HEADING = "See this project's work as a board";
export const BOARD_OFF_TEXT =
  "Plans each piece of work as a short spec with tasks in your repository, and gives the project a board.";
export const BOARD_EXAMPLE_LABEL = "Example";

export const BOARD_EMPTY_TEXT = "No work planned yet.";
export const BOARD_EMPTY_ACTION = "Plan the first piece of work";
/** What "Plan the first piece of work" puts in the coordinator's composer. */
export const BOARD_EMPTY_PROMPT =
  "Let's plan the first piece of work for this project. Ask me what it should be, then plan it as an increment.";

export const SPECWEAVE_OFFER_TEXT = "Plan this project's work on a board.";
export const SPECWEAVE_OFFER_SEE_BOARD = "See the board";
export const SPECWEAVE_OFFER_DISMISS = "Dismiss";

export const NOT_ON_BOARD_LABEL = "Not on the board yet";

/** The window may not change files on the machine, so it cannot run setup. */
export const SPECWEAVE_NOT_ALLOWED_WRITE =
  "This window's access cannot change files on this machine. Set SpecWeave up from a window with file access.";
export const SPECWEAVE_FAILED_DEFAULT = "SpecWeave could not be set up in this folder.";
export const SPECWEAVE_NODE_MISSING =
  "SpecWeave needs Node.js, which this machine does not have. Install it here, then press Retry.";
export const SPECWEAVE_SET_UP_DONE = "SpecWeave is set up. This project's work is on the Board.";
export const SPECWEAVE_DECLINED_DONE =
  "Planning without SpecWeave. The Board tab still offers it whenever you want a board.";
export const SPECWEAVE_SETTING_UP = "Setting up SpecWeave…";

/** "Set up SpecWeave", or with Git in a folder that has none; "Finish setup" over the half state. */
export function specweaveSetupLabel(
  kind: "set_up" | "finish",
  gitRepository: boolean | undefined,
): string {
  const withGit = gitRepository === false;
  if (kind === "finish") return withGit ? "Set up Git and finish" : "Finish setup";
  return withGit ? "Set up Git and SpecWeave" : "Set up SpecWeave";
}

// ── The project's state ─────────────────────────────────────────────────

type Snapshot = Pick<
  ProjectWorkspaceReadResult,
  | "specweave"
  | "specweaveState"
  | "specweaveUnfinished"
  | "specweaveSetupFailure"
  | "specweaveDeclined"
  | "specweaveAdviceSeen"
  | "specweaveSetupRequest"
  | "gitRepository"
> & {
  readonly settings: Pick<ProjectWorkspaceReadResult["settings"], "kind"> & {
    readonly origin?: string | undefined;
  };
};

/**
 * The one SpecWeave state of a project. A server older than 1396 sends only
 * the boolean, which reads as on or off; one older still sends nothing.
 */
export function specweaveStateOf(
  snapshot: Pick<Snapshot, "specweave" | "specweaveState"> | null | undefined,
): SpecweaveState | undefined {
  if (!snapshot) return undefined;
  if (snapshot.specweaveState !== undefined) return snapshot.specweaveState;
  if (snapshot.specweave === undefined) return undefined;
  return snapshot.specweave ? "on" : "off";
}

/** The server knows `projects.specweaveAnswer` ("Not now", the composer line): it sends the state. */
export function specweaveAnswersSupported(
  snapshot: Pick<Snapshot, "specweaveState"> | null | undefined,
): boolean {
  return snapshot?.specweaveState !== undefined;
}

// ── A setup press and its outcome ───────────────────────────────────────

/** What this window saw of its own press, until the server's card says more. */
export type SpecweaveLocalOutcome =
  | { readonly state: "setting_up" }
  | {
      readonly state: "failed" | "node_missing" | "not_allowed";
      readonly detail: string;
    };

export interface SpecweaveShownState {
  readonly state: SpecweaveSetupRequestState;
  readonly detail?: string | undefined;
}

/** A failed setup call as the card shows it: Node.js missing, not allowed, or failed with its reason. */
export function specweaveSetupFailureOutcome(cause: unknown): SpecweaveLocalOutcome {
  const fields = typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : {};
  const message =
    cause instanceof Error && cause.message.trim() !== ""
      ? cause.message
      : typeof fields.message === "string" && fields.message.trim() !== ""
        ? fields.message
        : typeof fields.detail === "string" && fields.detail.trim() !== ""
          ? fields.detail
          : SPECWEAVE_FAILED_DEFAULT;
  if (fields._tag === "EnvironmentAuthorizationError")
    return { state: "not_allowed", detail: SPECWEAVE_NOT_ALLOWED_WRITE };
  if (fields.needs === "node") return { state: "node_missing", detail: message };
  return { state: "failed", detail: message };
}

/**
 * The state a card shows. A settled card (On, Declined) is final. Otherwise
 * this window's own press wins until the server's card catches up; a window
 * that cannot change files reads Not allowed instead of offering a press.
 */
export function specweaveCardState(input: {
  readonly request: Pick<SpecweaveSetupRequest, "state" | "detail">;
  readonly local: SpecweaveLocalOutcome | null;
  readonly canWrite: boolean;
}): SpecweaveShownState {
  const { request, local } = input;
  if (request.state === "on" || request.state === "declined") return { state: request.state };
  if (local !== null) return local;
  if (!input.canWrite && request.state !== "setting_up")
    return { state: "not_allowed", detail: SPECWEAVE_NOT_ALLOWED_WRITE };
  return { state: request.state, detail: request.detail };
}

/** The reason line under a card in Failed, Node.js missing or Not allowed. */
export function specweaveStateReason(shown: SpecweaveShownState): string | null {
  switch (shown.state) {
    case "failed":
      return shown.detail?.trim() || SPECWEAVE_FAILED_DEFAULT;
    case "node_missing":
      return SPECWEAVE_NODE_MISSING;
    case "not_allowed":
      return shown.detail?.trim() || SPECWEAVE_NOT_ALLOWED_WRITE;
    default:
      return null;
  }
}

/** While a card reads Setting up, the snapshot is read again every 5 s: no server push exists. */
export const SPECWEAVE_SETTING_UP_POLL_MS = 5_000;

export function specweavePollWhile(state: SpecweaveSetupRequestState | undefined): boolean {
  return state === "setting_up";
}

/**
 * Whether the thread shows the project's card. Open cards always do; a settled
 * one stays under the conversation until the person writes again.
 */
export function specweaveCardShown(input: {
  readonly request: Pick<SpecweaveSetupRequest, "threadId" | "state" | "updatedAt"> | undefined;
  readonly threadId: string | null;
  /** The newest message the person sent in this thread, if any. */
  readonly lastUserMessageAt: string | null;
}): boolean {
  const { request } = input;
  if (request === undefined || input.threadId === null) return false;
  if (request.threadId !== input.threadId) return false;
  if (request.state !== "on" && request.state !== "declined") return true;
  return input.lastUserMessageAt === null || input.lastUserMessageAt <= request.updatedAt;
}

// ── When the snapshot is read again ─────────────────────────────────────

const SNAPSHOT_TOOLS = /^(delegate_task|create_threads|studio_thread_launch|request_specweave_setup)$/;
const SETTLED_ITEM = new Set(["completed", "failed", "cancelled", "interrupted"]);

function bareToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, "");
}

/**
 * A key that changes each time a launch tool or `request_specweave_setup`
 * finishes in the thread. Any of them may have raised the card, so the card
 * reads the snapshot again when it changes.
 */
export function specweaveSnapshotToolKey(
  entries: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
    readonly entry?: {
      readonly structuredPayload?: { readonly type: string; readonly status?: string } & {
        readonly toolName?: string | null;
      };
    };
  }>,
): string {
  let count = 0;
  let last = "";
  for (const row of entries) {
    if (row.kind !== "work") continue;
    const item = row.entry?.structuredPayload;
    if (item?.type !== "dynamic_tool" || !SNAPSHOT_TOOLS.test(bareToolName(item.toolName ?? "")))
      continue;
    if (item.status !== undefined && !SETTLED_ITEM.has(item.status)) continue;
    count += 1;
    last = row.id;
  }
  return count === 0 ? "" : `${count}:${last}`;
}

// ── The Board tab without cards ─────────────────────────────────────────

export type BoardSetupKind = "off" | "unfinished";

export interface BoardSetupCopy {
  readonly heading: string;
  readonly text: string;
  /** The first plans found, with `unfinished`. */
  readonly titles: ReadonlyArray<string>;
  readonly button: string;
}

export function boardSetupCopy(input: {
  readonly kind: BoardSetupKind;
  readonly unfinished?: { readonly count: number; readonly titles: ReadonlyArray<string> } | undefined;
  readonly gitRepository: boolean | undefined;
}): BoardSetupCopy {
  if (input.kind === "off")
    return {
      heading: BOARD_OFF_HEADING,
      text: BOARD_OFF_TEXT,
      titles: [],
      button: specweaveSetupLabel("set_up", input.gitRepository),
    };
  const count = Math.max(1, input.unfinished?.count ?? 1);
  return {
    heading:
      count === 1
        ? "1 plan here is not on the board yet"
        : `${count} plans here are not on the board yet`,
    text:
      count === 1
        ? "It was written before SpecWeave was set up in this project. Finish setup and it shows as a card."
        : "They were written before SpecWeave was set up in this project. Finish setup and they show as cards.",
    titles: (input.unfinished?.titles ?? []).slice(0, 3),
    button: specweaveSetupLabel("finish", input.gitRepository),
  };
}

/** A setup that failed earlier (here, at project creation, anywhere), as the Board first shows it. */
export function boardStoredFailure(
  failure: ProjectWorkspaceReadResult["specweaveSetupFailure"],
): SpecweaveLocalOutcome | null {
  if (failure === undefined) return null;
  return failure.needsNode === true
    ? { state: "node_missing", detail: failure.detail }
    : { state: "failed", detail: failure.detail };
}

/** "Not now" shows only while the person has not declined, and only where the server can store it. */
export function boardOffersNotNow(
  snapshot: Pick<Snapshot, "specweaveState" | "specweaveDeclined"> | null | undefined,
): boolean {
  return specweaveAnswersSupported(snapshot) && snapshot?.specweaveDeclined !== true;
}

// ── The thread's increment label ────────────────────────────────────────

/** "Not on the board yet" beside an increment of a project whose setup is unfinished. */
export function incrementBoardNote(state: SpecweaveState | undefined): string | null {
  return state === "unfinished" ? NOT_ON_BOARD_LABEL : null;
}

/** The newest message the person sent, from the thread's timeline rows. */
export function lastUserMessageAt(
  entries: ReadonlyArray<{
    readonly kind: string;
    readonly createdAt: string;
    readonly message?: { readonly role: string };
  }>,
): string | null {
  let latest: string | null = null;
  for (const row of entries)
    if (row.kind === "message" && row.message?.role === "user")
      if (latest === null || row.createdAt > latest) latest = row.createdAt;
  return latest;
}
