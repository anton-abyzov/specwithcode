import * as Schema from "effect/Schema";

/**
 * Word documents (.docx) edited in the app. The editor, the server's docx
 * reader and writer, and the `doc_write` / `doc_read` agent tools all speak
 * this one model. It holds data only: text with marks, links as plain
 * strings, and pictures as `data:` URLs taken from the file.
 */
export const DOCUMENT_ARTIFACT_SUFFIX = ".docx";
export const DOCUMENT_LIMITS = {
  /** Largest .docx the editor opens or writes. */
  fileBytes: 25 * 1024 * 1024,
  blocks: 10_000,
  runsPerParagraph: 2_000,
  runChars: 32_000,
  tableRows: 400,
  tableCols: 40,
  /** All pictures together, decoded. */
  imageBytes: 16 * 1024 * 1024,
  hrefChars: 2_048,
} as const;

const Text = Schema.String.check(Schema.isMaxLength(DOCUMENT_LIMITS.runChars));

export const DocumentRun = Schema.Struct({
  text: Text,
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  underline: Schema.optionalKey(Schema.Boolean),
  strike: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.Boolean),
  /** `#RRGGBB`. */
  color: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/))),
  /** `https:`, `http:` or `mailto:` link, or `#name` for a place in the document. */
  href: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DOCUMENT_LIMITS.hrefChars))),
});
export type DocumentRun = typeof DocumentRun.Type;

const Runs = Schema.Array(DocumentRun).check(Schema.isMaxLength(DOCUMENT_LIMITS.runsPerParagraph));
export const DocumentAlign = Schema.Literals(["left", "center", "right", "justify"]);
export type DocumentAlign = typeof DocumentAlign.Type;
const BookmarkId = Schema.String.check(Schema.isMaxLength(200));
const Pixels = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 20_000 }));

export const DocumentParagraph = Schema.Struct({
  type: Schema.Literal("paragraph"),
  id: Schema.optionalKey(BookmarkId),
  align: Schema.optionalKey(DocumentAlign),
  /** A block quote or a line of a code block (Word's Quote and Code Block styles). */
  style: Schema.optionalKey(Schema.Literals(["quote", "code"])),
  runs: Runs,
});
export type DocumentParagraph = typeof DocumentParagraph.Type;

export const DocumentBlock = Schema.Union([
  DocumentParagraph,
  Schema.Struct({
    type: Schema.Literal("heading"),
    level: Schema.Literals([1, 2, 3, 4, 5, 6]),
    id: Schema.optionalKey(BookmarkId),
    align: Schema.optionalKey(DocumentAlign),
    runs: Runs,
  }),
  Schema.Struct({
    type: Schema.Literal("list"),
    ordered: Schema.Boolean,
    /** Flat items; `level` 0 is the outermost, as Word's `ilvl`. */
    items: Schema.Array(
      Schema.Struct({
        level: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
        runs: Runs,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("table"),
    rows: Schema.Array(
      Schema.Struct({
        cells: Schema.Array(
          Schema.Struct({
            header: Schema.optionalKey(Schema.Boolean),
            /** One entry per paragraph in the cell. */
            paragraphs: Schema.Array(Runs),
          }),
        ).check(Schema.isMaxLength(DOCUMENT_LIMITS.tableCols)),
      }),
    ).check(Schema.isMaxLength(DOCUMENT_LIMITS.tableRows)),
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    /** `data:image/(png|jpeg|gif|webp);base64,...` only. */
    src: Schema.String.check(Schema.isPattern(/^data:image\/(png|jpeg|gif|webp);base64,/)),
    alt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
    width: Schema.optionalKey(Pixels),
    height: Schema.optionalKey(Pixels),
    align: Schema.optionalKey(DocumentAlign),
  }),
  Schema.Struct({ type: Schema.Literal("divider") }),
]);
export type DocumentBlock = typeof DocumentBlock.Type;

export const OfficeDocument = Schema.Struct({
  blocks: Schema.Array(DocumentBlock).check(Schema.isMaxLength(DOCUMENT_LIMITS.blocks)),
});
export type OfficeDocument = typeof OfficeDocument.Type;

const HostPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
/** sha256 of the file's bytes, hex. */
export const DocumentRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16,64}$/));

/** Reads a host `.docx` for editing. Gated by the `officeDocumentEditing` capability. */
export const DesignDocumentOpenInput = Schema.Struct({ path: HostPath });
export type DesignDocumentOpenInput = typeof DesignDocumentOpenInput.Type;

export const DesignDocumentOpenResult = Schema.Struct({
  document: OfficeDocument,
  revision: DocumentRevision,
  /**
   * What a save would drop from the file, in a person's words ("Track
   * changes", "Comments"). Empty when a save keeps everything the file holds.
   */
  lossOnSave: Schema.Array(Schema.String),
  /** Kept on save but not shown in the editor (headers, footers, page setup). */
  keptNotShown: Schema.Array(Schema.String),
});
export type DesignDocumentOpenResult = typeof DesignDocumentOpenResult.Type;

/**
 * Writes the document to a host `.docx`. `replace` needs the revision the
 * editor opened (a changed file is a `conflict`) and keeps the file's parts
 * the editor does not model; `create` makes a new file and fails when one is
 * already there.
 */
export const DesignDocumentSaveInput = Schema.Struct({
  path: HostPath,
  document: OfficeDocument,
  mode: Schema.Literals(["replace", "create"]),
  expectedRevision: Schema.optionalKey(DocumentRevision),
});
export type DesignDocumentSaveInput = typeof DesignDocumentSaveInput.Type;

export const DesignDocumentSaveResult = Schema.Struct({
  path: Schema.String,
  revision: DocumentRevision,
});
export type DesignDocumentSaveResult = typeof DesignDocumentSaveResult.Type;

/** Builds `.docx` bytes for an export, writing nothing. `basePath` keeps that file's other parts. */
export const DesignDocumentBuildInput = Schema.Struct({
  document: OfficeDocument,
  basePath: Schema.optionalKey(HostPath),
});
export type DesignDocumentBuildInput = typeof DesignDocumentBuildInput.Type;

export const DesignDocumentBuildResult = Schema.Struct({
  /** The .docx file, base64. */
  base64: Schema.String,
});
export type DesignDocumentBuildResult = typeof DesignDocumentBuildResult.Type;
