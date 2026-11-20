import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * The "Set up SpecWeave" card's states (1396 AC-05):
 * asking; setting up; on ("Open the Board"); failed (reason, Retry); Node.js
 * missing (reason, "Install Node.js"); not allowed (reason); declined.
 */
export const SpecweaveSetupRequestState = Schema.Literals([
  "asking",
  "setting_up",
  "on",
  "failed",
  "node_missing",
  "not_allowed",
  "declined",
]);
export type SpecweaveSetupRequestState = typeof SpecweaveSetupRequestState.Type;

/** One project's open card, shown in the thread that asked for a plan. */
export const SpecweaveSetupRequest = Schema.Struct({
  requestId: Schema.String,
  threadId: ThreadId,
  state: SpecweaveSetupRequestState,
  /** The folder was in a Git work tree when asked: false shows "Set up Git and SpecWeave". */
  gitRepository: Schema.Boolean,
  /** The reason in the failed, Node.js missing and not allowed states. */
  detail: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpecweaveSetupRequest = typeof SpecweaveSetupRequest.Type;

/** The launch tools' result when a plan needs SpecWeave first (AC-06). */
export const SPECWEAVE_NEEDED_MESSAGE =
  "SpecWeave is not set up in this project. The user has a card to set it up. End your turn; their answer wakes you.";

/** The thread's wake-up after a successful setup from the card (AC-07). */
export const SPECWEAVE_SET_UP_WAKE =
  'SpecWeave is set up in this project. Plan the work now: launch it with increment "new".';

/** The thread's wake-up after "Plan without it" (AC-07). */
export const SPECWEAVE_DECLINED_WAKE =
  "The user chose to plan without SpecWeave. Create no increment. Plan the work in your reply before you edit code.";

/**
 * A launch tool's answer when the plan needs SpecWeave first: no thread was
 * started, and the user has a card to set it up (AC-06).
 */
export const SpecweaveNeededLaunchResult = Schema.Struct({
  launched: Schema.Literal(false),
  needs: Schema.Literal("specweave"),
  message: Schema.String,
  /** The card the user sees; absent when it could not be stored. */
  specweaveSetupRequest: Schema.optional(SpecweaveSetupRequest),
});
export type SpecweaveNeededLaunchResult = typeof SpecweaveNeededLaunchResult.Type;

/** `request_specweave_setup`: an agent asks the user to set SpecWeave up. */
export const RequestSpecweaveSetupInput = Schema.Struct({
  /** Omitted inside a project thread: that thread's project. */
  projectId: Schema.optional(ProjectId),
  /**
   * The user asked for a plan, a spec or an increment in so many words. Raises
   * the card even after the user chose "Plan without it".
   */
  askedByUser: Schema.optional(Schema.Boolean),
});
export type RequestSpecweaveSetupInput = typeof RequestSpecweaveSetupInput.Type;

export const RequestSpecweaveSetupResult = Schema.Struct({
  /** A card is open for the user (new or already open). */
  raised: Schema.Boolean,
  /** The project's SpecWeave state when asked. */
  state: Schema.Literals(["on", "unfinished", "off"]),
  message: Schema.String,
  specweaveSetupRequest: Schema.optional(SpecweaveSetupRequest),
});
export type RequestSpecweaveSetupResult = typeof RequestSpecweaveSetupResult.Type;

/** The orchestration line and the launch tools' description (AC-06). */
export const SPECWEAVE_SETUP_INSTRUCTION =
  "In a project without SpecWeave, when the user asks for a plan, a spec or an increment, call request_specweave_setup and end your turn; never run `specweave create-increment` there.";
