/**
 * Pure rules for design-system import: what a review writes, how proposals,
 * sources and owners read in the UI, and reading picked tokens files.
 */
import {
  DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES,
  type DesignActor,
  type DesignOwner,
  type DesignOwnerInput,
  type DesignProvenance,
  type DesignSystemChangeKind,
  type DesignSystemComponentChange,
  type DesignSystemConfirmInput,
  type DesignSystemProposal,
  type DesignSystemProposalOrigin,
  type DesignSystemScanSkip,
  type DesignSystemSuggestion,
  type DesignSystemSource,
  type DesignSystemSummary,
  type DesignSystemTokenChange,
  type DesignSystemTokensFile,
  type DesignTokenValue,
  type ProjectId,
} from "@specweave-studio/contracts";

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

export interface OwnerProject {
  readonly id: ProjectId;
  readonly title: string;
  /** "personal" projects have no code to read; "code" when omitted. */
  readonly kind?: "code" | "personal" | undefined;
  /**
   * Why the project is not offered as a place to save (archived, automated), as a
   * picker says it; omitted for the person's own projects.
   */
  readonly unavailable?: string | undefined;
}

/** The projects a picker offers: never an archived or automated one; `code` also drops personal ones. */
export function offeredProjects<P extends OwnerProject>(
  projects: readonly P[],
  purpose: "design" | "code" = "design",
): P[] {
  return projects.filter(
    (project) =>
      project.unavailable === undefined && (purpose === "design" || project.kind !== "personal"),
  );
}

/** Why the owner is not a place to save, for a picker's disabled current row; null when it is. */
export function ownerUnavailable(
  owner: DesignOwnerInput,
  projects: readonly OwnerProject[],
): string | null {
  if (owner.kind === "playground") return null;
  return projects.find((project) => project.id === owner.projectId)?.unavailable ?? null;
}

export const PLAYGROUND_KEY = "playground";

export function ownerKey(owner: DesignOwnerInput): string {
  return owner.kind === "playground" ? PLAYGROUND_KEY : `p:${owner.projectId}`;
}

export function ownerFromKey(key: string): DesignOwnerInput {
  return key.startsWith("p:")
    ? { kind: "project", projectId: key.slice(2) as ProjectId }
    : { kind: "playground" };
}

export function ownerOfSummary(summary: DesignSystemSummary): DesignOwnerInput {
  const owner = summary.ref.owner;
  return owner.kind === "playground"
    ? { kind: "playground" }
    : { kind: "project", projectId: owner.projectId };
}

export function sameOwner(left: DesignOwnerInput, right: DesignOwnerInput): boolean {
  return ownerKey(left) === ownerKey(right);
}

/**
 * Whether two stored owners are one, machine included, as the server matches a
 * copy's source: a repository checked out on two machines holds two sources.
 */
export function sameDesignOwner(left: DesignOwner, right: DesignOwner): boolean {
  return (
    left.kind === right.kind &&
    left.environmentId === right.environmentId &&
    (left.kind === "playground" || (right.kind === "project" && left.projectId === right.projectId))
  );
}

/**
 * The copy in `own` that the server returns for a copy of `source`: the one of
 * the highest source revision, the latest made among those.
 */
export function copyIn(
  own: readonly DesignSystemSummary[],
  source: DesignSystemSummary,
): DesignSystemSummary | undefined {
  return own
    .filter(
      (system) =>
        system.copiedFrom !== undefined &&
        system.copiedFrom.id === source.ref.systemId &&
        sameDesignOwner(system.copiedFrom.owner, source.ref.owner),
    )
    .toSorted(
      (left, right) =>
        right.copiedFrom!.revision - left.copiedFrom!.revision ||
        right.copiedFrom!.copiedAt.localeCompare(left.copiedFrom!.copiedAt),
    )[0];
}

/** Whether `copy` was made before `source`'s latest change: the source moved past the revision it copied. */
export function copyPredatesSource(copy: DesignSystemSummary, source: DesignSystemSummary) {
  return copy.copiedFrom !== undefined && source.revision > copy.copiedFrom.revision;
}

export function ownerName(owner: DesignOwnerInput, projects: readonly OwnerProject[]): string {
  if (owner.kind === "playground") return "Playground";
  return projects.find((project) => project.id === owner.projectId)?.title ?? "A project";
}

// ---------------------------------------------------------------------------
// Systems list
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "Code · 2 files", "Tokens file", "Figma desktop + Code · 1 file". */
export function sourcesLabel(sources: readonly DesignSystemSource[]): string {
  if (sources.length === 0) return "None";
  const count = (kind: DesignSystemSource["kind"]) =>
    sources.filter((source) => source.kind === kind).length;
  const parts: string[] = [];
  const files = count("file");
  if (files > 0) parts.push(`Code · ${plural(files, "file")}`);
  const exports = count("figma-export");
  // Uploaded token files are stored as "figma-export" whether Figma or another tool wrote them.
  if (exports > 0) parts.push(exports === 1 ? "Tokens file" : `Tokens files · ${exports}`);
  if (count("figma-desktop") > 0) parts.push("Figma desktop");
  if (count("agent") > 0) parts.push("Described by an agent");
  return parts.join(" + ");
}

/** Rescan re-reads project files only; a system with any other source is imported again instead. */
export function isRescannable(summary: DesignSystemSummary): boolean {
  return (
    summary.ref.owner.kind === "project" &&
    summary.sources.length > 0 &&
    summary.sources.every((source) => source.kind === "file")
  );
}

export function filterSystems(
  systems: readonly DesignSystemSummary[],
  query: string,
): DesignSystemSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches =
    needle === ""
      ? [...systems]
      : systems.filter((system) => system.name.toLocaleLowerCase().includes(needle));
  return matches.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.ownerLabel.localeCompare(right.ownerLabel),
  );
}

export function systemKey(summary: DesignSystemSummary): string {
  return `${ownerKey(ownerOfSummary(summary))}:${summary.ref.systemId}`;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const ORIGIN_LABELS: Record<DesignSystemProposalOrigin, string> = {
  code: "From code",
  "tokens-file": "From a tokens file",
  "figma-desktop": "From Figma desktop",
  agent: "Described by an agent",
};

/** "Proposed by you" or "Proposed by an agent in thread Pricing page". */
export function proposerLabel(actor: DesignActor, threadTitle: string | null): string {
  if (actor.kind === "user") return "Proposed by you";
  return `Proposed by an agent in thread ${threadTitle ?? actor.threadId}`;
}

/** "From code · Atlas web · Proposed by you"; an agent's description names its thread once. */
export function proposalMeta(
  origin: DesignSystemProposalOrigin,
  ownerLabel: string,
  actor: DesignActor,
  threadTitle: string | null,
): string {
  const by = proposerLabel(actor, threadTitle);
  return origin === "agent" && actor.kind === "agent"
    ? `${ownerLabel} · ${by}`
    : `${ORIGIN_LABELS[origin]} · ${ownerLabel} · ${by}`;
}

export const CHANGE_GROUPS = [
  { change: "added", title: "New", hint: "Ticked items are added." },
  { change: "changed", title: "Changed", hint: "Unticked items keep their current value." },
  { change: "removed", title: "Removed", hint: "Unticked items stay in the system." },
] as const satisfies ReadonlyArray<{ change: DesignSystemChangeKind; title: string; hint: string }>;

export function groupByChange<T extends { readonly change: DesignSystemChangeKind }>(
  changes: readonly T[],
): Record<DesignSystemChangeKind, T[]> {
  const groups: Record<DesignSystemChangeKind, T[]> = {
    added: [],
    changed: [],
    removed: [],
    unchanged: [],
  };
  for (const change of changes) groups[change.change].push(change);
  return groups;
}

/** Items the user unticked; everything else is written as proposed. */
export interface ReviewSelection {
  readonly tokens: ReadonlySet<string>;
  readonly components: ReadonlySet<string>;
  /** Stored paths of brand files. */
  readonly files: ReadonlySet<string>;
}

export const EMPTY_SELECTION: ReviewSelection = {
  tokens: new Set(),
  components: new Set(),
  files: new Set(),
};

export function toggleItems(
  selection: ReviewSelection,
  kind: keyof ReviewSelection,
  keys: readonly string[],
  ticked: boolean,
): ReviewSelection {
  const next = new Set(selection[kind]);
  for (const key of keys) {
    if (ticked) next.delete(key);
    else next.add(key);
  }
  return { ...selection, [kind]: next };
}

const writes = (change: { readonly change: DesignSystemChangeKind }) =>
  change.change !== "unchanged";

/** Ticked items that change the system; zero means confirming would write nothing. */
export function writeCount(proposal: DesignSystemProposal, selection: ReviewSelection): number {
  const tokens = proposal.tokens.filter(
    (change) => writes(change) && !selection.tokens.has(change.name),
  ).length;
  const components = proposal.components.filter(
    (change) => writes(change) && !selection.components.has(change.id),
  ).length;
  const files = (proposal.files ?? []).filter((file) => !selection.files.has(file.path)).length;
  return tokens + components + files;
}

/** The confirm request: unticked names and ids that would change something, plus a new name. */
export function buildConfirmInput(
  proposal: DesignSystemProposal,
  selection: ReviewSelection,
  name: string,
): DesignSystemConfirmInput {
  const excludeTokens = proposal.tokens
    .filter((change) => writes(change) && selection.tokens.has(change.name))
    .map((change) => change.name);
  const excludeComponents = proposal.components
    .filter((change) => writes(change) && selection.components.has(change.id))
    .map((change) => change.id);
  const excludeFiles = (proposal.files ?? [])
    .filter((file) => selection.files.has(file.path))
    .map((file) => file.path);
  const trimmed = name.trim();
  return {
    proposalId: proposal.id,
    excludeTokens,
    excludeComponents,
    ...(excludeFiles.length > 0 ? { excludeFiles } : {}),
    ...(proposal.target === null && trimmed !== "" ? { name: trimmed.slice(0, 180) } : {}),
  };
}

export function proposalCounts(proposal: DesignSystemProposal) {
  const all: ReadonlyArray<DesignSystemTokenChange | DesignSystemComponentChange> = [
    ...proposal.tokens,
    ...proposal.components,
  ];
  return {
    added: all.filter((change) => change.change === "added").length,
    changed: all.filter((change) => change.change === "changed").length,
    removed: all.filter((change) => change.change === "removed").length,
    findings: proposal.findings.length,
  };
}

export function countsLabel(counts: {
  added: number;
  changed: number;
  removed: number;
  findings: number;
}): string {
  const parts = [
    counts.added > 0 ? `${counts.added} new` : null,
    counts.changed > 0 ? `${counts.changed} changed` : null,
    counts.removed > 0 ? `${counts.removed} removed` : null,
    counts.findings > 0 ? plural(counts.findings, "finding") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "No changes" : parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Values and provenance
// ---------------------------------------------------------------------------

export function locationLabel(provenance: Pick<DesignProvenance, "location" | "line">): string {
  return provenance.line === undefined
    ? provenance.location
    : `${provenance.location}:${provenance.line}`;
}

export function displayValue(value: DesignTokenValue | undefined): string {
  if (value === undefined) return "—";
  return value.resolved ?? value.raw;
}

/** Characters a color function's arguments may use: no quotes, colons or `url(`. */
const ARGUMENTS = "[-+0-9.%a-z\\s,/#]*";
const COLOR_PATTERN = new RegExp(
  `^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})` +
    `|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\\(${ARGUMENTS}\\)` +
    `|color-mix\\((?:[-+0-9.%a-z\\s,/#]|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\\(${ARGUMENTS}\\))*\\))$`,
  "i",
);

/**
 * A value the swatch can paint: the whole string must be one color (hex or a
 * color function with plain arguments), so a token cannot smuggle in
 * `url(...)`. References that did not resolve get no swatch. Painted with
 * `backgroundColor`, which never loads anything.
 */
export function swatchColor(value: DesignTokenValue | undefined): string | null {
  const resolved = value?.resolved?.trim();
  if (!resolved || resolved.length > 200 || !COLOR_PATTERN.test(resolved)) return null;
  return resolved;
}

/** Mode ids that appear on this token, in the system's mode order. */
export function tokenModes(
  change: DesignSystemTokenChange,
  modes: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  const ids = new Set([
    ...Object.keys(change.token.values),
    ...Object.keys(change.previous?.values ?? {}),
  ]);
  const known = modes.filter((mode) => ids.has(mode.id));
  const extra = [...ids]
    .filter((id) => !modes.some((mode) => mode.id === id))
    .map((id) => ({ id, name: id }));
  return [...known, ...extra];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface DesignErrorLike {
  readonly _tag: "DesignError";
  readonly code: string;
  readonly detail: string;
  readonly currentRevision?: number;
}

const isDesignError = (cause: unknown): cause is DesignErrorLike =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { _tag?: unknown })._tag === "DesignError";

/** A plain sentence for a failed command; a revision conflict says what to do next. */
export function failureText(cause: unknown, fallback: string): string {
  if (isDesignError(cause) && cause.code === "conflict") {
    const now =
      cause.currentRevision === undefined
        ? ""
        : ` (it is now at revision ${cause.currentRevision})`;
    return `This design system changed after the proposal was made${now}. Discard this proposal and rescan or import again to review the latest version.`;
  }
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (isDesignError(cause) && cause.detail.trim() !== "") return cause.detail;
  return fallback;
}

// ---------------------------------------------------------------------------
// Scan and tokens files
// ---------------------------------------------------------------------------

export const SKIP_REASON_LABELS: Record<DesignSystemScanSkip["reason"], string> = {
  "symlink-outside-root": "Link that points outside the project",
  excluded: "Link to a hidden, ignored or secret file",
  "too-large": "Larger than 2 MB",
  unreadable: "Could not be read",
  unparseable: "Could not be parsed, or nested too deeply",
  limit: "Over the 400-file limit",
  budget: "Over the scan's 32 MB or 4,000-file read budget",
};

/** "Derived from Weave.", and whether this owner holds Weave to point at. */
export const lineageText = (
  suggestion: Pick<DesignSystemSuggestion, "derivedFrom" | "derivedFromLabel">,
) =>
  suggestion.derivedFromLabel === undefined
    ? ""
    : suggestion.derivedFrom
      ? `Derived from ${suggestion.derivedFromLabel}.`
      : `Derived from ${suggestion.derivedFromLabel} (not among this owner's design systems).`;

export const CANDIDATE_KIND_LABELS = {
  weave: "Weave tokens",
  dtcg: "Design tokens (DTCG)",
  "token-json": "Tokens JSON",
  css: "CSS variables",
  "ts-theme": "TypeScript theme",
  components: "Components",
} as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type TokensFileRead =
  | { readonly ok: true; readonly files: DesignSystemTokensFile[] }
  | { readonly ok: false; readonly message: string };

/** Reads picked files as text in the browser; nothing leaves the app until Propose. */
export async function readTokensFiles(
  files: ReadonlyArray<Pick<File, "name" | "size" | "text">>,
): Promise<TokensFileRead> {
  if (files.length === 0) return { ok: false, message: "Choose at least one .json file." };
  if (files.length > 20) return { ok: false, message: "Choose at most 20 files at a time." };
  const wrongType = files.find((file) => !file.name.toLowerCase().endsWith(".json"));
  if (wrongType) return { ok: false, message: `${wrongType.name} is not a .json file.` };
  const tooLarge = files.find((file) => file.size > DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES);
  if (tooLarge) return { ok: false, message: `${tooLarge.name} is larger than 2 MB.` };
  try {
    const read = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name.slice(0, 255),
        contents: await file.text(),
      })),
    );
    return { ok: true, files: read };
  } catch {
    return { ok: false, message: "A file could not be read. Pick it again." };
  }
}

/** "Brand copy", or "Brand copy 2"… when a sibling already has that name. */
export function duplicateSystemName(name: string, siblings: readonly string[]): string {
  const used = new Set(siblings.map((sibling) => sibling.trim().toLowerCase()));
  const base = `${name.trim().slice(0, 170).trimEnd()} copy`;
  if (!used.has(base.toLowerCase())) return base;
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}
