import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import {
  DesignActor,
  DesignOwnerFilter,
  DesignOwnerInput,
  DesignSystem,
  DesignSystemComponent,
  DesignSystemId,
  DesignSystemLineage,
  DesignSystemSource,
  DesignToken,
} from "./design.ts";

/**
 * Importing a design system is always a review: a scan lists candidate files,
 * a proposal shows what would change, and only items the user confirms are
 * written as a new revision of the system. Extraction is deterministic (same
 * bytes, same proposal) and never reads outside the owner's root.
 */
export const DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DESIGN_SYSTEM_IMPORT_MAX_CANDIDATES = 400;
/** What one scan may read in total; files past it are listed as skipped (`budget`). */
export const DESIGN_SYSTEM_IMPORT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
export const DESIGN_SYSTEM_IMPORT_MAX_SCAN_FILES = 4_000;
export const FIGMA_DESKTOP_MCP_URL = "http://127.0.0.1:3845/mcp";

const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ProposalId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export const DesignSystemProposalId = ProposalId;
export type DesignSystemProposalId = typeof DesignSystemProposalId.Type;

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export const DesignSystemCandidateKind = Schema.Literals([
  /** Weave-style `tokens.json` (named groups, per-theme values, usage notes). */
  "weave",
  /** W3C design tokens (`$value`/`$type`), including Figma's variables export. */
  "dtcg",
  /** Tokens Studio or Style Dictionary JSON (`value`/`type`). */
  "token-json",
  /** CSS with custom properties, including Tailwind v4 `@theme`. */
  "css",
  /** TypeScript theme objects written as literals. */
  "ts-theme",
  /** A TypeScript barrel (`index.ts`) that exports components. */
  "components",
]);
export type DesignSystemCandidateKind = typeof DesignSystemCandidateKind.Type;

export const DesignSystemCandidate = Schema.Struct({
  /** Path relative to the owner's root, with `/` separators. */
  path: Path,
  kind: DesignSystemCandidateKind,
  sha256: Sha256,
  bytes: NonNegativeInt,
  tokenCount: NonNegativeInt,
  componentCount: NonNegativeInt,
  /** Mode ids the file declares (`light`, `dark`, `iris-light`). */
  modes: Schema.Array(Schema.String.check(Schema.isMaxLength(120))),
  /** Key of the suggested system this file belongs to. */
  suggestion: Schema.String.check(Schema.isMaxLength(200)),
});
export type DesignSystemCandidate = typeof DesignSystemCandidate.Type;

/** Most swatches and sources one suggestion preview carries. */
export const DESIGN_SYSTEM_PREVIEW_MAX_SWATCHES = 8;
export const DESIGN_SYSTEM_PREVIEW_MAX_SOURCES = 12;

export const DesignSystemPreviewSwatch = Schema.Struct({
  /** Token name without the leading `--`. */
  name: Schema.String.check(Schema.isMaxLength(200)),
  /** CSS color in the light (or only) mode, references resolved. */
  value: Schema.String.check(Schema.isMaxLength(200)),
  /** The same color in the dark mode, when the system has one. */
  darkValue: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type DesignSystemPreviewSwatch = typeof DesignSystemPreviewSwatch.Type;

export const DesignSystemPreviewSource = Schema.Struct({
  path: Path,
  kind: DesignSystemCandidateKind,
  /** Tokens the scan counted in this file (custom properties, theme keys). */
  tokens: NonNegativeInt,
  components: NonNegativeInt,
});
export type DesignSystemPreviewSource = typeof DesignSystemPreviewSource.Type;

/**
 * What a suggestion would import, read in memory without creating a proposal:
 * tokens extracted from its token files, components counted from its
 * component sources, a few colors to show, and the biggest sources.
 */
export const DesignSystemSuggestionPreview = Schema.Struct({
  tokens: NonNegativeInt,
  components: NonNegativeInt,
  modes: Schema.Array(Schema.String.check(Schema.isMaxLength(120))),
  swatches: Schema.Array(DesignSystemPreviewSwatch).check(
    Schema.isMaxLength(DESIGN_SYSTEM_PREVIEW_MAX_SWATCHES),
  ),
  sources: Schema.Array(DesignSystemPreviewSource).check(
    Schema.isMaxLength(DESIGN_SYSTEM_PREVIEW_MAX_SOURCES),
  ),
});
export type DesignSystemSuggestionPreview = typeof DesignSystemSuggestionPreview.Type;

/** Suggestions come strongest first: most tokens and components, then by key. */
export const DesignSystemSuggestion = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(200)),
  name: Schema.String.check(Schema.isMaxLength(180)),
  /** Candidate paths selected by default for this system. */
  paths: Schema.Array(Path),
  /** Copies of this system's files elsewhere in the root (compared, not imported). */
  copies: Schema.Array(Path),
  /** The owner's own system this one derives from, only when the owner holds it. */
  derivedFrom: Schema.optionalKey(DesignSystemLineage),
  /** Informational name of the upstream system ("Weave"), never an id. */
  derivedFromLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
  /** Filled for the top suggestions when the scan asked for `preview`. */
  preview: Schema.optionalKey(DesignSystemSuggestionPreview),
});
export type DesignSystemSuggestion = typeof DesignSystemSuggestion.Type;

export const DesignSystemScanSkip = Schema.Struct({
  path: Path,
  /**
   * `unparseable`: the file could not be read as CSS, JSON or TypeScript; the scan went on.
   * `excluded`: a link to a hidden, ignored or secret file. `budget`: past the scan's read budget.
   */
  reason: Schema.Literals([
    "symlink-outside-root",
    "excluded",
    "too-large",
    "unreadable",
    "unparseable",
    "limit",
    "budget",
  ]),
});
export type DesignSystemScanSkip = typeof DesignSystemScanSkip.Type;

export const DesignSystemScanInput = Schema.Struct({
  owner: DesignOwnerInput,
  /** Also preview the top suggestions (counts, modes, swatches); nothing is written. */
  preview: Schema.optionalKey(Schema.Boolean),
});
export type DesignSystemScanInput = typeof DesignSystemScanInput.Type;

export const DesignSystemScanResult = Schema.Struct({
  candidates: Schema.Array(DesignSystemCandidate),
  suggestions: Schema.Array(DesignSystemSuggestion),
  skipped: Schema.Array(DesignSystemScanSkip),
  /** Files looked at by name; only candidates were read. */
  filesSeen: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type DesignSystemScanResult = typeof DesignSystemScanResult.Type;

// ---------------------------------------------------------------------------
// Proposals and review
// ---------------------------------------------------------------------------

export const DesignSystemFinding = Schema.Struct({
  /** Stable code: `drift`, `cycle`, `unresolved`, `mismatch`, `skipped`, `only-in-json`. */
  code: Schema.String.check(Schema.isMaxLength(60)),
  severity: Schema.Literals(["info", "warning"]),
  message: Schema.String.check(Schema.isMaxLength(2_000)),
  location: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  line: Schema.optionalKey(NonNegativeInt),
});
export type DesignSystemFinding = typeof DesignSystemFinding.Type;

export const DesignSystemChangeKind = Schema.Literals(["added", "changed", "removed", "unchanged"]);
export type DesignSystemChangeKind = typeof DesignSystemChangeKind.Type;

export const DesignSystemTokenChange = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(200)),
  change: DesignSystemChangeKind,
  /** The proposed token; the current one when removed. */
  token: DesignToken,
  previous: Schema.optionalKey(DesignToken),
});
export type DesignSystemTokenChange = typeof DesignSystemTokenChange.Type;

export const DesignSystemComponentChange = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(200)),
  change: DesignSystemChangeKind,
  component: DesignSystemComponent,
  previous: Schema.optionalKey(DesignSystemComponent),
});
export type DesignSystemComponentChange = typeof DesignSystemComponentChange.Type;

export const DesignSystemProposalOrigin = Schema.Literals([
  "code",
  "tokens-file",
  "figma-desktop",
  "agent",
]);
export type DesignSystemProposalOrigin = typeof DesignSystemProposalOrigin.Type;

export const DesignSystemProposal = Schema.Struct({
  id: DesignSystemProposalId,
  owner: DesignOwnerInput,
  origin: DesignSystemProposalOrigin,
  createdAt: Schema.String,
  createdBy: DesignActor,
  /** The system this proposal updates; null for a new system. */
  target: Schema.NullOr(Schema.Struct({ systemId: DesignSystemId, revision: NonNegativeInt })),
  /** The system as it would be written if every item were confirmed. */
  system: DesignSystem,
  tokens: Schema.Array(DesignSystemTokenChange),
  components: Schema.Array(DesignSystemComponentChange),
  findings: Schema.Array(DesignSystemFinding),
});
export type DesignSystemProposal = typeof DesignSystemProposal.Type;

export const DesignSystemProposalSummary = Schema.Struct({
  id: DesignSystemProposalId,
  owner: DesignOwnerInput,
  origin: DesignSystemProposalOrigin,
  createdAt: Schema.String,
  createdBy: DesignActor,
  name: Schema.String.check(Schema.isMaxLength(180)),
  target: Schema.NullOr(Schema.Struct({ systemId: DesignSystemId, revision: NonNegativeInt })),
  counts: Schema.Struct({
    added: NonNegativeInt,
    changed: NonNegativeInt,
    removed: NonNegativeInt,
    findings: NonNegativeInt,
  }),
});
export type DesignSystemProposalSummary = typeof DesignSystemProposalSummary.Type;

export const DesignSystemTokensFile = Schema.Struct({
  /** File name as the user picked it; only used for provenance and mode names. */
  fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  contents: Schema.String.check(Schema.isMaxLength(DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES)),
});
export type DesignSystemTokensFile = typeof DesignSystemTokensFile.Type;

const proposeCommon = {
  /** Name for a new system; ignored when updating `targetSystemId`. */
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(180))),
  targetSystemId: Schema.optionalKey(DesignSystemId),
};

export const DesignSystemProposeFrom = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("code"),
    /** Candidate paths from a scan, relative to the project root. */
    paths: Schema.Array(Path).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    ...proposeCommon,
  }),
  Schema.Struct({
    kind: Schema.Literal("tokens-file"),
    files: Schema.Array(DesignSystemTokensFile).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
    ...proposeCommon,
  }),
  Schema.Struct({
    kind: Schema.Literal("figma-desktop"),
    /** Figma node to read; the current selection in Figma when absent. */
    nodeId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
    ...proposeCommon,
  }),
]);
export type DesignSystemProposeFrom = typeof DesignSystemProposeFrom.Type;

export const DesignSystemProposeInput = Schema.Struct({
  owner: DesignOwnerInput,
  from: DesignSystemProposeFrom,
});
export type DesignSystemProposeInput = typeof DesignSystemProposeInput.Type;

export const DesignSystemProposalsInput = Schema.Struct({ filter: DesignOwnerFilter });
export type DesignSystemProposalsInput = typeof DesignSystemProposalsInput.Type;
export const DesignSystemProposalsResult = Schema.Struct({
  proposals: Schema.Array(DesignSystemProposalSummary),
});
export type DesignSystemProposalsResult = typeof DesignSystemProposalsResult.Type;

export const DesignSystemProposalAddress = Schema.Struct({ proposalId: DesignSystemProposalId });
export type DesignSystemProposalAddress = typeof DesignSystemProposalAddress.Type;

export const DesignSystemConfirmInput = Schema.Struct({
  proposalId: DesignSystemProposalId,
  /** Token names the user unticked. */
  excludeTokens: Schema.Array(Schema.String.check(Schema.isMaxLength(200))),
  /** Component ids the user unticked. */
  excludeComponents: Schema.Array(Schema.String.check(Schema.isMaxLength(200))),
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180))),
});
export type DesignSystemConfirmInput = typeof DesignSystemConfirmInput.Type;

export const DesignSystemDiscardResult = Schema.Struct({ discarded: Schema.Boolean });

export const DesignSystemRescanInput = Schema.Struct({
  owner: DesignOwnerInput,
  systemId: DesignSystemId,
});
export type DesignSystemRescanInput = typeof DesignSystemRescanInput.Type;

export const DesignSystemRescanResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    /** Sources whose hash matched; none were parsed. */
    checked: Schema.Array(DesignSystemSource),
  }),
  Schema.Struct({
    status: Schema.Literal("changed"),
    changed: Schema.Array(Path),
    missing: Schema.Array(Path),
    proposal: DesignSystemProposal,
  }),
  Schema.Struct({
    /** Sources that are not files in the project (exports, Figma, agent). */
    status: Schema.Literal("not-rescannable"),
    detail: Schema.String,
  }),
]);
export type DesignSystemRescanResult = typeof DesignSystemRescanResult.Type;

// ---------------------------------------------------------------------------
// Figma desktop
// ---------------------------------------------------------------------------

export const FigmaDesktopTool = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(200)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type FigmaDesktopTool = typeof FigmaDesktopTool.Type;

export const FigmaDesktopStatus = Schema.Struct({
  state: Schema.Literals(["connected", "off", "error"]),
  endpoint: Schema.String,
  tools: Schema.Array(FigmaDesktopTool),
  /** The listed tool used to read variables, or null when none is listed. */
  variablesTool: Schema.NullOr(Schema.String),
  serverName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type FigmaDesktopStatus = typeof FigmaDesktopStatus.Type;
