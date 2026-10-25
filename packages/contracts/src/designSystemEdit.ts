import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import {
  DesignOwnerInput,
  DesignSystemAddress,
  DesignSystemComponent,
  DesignTokenType,
} from "./design.ts";

/**
 * Editing a design system by hand, and the files kept beside it.
 *
 * Token edits are operations on `system.json`, checked against the revision
 * the editor read, like `design.apply`. Files live in the system's `files/`
 * folder (README, docs, fonts, asset sets); recorded source files are read
 * from the owner's checkout, and only when the system lists them. Only
 * people write here: agents keep proposing through import.
 */

/** One stored file at most; the RPC carries it as base64. */
export const DESIGN_SYSTEM_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** All stored files of one system together. */
export const DESIGN_SYSTEM_FILES_MAX_BYTES = 1024 * 1024 * 1024;
export const DESIGN_SYSTEM_FILES_MAX_COUNT = 5_000;
/** Longest stored path, and its depth in folders (`assets/Logos/mark.svg` is 3). */
export const DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH = 300;
export const DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH = 4;
/** Extensions a stored file may have, lowercase. */
export const DESIGN_SYSTEM_FILE_EXTENSIONS = [
  "md",
  "txt",
  "json",
  "css",
  "html",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "avif",
  "pdf",
  "woff",
  "woff2",
  "ttf",
  "otf",
] as const;

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180));
/** Letters, digits, `.`, `_` and `-`, as a CSS custom property name without `--`. */
export const DesignTokenName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);
const FilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH),
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** A token as a person writes it: raw values per mode; the server resolves them and stamps provenance. */
export const DesignTokenEdit = Schema.Struct({
  name: DesignTokenName,
  type: DesignTokenType,
  /** Where the token is listed (`color`, `spacing`, `z-index`…); the page's sections read it. */
  group: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  /** The usage note: when to use it, and when not to. */
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  /** Raw CSS value per mode id. A mode left out inherits the first mode's value. */
  values: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2_000))),
  aliasOf: Schema.optionalKey(DesignTokenName),
});
export type DesignTokenEdit = typeof DesignTokenEdit.Type;

const { provenance: _componentProvenance, ...componentFields } = DesignSystemComponent.fields;
/** A component as a person writes it; the server stamps provenance. */
export const DesignSystemComponentEdit = Schema.Struct(componentFields);
export type DesignSystemComponentEdit = typeof DesignSystemComponentEdit.Type;

export const DesignSystemOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("set_info"),
    name: Schema.optionalKey(Name),
    /** `null` removes the description. */
    description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000)))),
  }),
  /** Adds a mode, or renames one with the same id. A new mode starts with no values. */
  Schema.Struct({ op: Schema.Literal("put_mode"), mode: Schema.Struct({ id: Id, name: Name }) }),
  /** Removes a mode and its values; the last mode cannot be removed. */
  Schema.Struct({ op: Schema.Literal("delete_mode"), modeId: Id }),
  /** Adds a token, or replaces the one with the same name. */
  Schema.Struct({ op: Schema.Literal("put_token"), token: DesignTokenEdit }),
  /** Renames a token and every alias of it in this system; designs that name it are not rewritten. */
  Schema.Struct({ op: Schema.Literal("rename_token"), from: DesignTokenName, to: DesignTokenName }),
  Schema.Struct({ op: Schema.Literal("delete_token"), name: DesignTokenName }),
  /** Adds a component, or replaces the one with the same id. */
  Schema.Struct({ op: Schema.Literal("put_component"), component: DesignSystemComponentEdit }),
  Schema.Struct({
    op: Schema.Literal("delete_component"),
    componentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
]);
export type DesignSystemOperation = typeof DesignSystemOperation.Type;

// ---------------------------------------------------------------------------
// RPC inputs and results
// ---------------------------------------------------------------------------

/** A new, empty system the person starts from scratch. Modes default to Light and Dark. */
export const DesignSystemCreateInput = Schema.Struct({
  owner: DesignOwnerInput,
  name: Name,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  modes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Id, name: Name })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  ),
});
export type DesignSystemCreateInput = typeof DesignSystemCreateInput.Type;

export const DesignSystemApplyInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  expectedRevision: NonNegativeInt,
  operations: Schema.Array(DesignSystemOperation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_000),
  ),
});
export type DesignSystemApplyInput = typeof DesignSystemApplyInput.Type;

/** `stored`: in the system's `files/` folder. `source`: a file the system was read from, in the owner's checkout. */
export const DesignSystemFileOrigin = Schema.Literals(["stored", "source"]);
export type DesignSystemFileOrigin = typeof DesignSystemFileOrigin.Type;

export const DesignSystemFile = Schema.Struct({
  /** Relative to `files/` for stored files, to the owner's root for sources; `/` separated. */
  path: Schema.String.check(Schema.isMaxLength(500)),
  origin: DesignSystemFileOrigin,
  bytes: NonNegativeInt,
  mimeType: Schema.String.check(Schema.isMaxLength(120)),
  updatedAt: Schema.optionalKey(Schema.String),
  /** Sources only: why the file cannot be read now (missing, excluded, too large). */
  unavailable: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});
export type DesignSystemFile = typeof DesignSystemFile.Type;

export const DesignSystemFilesInput = DesignSystemAddress;
export const DesignSystemFilesResult = Schema.Struct({
  files: Schema.Array(DesignSystemFile),
  /** Stored files only. */
  usedBytes: NonNegativeInt,
  limitBytes: NonNegativeInt,
  limitFiles: NonNegativeInt,
});
export type DesignSystemFilesResult = typeof DesignSystemFilesResult.Type;

export const DesignSystemFileReadInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  origin: DesignSystemFileOrigin,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type DesignSystemFileReadInput = typeof DesignSystemFileReadInput.Type;

export const DesignSystemFileReadResult = Schema.Struct({
  file: DesignSystemFile,
  /** `utf8` for text files, `base64` for everything else. */
  encoding: Schema.Literals(["utf8", "base64"]),
  data: Schema.String,
});
export type DesignSystemFileReadResult = typeof DesignSystemFileReadResult.Type;

/** Writes or replaces one stored file. Parent folders are created. */
export const DesignSystemFilePutInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  path: FilePath,
  /** Base64 file bytes, at most `DESIGN_SYSTEM_FILE_MAX_BYTES` decoded. */
  data: Schema.String.check(Schema.isMaxLength(14 * 1024 * 1024)),
});
export type DesignSystemFilePutInput = typeof DesignSystemFilePutInput.Type;

export const DesignSystemFilePutResult = Schema.Struct({ file: DesignSystemFile });
export type DesignSystemFilePutResult = typeof DesignSystemFilePutResult.Type;

/** Removes one stored file; folders left empty go with it. */
export const DesignSystemFileDeleteInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  path: FilePath,
});
export type DesignSystemFileDeleteInput = typeof DesignSystemFileDeleteInput.Type;
export const DesignSystemFileDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type DesignSystemFileDeleteResult = typeof DesignSystemFileDeleteResult.Type;

/** Renames a stored file or moves it to another folder (an asset set). */
export const DesignSystemFileMoveInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  from: FilePath,
  to: FilePath,
});
export type DesignSystemFileMoveInput = typeof DesignSystemFileMoveInput.Type;
