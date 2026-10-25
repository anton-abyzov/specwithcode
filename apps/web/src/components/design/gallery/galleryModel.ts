/**
 * Pure rules for the Design gallery: which owner a URL scopes it to, the
 * owner chips and per-project sections, search, the edited-ago label and
 * which "Make something new" kinds this build offers.
 */
import {
  ProjectId,
  type DesignOwnerInput,
  type DesignSummary,
  type DesignSystemId,
} from "@specweave-studio/contracts";

import { DESIGN_FEATURES } from "../designFeatures";

/** Legacy `?tab=` values; `projects` still means "every project". */
export const GALLERY_TABS = ["all", "playground", "projects"] as const;
export type GalleryTab = (typeof GALLERY_TABS)[number];

export type GalleryView = "grid" | "list";

/** Which owners the gallery shows. A project scope is one project's designs. */
export type GalleryScope =
  | { readonly kind: "all" }
  | { readonly kind: "playground" }
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly projectId: ProjectId };

/** How the All scope lays designs out: one section per owner, or one recent list. */
export const GALLERY_GROUPINGS = ["project", "recent"] as const;
export type GalleryGrouping = (typeof GALLERY_GROUPINGS)[number];

export interface GalleryFilter {
  readonly scope: GalleryScope;
  readonly query: string;
}

/**
 * `/design` search params. `project` (any tab), `tab` and `group` are the
 * gallery view; `new`, `system` and `owner` ask the page to open New design
 * once, preselected. The editor route `/design/$designKey` inherits them and
 * ignores them.
 */
export interface DesignGallerySearch {
  readonly tab?: GalleryTab;
  readonly project?: ProjectId;
  readonly group?: GalleryGrouping;
  readonly new?: "design";
  readonly system?: DesignSystemId;
  /** `playground`, or a ProjectId. */
  readonly owner?: string;
}

const text = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= limit &&
    ![...trimmed].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    ? trimmed
    : null;
};

/** Drops anything malformed, so a hand-edited URL never breaks the page. */
export function parseDesignGallerySearch(raw: Record<string, unknown>): DesignGallerySearch {
  const tab = GALLERY_TABS.find((value) => value === raw.tab);
  const group = GALLERY_GROUPINGS.find((value) => value === raw.group);
  const project = text(raw.project, 512);
  const system = text(raw.system, 80);
  const owner = text(raw.owner, 512);
  return {
    ...(tab ? { tab } : {}),
    ...(project ? { project: ProjectId.make(project) } : {}),
    ...(group ? { group } : {}),
    ...(raw.new === "design" ? { new: "design" as const } : {}),
    ...(system && /^[A-Za-z0-9_-]+$/.test(system) ? { system: system as DesignSystemId } : {}),
    ...(owner ? { owner } : {}),
  };
}

/**
 * The scope a `/design` URL names. `?project=` wins on any tab, so the old
 * `?tab=projects&project=` links and the plain `?project=` both land on that
 * project; `?tab=projects` alone is every project.
 */
export function resolveScope(search: DesignGallerySearch): GalleryScope {
  if (search.project !== undefined) return { kind: "project", projectId: search.project };
  if (search.tab === "playground") return { kind: "playground" };
  if (search.tab === "projects") return { kind: "projects" };
  return { kind: "all" };
}

/** The search params for a scope; All with no grouping choice is the bare `/design`. */
export function searchForScope(
  scope: GalleryScope,
  group?: GalleryGrouping | undefined,
): DesignGallerySearch {
  const base: DesignGallerySearch =
    scope.kind === "project"
      ? { project: scope.projectId }
      : scope.kind === "all"
        ? {}
        : { tab: scope.kind };
  return group === undefined ? base : { ...base, group };
}

/** Kept for links built from the older tab and project pair. */
export function gallerySearchFor(filter: {
  readonly tab: GalleryTab;
  readonly projectId: ProjectId | null;
}): DesignGallerySearch {
  if (filter.projectId !== null) return { project: filter.projectId };
  return filter.tab === "all" ? {} : { tab: filter.tab };
}

export function sameScope(a: GalleryScope, b: GalleryScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "project" || a.projectId === (b as { projectId: ProjectId }).projectId;
}

export function inScope(summary: DesignSummary, scope: GalleryScope): boolean {
  const owner = summary.ref.owner;
  if (scope.kind === "all") return true;
  if (scope.kind === "playground") return owner.kind === "playground";
  if (owner.kind !== "project") return false;
  return scope.kind === "projects" || owner.projectId === scope.projectId;
}

/** A project's name: the window's own title for it, else what the server called it. */
export function projectLabel(
  projectId: ProjectId,
  projects: readonly { readonly id: ProjectId; readonly title: string }[],
  designs: readonly DesignSummary[] = [],
): string {
  return (
    projects.find((project) => project.id === projectId)?.title ??
    designs.find(
      (summary) =>
        summary.ref.owner.kind === "project" && summary.ref.owner.projectId === projectId,
    )?.ownerLabel ??
    "Project"
  );
}

/** "All", "Playground", "EasyChamp": the scope as the search field and empty state name it. */
export function scopeLabel(
  scope: GalleryScope,
  projects: readonly { readonly id: ProjectId; readonly title: string }[],
  designs: readonly DesignSummary[] = [],
): string {
  if (scope.kind === "all") return "All";
  if (scope.kind === "playground") return "Playground";
  if (scope.kind === "projects") return "Projects";
  return projectLabel(scope.projectId, projects, designs);
}

/** One owner chip: the Playground, or a project that owns at least one design. */
export interface OwnerChip {
  readonly scope: GalleryScope;
  readonly label: string;
  readonly count: number;
  /** Newest edit, in ms; chips sort by it. */
  readonly latest: number;
}

const time = (summary: DesignSummary) => {
  const at = Date.parse(summary.updatedAt);
  return Number.isFinite(at) ? at : 0;
};

/**
 * The Playground's count, then one chip per project with designs, most
 * recently edited first. The page shows the first few and folds the rest
 * into More.
 */
export function ownerChips(
  designs: readonly DesignSummary[],
  projects: readonly { readonly id: ProjectId; readonly title: string }[],
): { readonly playground: number; readonly projects: readonly OwnerChip[] } {
  let playground = 0;
  const byProject = new Map<ProjectId, { count: number; latest: number }>();
  for (const summary of designs) {
    const owner = summary.ref.owner;
    if (owner.kind === "playground") {
      playground += 1;
      continue;
    }
    const entry = byProject.get(owner.projectId) ?? { count: 0, latest: 0 };
    entry.count += 1;
    entry.latest = Math.max(entry.latest, time(summary));
    byProject.set(owner.projectId, entry);
  }
  const chips = [...byProject].map(([projectId, entry]) => ({
    scope: { kind: "project", projectId } as const,
    label: projectLabel(projectId, projects, designs),
    count: entry.count,
    latest: entry.latest,
  }));
  return {
    playground,
    projects: chips.toSorted((a, b) => b.latest - a.latest || a.label.localeCompare(b.label)),
  };
}

/**
 * Projects most recently active first, for the creation pickers: a project's latest
 * design or its own last change, whichever is newer; then by title.
 */
export function byRecentActivity<
  P extends { readonly id: ProjectId; readonly title: string; readonly updatedAt?: string },
>(projects: readonly P[], designs: readonly DesignSummary[]): P[] {
  const latest = new Map<ProjectId, number>();
  for (const summary of designs) {
    const owner = summary.ref.owner;
    if (owner.kind !== "project") continue;
    latest.set(owner.projectId, Math.max(latest.get(owner.projectId) ?? 0, time(summary)));
  }
  const activity = (project: P) => {
    const own = project.updatedAt === undefined ? 0 : Date.parse(project.updatedAt);
    return Math.max(latest.get(project.id) ?? 0, Number.isFinite(own) ? own : 0);
  };
  return projects.toSorted(
    (left, right) => activity(right) - activity(left) || left.title.localeCompare(right.title),
  );
}

/** One owner's designs in the grouped All view. */
export interface GallerySection {
  readonly key: string;
  readonly scope: GalleryScope;
  readonly label: string;
  /** Newest first. */
  readonly designs: readonly DesignSummary[];
}

/** One section per project, most recently edited first, then the Playground. */
export function groupByOwner(
  designs: readonly DesignSummary[],
  projects: readonly { readonly id: ProjectId; readonly title: string }[],
): GallerySection[] {
  const sorted = designs.toSorted((a, b) => time(b) - time(a));
  const sections = new Map<string, { scope: GalleryScope; items: DesignSummary[] }>();
  for (const summary of sorted) {
    const owner = summary.ref.owner;
    const key = owner.kind === "playground" ? "playground" : `project:${owner.projectId}`;
    const scope: GalleryScope =
      owner.kind === "playground"
        ? { kind: "playground" }
        : { kind: "project", projectId: owner.projectId };
    const section = sections.get(key) ?? { scope, items: [] };
    section.items.push(summary);
    sections.set(key, section);
  }
  const result = [...sections].map(([key, section]) => ({
    key,
    scope: section.scope,
    label: scopeLabel(section.scope, projects, designs),
    designs: section.items,
  }));
  // Insertion order follows the newest design, so projects already sort by latest edit.
  return [
    ...result.filter((section) => section.scope.kind === "project"),
    ...result.filter((section) => section.scope.kind === "playground"),
  ];
}

/** Grouped sections show in All once two or more owners have designs, unless Recent is chosen. */
export function showsSections(
  scope: GalleryScope,
  grouping: GalleryGrouping,
  sectionCount: number,
): boolean {
  return scope.kind === "all" && grouping === "project" && sectionCount >= 2;
}

/**
 * The owner and system `?new=design` preselects, or null without that param.
 * An owner this window does not know falls back to the Playground.
 */
export function newDesignPresetFromSearch(
  search: DesignGallerySearch,
  projects: readonly { readonly id: ProjectId }[],
): { readonly owner: DesignOwnerInput; readonly systemId: DesignSystemId | null } | null {
  if (search.new !== "design") return null;
  const project = projects.find((candidate) => candidate.id === search.owner);
  return {
    owner: project ? { kind: "project", projectId: project.id } : { kind: "playground" },
    systemId: search.system ?? null,
  };
}

/** The search without the one-shot New design params. */
export function withoutNewDesignSearch(search: DesignGallerySearch): DesignGallerySearch {
  const { new: _new, system: _system, owner: _owner, ...rest } = search;
  return rest;
}

export function ownerInputOf(summary: DesignSummary): DesignOwnerInput {
  const owner = summary.ref.owner;
  return owner.kind === "playground"
    ? { kind: "playground" }
    : { kind: "project", projectId: owner.projectId };
}

/** A stable key for one design across owners. */
export function summaryKey(summary: DesignSummary): string {
  const owner = summary.ref.owner;
  return owner.kind === "playground"
    ? `pg:${summary.ref.designId}`
    : `p:${owner.projectId}:${summary.ref.designId}`;
}

export function filterDesigns(
  designs: readonly DesignSummary[],
  filter: GalleryFilter,
): DesignSummary[] {
  const needle = filter.query.trim().toLowerCase();
  return designs
    .filter((summary) => {
      if (!inScope(summary, filter.scope)) return false;
      if (needle === "") return true;
      return (
        summary.title.toLowerCase().includes(needle) ||
        summary.ownerLabel.toLowerCase().includes(needle)
      );
    })
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Edited just now", "Edited 4 min ago", "Edited 3 h ago", "Edited 2 days ago", then the date. */
export function editedAgo(updatedAt: string, now: number): string {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return "Edited";
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "Edited just now";
  if (elapsed < HOUR) return `Edited ${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `Edited ${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days < 7) return days === 1 ? "Edited yesterday" : `Edited ${days} days ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `Edited ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}

export type CreationKind = "design" | "design-from-code" | "slides" | "design-system";

export const CREATION_LABELS: Record<CreationKind, string> = {
  design: "Design",
  "design-from-code": "Design from code",
  slides: "Slides",
  "design-system": "Design system",
};

export const CREATION_DESCRIPTIONS: Record<CreationKind, string> = {
  design: "A blank canvas in the Playground or a project",
  "design-from-code": "An agent designs against a project's code",
  slides: "A 16:9 deck in a design system's colors and fonts",
  "design-system": "Tokens and components read from code",
};

/** Only kinds that work end to end in this build; the slides and systems lanes flip their flags. */
export function availableCreationKinds(
  features: { readonly slides: boolean; readonly designSystems: boolean } = DESIGN_FEATURES,
): CreationKind[] {
  return [
    ...(features.slides ? (["slides"] as const) : []),
    "design",
    "design-from-code",
    ...(features.designSystems ? (["design-system"] as const) : []),
  ];
}

export function kindLabel(kind: DesignSummary["kind"]): string {
  return kind === "slides" ? "Slides" : "Design";
}
