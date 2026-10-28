import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * Designs, slides and design systems. A project owns its designs as files in
 * its checkout (`.specweave/design/`), so they travel with the repository and
 * survive handoff; the Playground keeps personal designs in the app's own
 * home. Nothing is shared across owners by reference: moving work between
 * them is always an explicit copy that records where it came from.
 */
export const DESIGN_DOCUMENT_SCHEMA = "swc.design/1";
export const DESIGN_SYSTEM_SCHEMA = "swc.design-system/1";
/** Folder of a project's designs, relative to the project root. */
export const PROJECT_DESIGN_DIR = ".specweave/design";
/** Folder of a project's design systems, relative to the project root. */
export const PROJECT_DESIGN_SYSTEM_DIR = ".specweave/design/systems";
export const DESIGN_MAX_PAGES = 200;
export const DESIGN_MAX_NODES_PER_PAGE = 5_000;
export const DESIGN_MAX_TEXT = 100_000;
export const DESIGN_MAX_HTML = 512 * 1024;
export const DESIGN_AUTOSAVE_REVISIONS_KEPT = 100;

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const Name = Schema.String.check(Schema.isMaxLength(180));
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -1e6, maximum: 1e6 }));
const Size = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e6 }));
const Unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const DesignId = Id;
export type DesignId = typeof DesignId.Type;
export const DesignNodeId = Id;
export type DesignNodeId = typeof DesignNodeId.Type;
export const DesignSystemId = Id;
export type DesignSystemId = typeof DesignSystemId.Type;

// ---------------------------------------------------------------------------
// Ownership and references
// ---------------------------------------------------------------------------

export const DesignOwner = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
    environmentId: EnvironmentId,
    projectId: ProjectId,
  }),
  Schema.Struct({ kind: Schema.Literal("playground"), environmentId: EnvironmentId }),
]);
export type DesignOwner = typeof DesignOwner.Type;

/**
 * A pointer to a design. `path` is relative to the owner's root, so the same
 * reference resolves in another machine's checkout of the same repository.
 */
export const DesignRef = Schema.Struct({
  owner: DesignOwner,
  designId: DesignId,
  path: Schema.String.check(Schema.isMaxLength(400)),
});
export type DesignRef = typeof DesignRef.Type;

export const DesignSystemRef = Schema.Struct({
  owner: DesignOwner,
  systemId: DesignSystemId,
  path: Schema.String.check(Schema.isMaxLength(400)),
});
export type DesignSystemRef = typeof DesignSystemRef.Type;

/** A system another one derives from; always one the same owner holds. */
export const DesignSystemLineage = Schema.Struct({
  owner: DesignOwner,
  systemId: DesignSystemId,
});
export type DesignSystemLineage = typeof DesignSystemLineage.Type;

export const DesignActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId,
    provider: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
    model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  }),
]);
export type DesignActor = typeof DesignActor.Type;

export const DesignCopySource = Schema.Struct({
  owner: DesignOwner,
  id: Id,
  revision: NonNegativeInt,
  copiedAt: Schema.String,
});
export type DesignCopySource = typeof DesignCopySource.Type;

// ---------------------------------------------------------------------------
// Paint and nodes
// ---------------------------------------------------------------------------

/** A literal CSS color, or a reference to a design-system token by name. */
export const DesignPaint = Schema.Union([
  Schema.String.check(Schema.isMaxLength(120)),
  Schema.Struct({ token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) }),
]);
export type DesignPaint = typeof DesignPaint.Type;

/** A literal number, or a token reference (spacing, radius, font size). */
export const DesignLength = Schema.Union([
  Size,
  Schema.Struct({ token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) }),
]);
export type DesignLength = typeof DesignLength.Type;

const nodeBase = {
  id: DesignNodeId,
  /** The containing frame; null for a node placed on the page itself. */
  parentId: Schema.NullOr(DesignNodeId),
  name: Schema.optionalKey(Name),
  /** Position relative to the parent frame, or to the page. */
  x: Coordinate,
  y: Coordinate,
  width: Size,
  height: Size,
  rotation: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: -360, maximum: 360 })),
  ),
  opacity: Schema.optionalKey(Unit),
  hidden: Schema.optionalKey(Schema.Boolean),
  locked: Schema.optionalKey(Schema.Boolean),
};

const strokeFields = {
  stroke: Schema.optionalKey(DesignPaint),
  strokeWidth: Schema.optionalKey(Size),
};

export const DesignFrameNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literal("frame"),
  fill: Schema.optionalKey(DesignPaint),
  radius: Schema.optionalKey(DesignLength),
  ...strokeFields,
  /** Frames clip their children like an artboard. */
  clip: Schema.optionalKey(Schema.Boolean),
});

export const DesignShapeNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literals(["rect", "ellipse"]),
  fill: Schema.optionalKey(DesignPaint),
  radius: Schema.optionalKey(DesignLength),
  ...strokeFields,
});

const Point = Schema.Tuple([Coordinate, Coordinate]);

/** Lines and pen paths. Points are relative to the node's own x and y. */
export const DesignPathNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literals(["line", "path"]),
  points: Schema.Array(Point).check(Schema.isMinLength(2), Schema.isMaxLength(10_000)),
  closed: Schema.optionalKey(Schema.Boolean),
  fill: Schema.optionalKey(DesignPaint),
  ...strokeFields,
});

export const DesignTextNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literal("text"),
  text: Schema.String.check(Schema.isMaxLength(DESIGN_MAX_TEXT)),
  color: Schema.optionalKey(DesignPaint),
  fontFamily: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isMaxLength(200)),
      Schema.Struct({ token: Schema.String.check(Schema.isMaxLength(120)) }),
    ]),
  ),
  fontSize: Schema.optionalKey(DesignLength),
  fontWeight: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900 })),
  ),
  lineHeight: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 4 })),
  ),
  letterSpacing: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: -20, maximum: 50 })),
  ),
  align: Schema.optionalKey(Schema.Literals(["left", "center", "right"])),
  /** A named text style of the design system (for example `wv-h1`). */
  textStyle: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
});

/** File name of a design asset under the design's `assets/` folder: `<sha256>.<ext>`. */
export const DesignAssetName = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}\.(png|jpe?g|gif|webp|svg)$/),
);
export type DesignAssetName = typeof DesignAssetName.Type;

export const DesignImageNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literal("image"),
  asset: DesignAssetName,
  fit: Schema.optionalKey(Schema.Literals(["cover", "contain", "fill"])),
  alt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  radius: Schema.optionalKey(DesignLength),
});

export const DesignNoteNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literal("note"),
  text: Schema.String.check(Schema.isMaxLength(10_000)),
  color: Schema.optionalKey(Schema.Literals(["yellow", "blue", "green", "pink", "gray"])),
});

/** Agent- or user-written HTML, always rendered in an opaque-origin sandbox. */
export const DesignHtmlNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literal("html"),
  html: Schema.String.check(Schema.isMaxLength(DESIGN_MAX_HTML)),
});

/** An instance of a design-system component, rendered from its preview. */
export const DesignComponentNode = Schema.Struct({
  ...nodeBase,
  type: Schema.Literal("component"),
  componentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export const DesignNode = Schema.Union([
  DesignFrameNode,
  DesignShapeNode,
  DesignPathNode,
  DesignTextNode,
  DesignImageNode,
  DesignNoteNode,
  DesignHtmlNode,
  DesignComponentNode,
]);
export type DesignNode = typeof DesignNode.Type;
export type DesignNodeType = DesignNode["type"];
export const DESIGN_NODE_TYPES = [
  "frame",
  "rect",
  "ellipse",
  "line",
  "path",
  "text",
  "image",
  "note",
  "html",
  "component",
] as const satisfies readonly DesignNodeType[];

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export const DesignPage = Schema.Struct({
  id: Id,
  name: Name,
  /** Paint order: later nodes draw on top. Children follow their frame. */
  nodes: Schema.Array(DesignNode).check(Schema.isMaxLength(DESIGN_MAX_NODES_PER_PAGE)),
  /** Slides only: excluded from present mode and export. */
  skipped: Schema.optionalKey(Schema.Boolean),
  /** Slides only: speaker notes. */
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DESIGN_MAX_TEXT))),
});
export type DesignPage = typeof DesignPage.Type;

export const DesignComment = Schema.Struct({
  id: Id,
  pageId: Id,
  /** Pinned to a node, or to a point on the page when null. */
  nodeId: Schema.NullOr(DesignNodeId),
  x: Coordinate,
  y: Coordinate,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  author: DesignActor,
  createdAt: Schema.String,
  resolved: Schema.Boolean,
  /**
   * The first comment of the thread this replies to; absent on a thread's first
   * comment. Older servers drop it and show the reply as its own comment.
   */
  parentId: Schema.optionalKey(Id),
});
export type DesignComment = typeof DesignComment.Type;

/** The agent thread a design is worked in. Threads are per machine, so the binding names its environment. */
export const DesignThreadBinding = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type DesignThreadBinding = typeof DesignThreadBinding.Type;

/**
 * A design system found in the owner's repository that a design follows before
 * anyone imports it: what was reused and where it came from, so the person and
 * the agent see it. Informational; the canvas still draws tokens from
 * `designSystem` once the system is imported.
 */
export const DesignReuse = Schema.Struct({
  name: Name,
  /** Root-relative files the system was read from. */
  paths: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
    Schema.isMaxLength(24),
  ),
  tokens: NonNegativeInt,
  components: NonNegativeInt,
  modes: Schema.Array(Schema.String.check(Schema.isMaxLength(120))).check(Schema.isMaxLength(12)),
  /** The import proposal waiting for review in Settings > Design systems, if one was made. */
  proposalId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  foundAt: Schema.String,
});
export type DesignReuse = typeof DesignReuse.Type;

/**
 * What each audience may do with a design. `members` are people on the
 * owner's other paired devices and linked machines; `agents` are agent
 * threads working through the design tools. The owner on this machine can
 * always edit. Defaults when absent: members edit, agents edit.
 */
export const DesignAccessLevel = Schema.Literals(["edit", "comment", "view"]);
export type DesignAccessLevel = typeof DesignAccessLevel.Type;
export const DesignAccess = Schema.Struct({
  members: DesignAccessLevel,
  agents: DesignAccessLevel,
});
export type DesignAccess = typeof DesignAccess.Type;
export const DESIGN_DEFAULT_ACCESS: DesignAccess = { members: "edit", agents: "edit" };

export const DesignKind = Schema.Literals(["design", "slides"]);
export type DesignKind = typeof DesignKind.Type;

export const DesignDocument = Schema.Struct({
  schema: Schema.Literal(DESIGN_DOCUMENT_SCHEMA),
  id: DesignId,
  kind: DesignKind,
  title: Name,
  revision: NonNegativeInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The design system the document draws its tokens from, owned by the same owner. */
  designSystem: Schema.NullOr(DesignSystemId),
  pages: Schema.Array(DesignPage).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DESIGN_MAX_PAGES),
  ),
  comments: Schema.Array(DesignComment).check(Schema.isMaxLength(5_000)),
  createdBy: DesignActor,
  copiedFrom: Schema.NullOr(DesignCopySource),
  thread: Schema.optionalKey(DesignThreadBinding),
  access: Schema.optionalKey(DesignAccess),
  reuse: Schema.optionalKey(DesignReuse),
});
export type DesignDocument = typeof DesignDocument.Type;

// ---------------------------------------------------------------------------
// Operations (applied by the shared reducer on client and server)
// ---------------------------------------------------------------------------

const NodePatch = Schema.Record(Schema.String, Schema.Unknown);

export const DesignOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add_node"),
    pageId: Id,
    node: DesignNode,
    /** Position in the page's paint order; appended when absent. */
    index: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({
    op: Schema.Literal("update_node"),
    pageId: Id,
    id: DesignNodeId,
    /** Fields to set; `null` removes an optional field. `id` and `type` cannot change. */
    patch: NodePatch,
  }),
  Schema.Struct({ op: Schema.Literal("delete_node"), pageId: Id, id: DesignNodeId }),
  Schema.Struct({
    op: Schema.Literal("move_node"),
    pageId: Id,
    id: DesignNodeId,
    parentId: Schema.optionalKey(Schema.NullOr(DesignNodeId)),
    index: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({
    op: Schema.Literal("add_page"),
    page: DesignPage,
    index: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({
    op: Schema.Literal("update_page"),
    pageId: Id,
    name: Schema.optionalKey(Name),
    skipped: Schema.optionalKey(Schema.Boolean),
    notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DESIGN_MAX_TEXT))),
  }),
  Schema.Struct({ op: Schema.Literal("delete_page"), pageId: Id }),
  Schema.Struct({ op: Schema.Literal("move_page"), pageId: Id, index: NonNegativeInt }),
  Schema.Struct({ op: Schema.Literal("set_title"), title: Name }),
  Schema.Struct({
    op: Schema.Literal("set_design_system"),
    systemId: Schema.NullOr(DesignSystemId),
  }),
  Schema.Struct({ op: Schema.Literal("add_comment"), comment: DesignComment }),
  Schema.Struct({
    op: Schema.Literal("resolve_comment"),
    commentId: Id,
    resolved: Schema.Boolean,
  }),
  Schema.Struct({ op: Schema.Literal("delete_comment"), commentId: Id }),
  Schema.Struct({ op: Schema.Literal("set_thread"), thread: Schema.NullOr(DesignThreadBinding) }),
  Schema.Struct({ op: Schema.Literal("set_reuse"), reuse: Schema.NullOr(DesignReuse) }),
  Schema.Struct({
    op: Schema.Literal("set_access"),
    members: Schema.optionalKey(DesignAccessLevel),
    agents: Schema.optionalKey(DesignAccessLevel),
  }),
]);
export type DesignOperation = typeof DesignOperation.Type;

// ---------------------------------------------------------------------------
// Design systems
// ---------------------------------------------------------------------------

export const DesignTokenType = Schema.Literals([
  "color",
  "dimension",
  "fontFamily",
  "fontWeight",
  "typography",
  "shadow",
  "duration",
  "easing",
  "number",
  "other",
]);
export type DesignTokenType = typeof DesignTokenType.Type;

/** Where a token or component was read from. */
export const DesignProvenance = Schema.Struct({
  /** `file` for a repository file, `figma-export` for an exported variables file, `figma-desktop` for Figma's MCP server, `agent` for a described system. */
  source: Schema.Literals(["file", "figma-export", "figma-desktop", "agent", "user"]),
  /** Repository-relative path, export file name, or `<fileKey>/<nodeId>`. */
  location: Schema.String.check(Schema.isMaxLength(500)),
  line: Schema.optionalKey(NonNegativeInt),
  column: Schema.optionalKey(NonNegativeInt),
  /** Selector, at-rule or JSON path the value sits under (`:root`, `@variant dark`, `color.tokens[3]`). */
  context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /** SHA-256 of the whole source file when it was read. */
  sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  extractor: Schema.String.check(Schema.isMaxLength(80)),
});
export type DesignProvenance = typeof DesignProvenance.Type;

export const DesignTokenValue = Schema.Struct({
  /** The value as written (`var(--wv-ink)`, `color-mix(...)`). */
  raw: Schema.String.check(Schema.isMaxLength(2_000)),
  /** The value with references resolved within the same mode; null when it cannot be resolved. */
  resolved: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  provenance: DesignProvenance,
});
export type DesignTokenValue = typeof DesignTokenValue.Type;

export const DesignToken = Schema.Struct({
  /** Stable name without the leading `--` (for example `wv-ink`). */
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  type: DesignTokenType,
  group: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  /** Values per mode id; `default` when the source has no modes. */
  values: Schema.Record(Schema.String, DesignTokenValue),
  /** Name of the token this one is an alias of, in the same system. */
  aliasOf: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type DesignToken = typeof DesignToken.Type;

export const DesignComponentProp = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(200)),
  type: Schema.String.check(Schema.isMaxLength(1_000)),
  optional: Schema.Boolean,
});

/** One story of a built component preview, as a section of its preview file. */
export const DESIGN_PREVIEW_STORY_ATTRIBUTE = "data-swc-story";

export const DesignSystemPreviews = Schema.Struct({
  /** The stored stylesheet every preview loads (the kit's built CSS, fonts and images inlined). */
  stylesheetFile: Schema.String.check(Schema.isMaxLength(300)),
  builtAt: Schema.String,
  rendered: NonNegativeInt,
  total: NonNegativeInt,
  /** What the last build could not do, in plain words, so it shows after a confirm too. */
  problems: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
  ),
});
export type DesignSystemPreviews = typeof DesignSystemPreviews.Type;

export const DesignSystemComponent = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  name: Schema.String.check(Schema.isMaxLength(200)),
  /** `react` for an exported component, `css-class` for a class family such as `.wv-btn`. */
  framework: Schema.Literals(["react", "css-class", "html", "other"]),
  group: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  /** Import specifier or class selector code uses (`@scope/ui/primitives`, `.wv-btn`). */
  importPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  exportName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  variants: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(200)))),
  props: Schema.optionalKey(Schema.Array(DesignComponentProp)),
  stories: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(200)))),
  /** Static HTML the canvas renders for an instance, using the system's CSS. */
  previewHtml: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  /**
   * A stored file (`previews/…html`) rendered from the kit's own stories, one
   * section per story. Built by the server from code; never written by edits.
   */
  previewFile: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /** Why a built preview is missing for this component (no story rendered, needs props…). */
  previewNote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  provenance: DesignProvenance,
});
export type DesignSystemComponent = typeof DesignSystemComponent.Type;

export const DesignSystemSource = Schema.Struct({
  kind: Schema.Literals(["file", "figma-export", "figma-desktop", "agent"]),
  location: Schema.String.check(Schema.isMaxLength(500)),
  sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  readAt: Schema.String,
});
export type DesignSystemSource = typeof DesignSystemSource.Type;

export const DesignSystem = Schema.Struct({
  schema: Schema.Literal(DESIGN_SYSTEM_SCHEMA),
  id: DesignSystemId,
  name: Name,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  revision: NonNegativeInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  modes: Schema.Array(Schema.Struct({ id: Id, name: Name })).check(Schema.isMinLength(1)),
  tokens: Schema.Array(DesignToken).check(Schema.isMaxLength(20_000)),
  components: Schema.Array(DesignSystemComponent).check(Schema.isMaxLength(5_000)),
  /** CSS the canvas loads for component previews (a copy of the system's own stylesheet). */
  stylesheet: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024 * 1024))),
  /** The last preview build: its stylesheet file and how many components it rendered. */
  previews: Schema.optionalKey(DesignSystemPreviews),
  sources: Schema.Array(DesignSystemSource),
  /** The owner's system this one derives from, for example the app theme from Weave. */
  derivedFrom: Schema.optionalKey(DesignSystemLineage),
  /** Informational name of the upstream system when the owner does not hold it. */
  derivedFromLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  copiedFrom: Schema.NullOr(DesignCopySource),
});
export type DesignSystem = typeof DesignSystem.Type;

// ---------------------------------------------------------------------------
// Listing, history and RPC inputs
// ---------------------------------------------------------------------------

export const DesignSummary = Schema.Struct({
  ref: DesignRef,
  kind: DesignKind,
  title: Name,
  revision: NonNegativeInt,
  updatedAt: Schema.String,
  pageCount: NonNegativeInt,
  designSystem: Schema.NullOr(DesignSystemId),
  /** Owner label for display: the project title or "Playground". */
  ownerLabel: Name,
  thread: Schema.optionalKey(DesignThreadBinding),
  access: Schema.optionalKey(DesignAccess),
});
export type DesignSummary = typeof DesignSummary.Type;

export const DesignSystemSummary = Schema.Struct({
  ref: DesignSystemRef,
  name: Name,
  revision: NonNegativeInt,
  updatedAt: Schema.String,
  tokenCount: NonNegativeInt,
  componentCount: NonNegativeInt,
  sources: Schema.Array(DesignSystemSource),
  ownerLabel: Name,
  /** The system this one was copied from, so a picker can offer the copy instead of another. */
  copiedFrom: Schema.optionalKey(DesignCopySource),
});
export type DesignSystemSummary = typeof DesignSystemSummary.Type;

export const DesignHistoryEntry = Schema.Struct({
  kind: Schema.Literals(["revision", "version"]),
  revision: NonNegativeInt,
  /** Versions only: the name the user gave it. */
  name: Schema.NullOr(Name),
  savedAt: Schema.String,
  actor: DesignActor,
});
export type DesignHistoryEntry = typeof DesignHistoryEntry.Type;

/** Who to list designs for: one owner, or every owner this caller may read. */
export const DesignOwnerFilter = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("playground") }),
  Schema.Struct({ kind: Schema.Literal("projects") }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
]);
export type DesignOwnerFilter = typeof DesignOwnerFilter.Type;

/** Owner selection from a client; the server fills in the environment. */
export const DesignOwnerInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("playground") }),
]);
export type DesignOwnerInput = typeof DesignOwnerInput.Type;

/**
 * An owner that could not be read, or a file in it that could not. `owner` names the
 * project exactly (titles repeat across clones); servers before it send only the label.
 */
export const DesignListProblem = Schema.Struct({
  ownerLabel: Name,
  detail: Schema.String,
  owner: Schema.optionalKey(DesignOwnerInput),
});
export type DesignListProblem = typeof DesignListProblem.Type;

export const DesignListInput = Schema.Struct({ filter: DesignOwnerFilter });
export const DesignListResult = Schema.Struct({
  designs: Schema.Array(DesignSummary),
  /** Owners that could not be read (folder missing, not on this machine), with the reason. */
  problems: Schema.Array(DesignListProblem),
});
export type DesignListResult = typeof DesignListResult.Type;

export const DesignAddress = Schema.Struct({ owner: DesignOwnerInput, designId: DesignId });
export type DesignAddress = typeof DesignAddress.Type;

export const DesignGetInput = Schema.Struct({
  ...DesignAddress.fields,
  /** A past revision or version to read instead of the head. */
  revision: Schema.optionalKey(NonNegativeInt),
  /**
   * The machine the owner project lives on, when the address came from a
   * reference made elsewhere. The design then opens from this machine's
   * linked checkout of the same logical project.
   */
  environmentId: Schema.optionalKey(EnvironmentId),
});
export type DesignGetInput = typeof DesignGetInput.Type;

/** Who the server takes the caller for: the owner on this machine, a member, or an agent. */
export const DesignAudience = Schema.Literals(["owner", "members", "agents"]);
export type DesignAudience = typeof DesignAudience.Type;

export const DesignGetResult = Schema.Struct({
  ref: DesignRef,
  document: DesignDocument,
  /** Set by `design.get`, so a client knows what it may do instead of guessing. */
  audience: Schema.optionalKey(DesignAudience),
});
export type DesignGetResult = typeof DesignGetResult.Type;

export const DesignCreateInput = Schema.Struct({
  owner: DesignOwnerInput,
  kind: DesignKind,
  title: Name,
  designSystem: Schema.optionalKey(Schema.NullOr(DesignSystemId)),
  /**
   * The thread to bind on creation, checked like `set_thread`: creating and
   * binding is one write, so a refused binding leaves no design behind.
   */
  thread: Schema.optionalKey(DesignThreadBinding),
  reuse: Schema.optionalKey(DesignReuse),
});
export type DesignCreateInput = typeof DesignCreateInput.Type;

export const DesignApplyInput = Schema.Struct({
  ...DesignAddress.fields,
  expectedRevision: NonNegativeInt,
  operations: Schema.Array(DesignOperation).check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
});
export type DesignApplyInput = typeof DesignApplyInput.Type;

export const DesignHistoryInput = DesignAddress;
export const DesignHistoryResult = Schema.Struct({ entries: Schema.Array(DesignHistoryEntry) });
export type DesignHistoryResult = typeof DesignHistoryResult.Type;

export const DesignSaveVersionInput = Schema.Struct({
  ...DesignAddress.fields,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
});
export type DesignSaveVersionInput = typeof DesignSaveVersionInput.Type;

export const DesignRestoreInput = Schema.Struct({
  ...DesignAddress.fields,
  revision: NonNegativeInt,
  expectedRevision: NonNegativeInt,
});
export type DesignRestoreInput = typeof DesignRestoreInput.Type;

export const DesignCopyInput = Schema.Struct({
  ...DesignAddress.fields,
  to: DesignOwnerInput,
});
export type DesignCopyInput = typeof DesignCopyInput.Type;

/**
 * Moves a Playground design into a project on the same machine. Unlike a
 * copy it keeps the design id, revision, history, versions, comments, assets,
 * access and thread binding; the old address then answers `not_found` with
 * `movedTo`. Gated by the `designMove` capability.
 */
export const DesignMoveInput = Schema.Struct({
  ...DesignAddress.fields,
  to: DesignOwnerInput,
  expectedRevision: NonNegativeInt,
});
export type DesignMoveInput = typeof DesignMoveInput.Type;

/** The largest PowerPoint file `design.importDeck` reads. */
export const DESIGN_DECK_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Imports a PowerPoint deck (.pptx) as a new slides document. A person's
 * action from the app, not an agent tool. Gated by the `designDeckImport`
 * capability.
 */
export const DesignImportDeckInput = Schema.Struct({
  owner: DesignOwnerInput,
  title: Name,
  designSystem: Schema.NullOr(DesignSystemId),
  /** Base64 .pptx bytes, at most 50 MB decoded. */
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Math.ceil(DESIGN_DECK_IMPORT_MAX_BYTES / 3) * 4),
  ),
});
export type DesignImportDeckInput = typeof DesignImportDeckInput.Type;

/** What the import could not keep on one slide (1-based), in plain words. */
export const DesignImportSkipped = Schema.Struct({
  slide: NonNegativeInt,
  items: Schema.Array(Schema.String.check(Schema.isMaxLength(300))),
});
export type DesignImportSkipped = typeof DesignImportSkipped.Type;

export const DesignImportDeckResult = Schema.Struct({
  ref: DesignRef,
  notImported: Schema.Array(DesignImportSkipped),
});
export type DesignImportDeckResult = typeof DesignImportDeckResult.Type;

/** Pictures a deck preview carries, in bytes before base64; the rest are left out. */
export const DESIGN_DECK_PREVIEW_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Reads a PowerPoint deck (.pptx) on the host for a preview, storing nothing:
 * the slides the import would make. The path is absolute, one of the host
 * files a thread's media opens from. Gated by the `designDeckPreview` capability.
 */
export const DesignPreviewDeckInput = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export type DesignPreviewDeckInput = typeof DesignPreviewDeckInput.Type;

export const DesignPreviewDeckResult = Schema.Struct({
  pages: Schema.Array(DesignPage).check(Schema.isMaxLength(DESIGN_MAX_PAGES)),
  /** Pictures by the asset name their image nodes carry, as `data:` URLs. */
  images: Schema.Record(DesignAssetName, Schema.String),
  /** Pictures left out because the preview's picture budget ran out. */
  imagesOmitted: NonNegativeInt,
  notImported: Schema.Array(DesignImportSkipped),
});
export type DesignPreviewDeckResult = typeof DesignPreviewDeckResult.Type;

export const DesignDeleteInput = DesignAddress;
export const DesignDeleteResult = Schema.Struct({ deleted: Schema.Boolean });

export const DesignAssetPutInput = Schema.Struct({
  ...DesignAddress.fields,
  mimeType: Schema.Literals([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ]),
  /** Base64 file bytes, at most 10 MiB decoded. */
  data: Schema.String.check(Schema.isMaxLength(14 * 1024 * 1024)),
});
export type DesignAssetPutInput = typeof DesignAssetPutInput.Type;
export const DesignAssetPutResult = Schema.Struct({ asset: Schema.String });

export const DesignExportInput = Schema.Struct({
  ...DesignAddress.fields,
  pageId: Id,
  /** One frame; the whole page when absent (PNG, SVG and HTML). PDF and PPTX ignore it and export every page that is not skipped: one sheet per slide of a deck, or per top-level frame of a design. */
  frameId: Schema.optionalKey(DesignNodeId),
  /** `svg` only reaches servers that advertise `designSvgExport`; older ones refuse it. */
  format: Schema.Literals(["png", "svg", "html", "pdf", "pptx"]),
  /** PNG only: device scale factor. */
  scale: Schema.optionalKey(Schema.Literals([1, 2])),
  /** Mode to resolve tokens in; the system's first mode when absent. */
  mode: Schema.optionalKey(Id),
});
export type DesignExportInput = typeof DesignExportInput.Type;

export const DesignExportResult = Schema.Struct({
  fileName: Schema.String.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals([
    "image/png",
    "image/svg+xml",
    "text/html",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]),
  /** Base64 file bytes. */
  data: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type DesignExportResult = typeof DesignExportResult.Type;

export const DesignSystemListInput = Schema.Struct({ filter: DesignOwnerFilter });
export const DesignSystemListResult = Schema.Struct({
  systems: Schema.Array(DesignSystemSummary),
  problems: Schema.Array(DesignListProblem),
});
export type DesignSystemListResult = typeof DesignSystemListResult.Type;

export const DesignSystemAddress = Schema.Struct({
  owner: DesignOwnerInput,
  systemId: DesignSystemId,
});
export type DesignSystemAddress = typeof DesignSystemAddress.Type;
export const DesignSystemGetResult = Schema.Struct({ ref: DesignSystemRef, system: DesignSystem });
export type DesignSystemGetResult = typeof DesignSystemGetResult.Type;

export const DesignSystemCopyInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  to: DesignOwnerInput,
  /**
   * Copy again when the target's newest copy of the system predates its current
   * revision. A copy already at that revision comes back instead, so a retry adds
   * none. Without it, any existing copy comes back.
   */
  fresh: Schema.optionalKey(Schema.Boolean),
});
export type DesignSystemCopyInput = typeof DesignSystemCopyInput.Type;

/** A new name for a system; the id and folder stay. The server trims it. */
export const DesignSystemRenameInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
  expectedRevision: NonNegativeInt,
});
export type DesignSystemRenameInput = typeof DesignSystemRenameInput.Type;

/** Designs that use the system keep its id and render without it. */
export const DesignSystemDeleteInput = Schema.Struct({
  ...DesignSystemAddress.fields,
  expectedRevision: NonNegativeInt,
});
export type DesignSystemDeleteInput = typeof DesignSystemDeleteInput.Type;
export const DesignSystemDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type DesignSystemDeleteResult = typeof DesignSystemDeleteResult.Type;

/** How many designs of the system's owner use it, to warn before a delete. */
export const DesignSystemUsageInput = DesignSystemAddress;
export const DesignSystemUsageResult = Schema.Struct({ designs: NonNegativeInt });
export type DesignSystemUsageResult = typeof DesignSystemUsageResult.Type;

export class DesignError extends Schema.TaggedError<DesignError>()("DesignError", {
  code: Schema.Literals([
    "not_found",
    "not_on_this_machine",
    "invalid",
    "conflict",
    "forbidden",
    "too_large",
    "operation_failed",
  ]),
  detail: Schema.String,
  /** Conflicts only: the revision now on disk. */
  currentRevision: Schema.optionalKey(NonNegativeInt),
  /** `not_on_this_machine` only: the logical-project member that has the design. */
  member: Schema.optionalKey(Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId })),
  /** `not_found` only: the design moved here, and the caller may open it there. */
  movedTo: Schema.optionalKey(Schema.Struct({ owner: DesignOwnerInput, designId: DesignId })),
}) {
  override get message(): string {
    return this.detail;
  }
}
