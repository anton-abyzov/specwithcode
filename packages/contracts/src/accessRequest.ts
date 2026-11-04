import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * What an access request asks for. Apps and devices are asked for today;
 * folders and other machines share the card once their gates move onto it.
 */
export const AccessRequestSubjectKind = Schema.Literals(["app", "device", "machine", "folder"]);
export type AccessRequestSubjectKind = typeof AccessRequestSubjectKind.Type;

/** A small PNG of the subject's own icon (an app's), base64 encoded. */
export const AccessRequestIcon = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String.check(Schema.isMaxLength(96_000)),
});
export type AccessRequestIcon = typeof AccessRequestIcon.Type;

/** One thing the agent asks to use, with what it may do with it. */
export const AccessRequestSubject = Schema.Struct({
  kind: AccessRequestSubjectKind,
  /** The grant this subject is recorded under, e.g. `app:activity monitor`. */
  key: TrimmedNonEmptyString,
  /** Its name, e.g. "Activity Monitor" or "iPhone 17 Pro". */
  label: TrimmedNonEmptyString,
  /** What the agent may do with it, e.g. "See and control its windows". */
  detail: Schema.String,
  /** The machine it is on, when that is worth saying, e.g. "M1". */
  hostLabel: Schema.optional(TrimmedNonEmptyString),
  /** A device's platform, so clients pick the right device glyph. */
  platform: Schema.optional(Schema.Literals(["ios", "android"])),
  icon: Schema.optional(AccessRequestIcon),
});
export type AccessRequestSubject = typeof AccessRequestSubject.Type;

/** How long an Allow lasts: this thread only, or every thread on this machine. */
export const AccessRequestScope = Schema.Literals(["thread", "machine"]);
export type AccessRequestScope = typeof AccessRequestScope.Type;

/** The user's answer to an access request card; one answer covers every subject. */
export const AccessRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("allow"), scope: AccessRequestScope }),
    Schema.Struct({ type: Schema.Literal("deny") }),
  ]),
});
export type AccessRequestAnswerInput = typeof AccessRequestAnswerInput.Type;

/** An "Always on this machine" grant, as Settings lists it. */
export const AccessGrant = Schema.Struct({
  kind: AccessRequestSubjectKind,
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  grantedAt: Schema.String,
});
export type AccessGrant = typeof AccessGrant.Type;

export const AccessGrantListResult = Schema.Struct({
  grants: Schema.Array(AccessGrant),
});
export type AccessGrantListResult = typeof AccessGrantListResult.Type;

export const AccessGrantRevokeInput = Schema.Struct({ key: TrimmedNonEmptyString });
export type AccessGrantRevokeInput = typeof AccessGrantRevokeInput.Type;

const ACCESS_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the access request.",
  not_found: "This access request no longer exists.",
  already_answered: "This access request was already answered.",
  agent_stopped: "The agent that asked has stopped, so there is nothing to allow.",
  grant_failed: "Could not save the access.",
  record_failed: "Saved the access, but could not update the request.",
} as const;

export const AccessRequestFailureReason = Schema.Literals(
  Object.keys(ACCESS_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof ACCESS_REQUEST_FAILURE_MESSAGES
  >,
);
export type AccessRequestFailureReason = typeof AccessRequestFailureReason.Type;

/** Answering a request or changing a grant failed; the message is shown to the user. */
export class AccessRequestError extends Schema.TaggedError<AccessRequestError>()(
  "AccessRequestError",
  {
    reason: AccessRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return ACCESS_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}

/** Grant keys are case-insensitive names, so "Notes" and "notes" are one app. */
export const accessGrantKey = (kind: AccessRequestSubjectKind, id: string): string =>
  `${kind}:${id.trim().toLowerCase()}`;
