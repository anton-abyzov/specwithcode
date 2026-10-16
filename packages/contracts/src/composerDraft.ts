import * as Schema from "effect/Schema";

/**
 * Unsent composer drafts kept by the host, so text and attachments survive a
 * crash, a force quit or an update restart, and follow the user between the
 * desktop app and the web on the same host. A draft is keyed by its composer:
 * `thread:<threadId>`, `coordinator:<projectId>` or `draft:<draftId>`.
 */

export const COMPOSER_DRAFT_KEY_PATTERN = /^(?:thread|coordinator|draft):[A-Za-z0-9_.:-]{1,200}$/u;
export const ComposerDraftKey = Schema.String.check(Schema.isPattern(COMPOSER_DRAFT_KEY_PATTERN));
export type ComposerDraftKey = typeof ComposerDraftKey.Type;

export const COMPOSER_DRAFT_ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
/** Larger files stay in the composer but are not kept across a restart. */
export const COMPOSER_DRAFT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const COMPOSER_DRAFT_MAX_ATTACHMENTS = 40;
export const COMPOSER_DRAFT_MAX_PROMPT_LENGTH = 1_000_000;

export const ComposerDraftAttachmentMeta = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(COMPOSER_DRAFT_ATTACHMENT_ID_PATTERN)),
  type: Schema.Literals(["image", "file"]),
  name: Schema.String.check(Schema.isMaxLength(512)),
  mimeType: Schema.String.check(Schema.isMaxLength(200)),
  sizeBytes: Schema.Number,
});
export type ComposerDraftAttachmentMeta = typeof ComposerDraftAttachmentMeta.Type;

export const ComposerDraftPutInput = Schema.Struct({
  key: ComposerDraftKey,
  prompt: Schema.String.check(Schema.isMaxLength(COMPOSER_DRAFT_MAX_PROMPT_LENGTH)),
  attachments: Schema.Array(
    Schema.Struct({
      ...ComposerDraftAttachmentMeta.fields,
      /** Bytes for an attachment the host does not hold yet. */
      dataBase64: Schema.optionalKey(Schema.String),
    }),
  ).check(Schema.isMaxLength(COMPOSER_DRAFT_MAX_ATTACHMENTS)),
  /** Client time of the edit; the newer side wins when two copies differ. */
  editedAt: Schema.Number,
});
export type ComposerDraftPutInput = typeof ComposerDraftPutInput.Type;

export const ComposerDraftPutResult = Schema.Struct({
  revision: Schema.Number,
  /** Attachments sent without bytes that the host does not hold; resend them with bytes. */
  missingAttachmentIds: Schema.Array(Schema.String),
});
export type ComposerDraftPutResult = typeof ComposerDraftPutResult.Type;

export const ComposerDraftKeyInput = Schema.Struct({ key: ComposerDraftKey });
export type ComposerDraftKeyInput = typeof ComposerDraftKeyInput.Type;

export const ComposerDraftRecord = Schema.Struct({
  key: ComposerDraftKey,
  prompt: Schema.String,
  attachments: Schema.Array(
    Schema.Struct({ ...ComposerDraftAttachmentMeta.fields, dataBase64: Schema.String }),
  ),
  editedAt: Schema.Number,
  revision: Schema.Number,
});
export type ComposerDraftRecord = typeof ComposerDraftRecord.Type;

export const ComposerDraftGetResult = Schema.Struct({
  draft: Schema.NullOr(ComposerDraftRecord),
});
export type ComposerDraftGetResult = typeof ComposerDraftGetResult.Type;

export class ComposerDraftError extends Schema.TaggedError<ComposerDraftError>()(
  "ComposerDraftError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
