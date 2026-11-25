import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * Live editing of one document by several writers at once: the windows open on
 * it and the agents that write it. The machine that holds the file is the
 * authority: it checks every change against the session's access before it
 * merges, and writes the merged document back to the plain file.
 *
 * These calls reach the same files `projects.readFile` and `projects.writeFile`
 * reach, under the same scopes and path checks. They add no principal,
 * credential or route.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** Largest merge update one call carries, as base64 text. */
export const DOCUMENT_SESSION_MAX_UPDATE_CHARS = 6 * 1024 * 1024;
export const DOCUMENT_SESSION_MAX_PARTICIPANTS = 64;
export const DOCUMENT_SESSION_ACTIVITY_LIMIT = 50;

const sessionKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));
const update = Schema.String.check(Schema.isMaxLength(DOCUMENT_SESSION_MAX_UPDATE_CHARS));

/** What a session may do with the document. Only "edit" may change it. */
export const DocumentSessionAccess = Schema.Literals(["edit", "view"]);
export type DocumentSessionAccess = typeof DocumentSessionAccess.Type;

const DocumentSessionTarget = {
  cwd: bounded(4096),
  relativePath: bounded(4096),
};

/** Where a participant is in a sheet. */
export const DocumentSessionPlace = Schema.Struct({
  /** The tab's id in the merge document. */
  tab: bounded(64),
  /** The focused cell, such as "B2". */
  cell: bounded(16),
  /** The selected range when it is more than one cell, such as "B2:D9". */
  range: Schema.optionalKey(bounded(40)),
});
export type DocumentSessionPlace = typeof DocumentSessionPlace.Type;

export const DocumentSessionParticipant = Schema.Struct({
  id: bounded(64),
  kind: Schema.Literals(["window", "agent"]),
  /** A name to show: an agent's thread title, or nothing for a window. */
  label: Schema.optionalKey(bounded(200)),
  /** Position in the presence palette, stable for the participant's stay. */
  color: NonNegativeInt,
  access: DocumentSessionAccess,
  place: Schema.optionalKey(DocumentSessionPlace),
});
export type DocumentSessionParticipant = typeof DocumentSessionParticipant.Type;

/** One merged change, as the document's activity shows it. */
export const DocumentSessionActivity = Schema.Struct({
  id: NonNegativeInt,
  /** ISO time the change merged on the home machine. */
  at: bounded(40),
  by: Schema.Struct({
    id: bounded(64),
    kind: Schema.Literals(["window", "agent", "file"]),
    label: Schema.optionalKey(bounded(200)),
    color: Schema.optionalKey(NonNegativeInt),
  }),
  /** Cells whose input changed. */
  cells: NonNegativeInt,
  /** The first changed cell, such as "Plan!B2". */
  first: Schema.optionalKey(bounded(120)),
  /** Whether anything but cell inputs changed. */
  layout: Schema.Boolean,
  /** The change merged, but a change made at the same time to the same place is the one that shows. */
  superseded: Schema.optionalKey(Schema.Boolean),
});
export type DocumentSessionActivity = typeof DocumentSessionActivity.Type;

export const DocumentSessionEvent = Schema.Union([
  /** First on every subscription: the whole merge state and who is here. */
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    /** This subscriber's own participant id. */
    participantId: bounded(64),
    /** Changes when the merge state was rebuilt; a client then starts over from `update`. */
    epoch: bounded(64),
    access: DocumentSessionAccess,
    update,
    participants: Schema.Array(DocumentSessionParticipant),
    activity: Schema.Array(DocumentSessionActivity),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    update,
    activity: Schema.optionalKey(DocumentSessionActivity),
  }),
  Schema.Struct({
    type: Schema.Literal("presence"),
    participants: Schema.Array(DocumentSessionParticipant),
  }),
  /** The file is gone or can no longer be read; the session is over. */
  Schema.Struct({ type: Schema.Literal("closed"), reason: bounded(400) }),
]);
export type DocumentSessionEvent = typeof DocumentSessionEvent.Type;

export const DocumentSessionOpenInput = Schema.Struct({
  ...DocumentSessionTarget,
  /** Chosen by the window; names it in `update` and `presence`. */
  sessionKey,
  /** "edit" needs filesystem:write, like saving the file. */
  access: DocumentSessionAccess,
});
export type DocumentSessionOpenInput = typeof DocumentSessionOpenInput.Type;

export const DocumentSessionUpdateInput = Schema.Struct({
  ...DocumentSessionTarget,
  sessionKey,
  update,
});
export type DocumentSessionUpdateInput = typeof DocumentSessionUpdateInput.Type;

export const DocumentSessionPresenceInput = Schema.Struct({
  ...DocumentSessionTarget,
  sessionKey,
  place: Schema.NullOr(DocumentSessionPlace),
});
export type DocumentSessionPresenceInput = typeof DocumentSessionPresenceInput.Type;

export const DocumentSessionErrorCode = Schema.Literals([
  /** No such file, or not a document this session can hold. */
  "not_found",
  /** The session may only view: its change was not merged. */
  "view_only",
  /** The change would leave the document invalid or over a limit; it was not merged. */
  "refused",
  /** The window has no open session on this document; open it again. */
  "not_open",
  "failed",
]);
export type DocumentSessionErrorCode = typeof DocumentSessionErrorCode.Type;

export class DocumentSessionError extends Schema.TaggedError<DocumentSessionError>()(
  "DocumentSessionError",
  {
    code: DocumentSessionErrorCode,
    detail: bounded(400),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const DOCUMENT_SESSION_RPC_METHODS = {
  documentSessionOpen: "documents.session.open",
  documentSessionUpdate: "documents.session.update",
  documentSessionPresence: "documents.session.presence",
} as const;

const M = DOCUMENT_SESSION_RPC_METHODS;
const error = Schema.Union([DocumentSessionError, EnvironmentAuthorizationError]);

/** Document session calls, registered as their own group (see `WsDocumentSessionRpcGroup`). */
export const documentSessionRpcs = [
  Rpc.make(M.documentSessionOpen, {
    payload: DocumentSessionOpenInput,
    success: DocumentSessionEvent,
    error,
    stream: true,
  }),
  Rpc.make(M.documentSessionUpdate, {
    payload: DocumentSessionUpdateInput,
    success: Schema.Struct({ merged: Schema.Boolean }),
    error,
  }),
  Rpc.make(M.documentSessionPresence, {
    payload: DocumentSessionPresenceInput,
    success: Schema.Struct({}),
    error,
  }),
] as const;
