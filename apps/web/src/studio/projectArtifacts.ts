/**
 * The project's artifacts: what its threads produced, gathered once each and
 * ordered pinned first, then most recently updated. Feeds the shelf above the
 * Threads list and the Library's Artifacts view. Pure rules only.
 *
 * An artifact is any of: a design or deck; a file threads wrote into
 * SpecWeave's shared output (`.specweave/reports/`, an increment's
 * `reports/`); a file or link registered in the project hub; a pull request a
 * thread opened or linked; a page, image or document a thread named, as this
 * device's thread artifact lists recorded it.
 */
import type {
  DesignSummary,
  EnvironmentId,
  ProjectLibrarySnapshot,
  ThreadId,
} from "@specweave-studio/contracts";

import { canonicalLinkKey } from "../artifactShelf";
import type { ProjectPullRequest } from "./projectPaneModel";
import { libraryFileExtension, libraryFileType } from "./projectPaneModel";

export type ProjectArtifactKind =
  | "design"
  | "slides"
  | "page"
  | "document"
  | "image"
  | "video"
  | "data"
  | "code"
  | "pullRequest"
  | "link";

/** Where the shelf learned of it; the richest source wins a merge. */
export type ProjectArtifactSource = "design" | "registered" | "output" | "pullRequest" | "thread";

export interface ProjectArtifactThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  /** The worktree the thread runs in; the files it names sit under it. */
  readonly root?: string | null | undefined;
}

export interface ProjectArtifact {
  /** Stable across sources: pins are stored under it. */
  readonly id: string;
  readonly kind: ProjectArtifactKind;
  readonly source: ProjectArtifactSource;
  readonly title: string;
  /** Epoch ms of the last change the app knows of; null when nothing says. */
  readonly updatedAt: number | null;
  /** Relative to `root` when it is set, else to the project; absolute outside both. Null for links. */
  readonly path: string | null;
  /** A thread's worktree for a file that has not landed in the project; null for the project. */
  readonly root: string | null;
  /** A link, a pull request, or a page published elsewhere. */
  readonly url: string | null;
  readonly byteLength: number | null;
  readonly thread: ProjectArtifactThread | null;
  /** The SpecWeave increment folder an output belongs to. */
  readonly increment: string | null;
  readonly design: DesignSummary | null;
  readonly pullRequestState: ProjectPullRequest["state"] | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestRepository: string | null;
  /** A registered file that is gone, or a link the hub must not open. */
  readonly missing: boolean;
  readonly pinned: boolean;
}

/** What one thread's artifacts list kept, as `useArtifactShelfState` snapshots it. */
export interface ProjectThreadArtifacts {
  readonly thread: ProjectArtifactThread;
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly path?: string | undefined;
    readonly url?: string | undefined;
    readonly at?: number | undefined;
  }>;
}

export interface ProjectArtifactsInput {
  readonly workspaceRoot: string;
  readonly library: ProjectLibrarySnapshot | null;
  readonly designs: ReadonlyArray<DesignSummary>;
  readonly pullRequests: ReadonlyArray<ProjectPullRequest>;
  readonly threadArtifacts: ReadonlyArray<ProjectThreadArtifacts>;
  /** Looks up a thread for a design bound to one. */
  readonly threadOf?: ((threadId: string) => ProjectArtifactThread | null) | undefined;
  readonly pinned: ReadonlySet<string>;
}

const SOURCE_RANK: Record<ProjectArtifactSource, number> = {
  design: 0,
  pullRequest: 1,
  registered: 2,
  output: 3,
  thread: 4,
};

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** Whether `path` sits under `root`; Windows paths compare without case. */
function underRoot(path: string, root: string): boolean {
  const windows = /^[A-Za-z]:\//.test(root) || root.startsWith("//");
  return windows
    ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : path.startsWith(`${root}/`);
}

/**
 * A path inside the project reads from its root, with `/` separators. A path
 * under one of `alsoRoots` (a thread's worktree, a checkout of the same
 * repository) reads from that root, so both name the same project file.
 */
export function projectRelativePath(
  path: string,
  workspaceRoot: string,
  alsoRoots: ReadonlyArray<string | null | undefined> = [],
): string {
  return relativeToRoot(path, [workspaceRoot, ...alsoRoots]).relative;
}

/**
 * `path` from the deepest of `roots` holding it, so a worktree kept inside the
 * project reads from the worktree. `root` is null when none holds it.
 */
function relativeToRoot(
  path: string,
  roots: ReadonlyArray<string | null | undefined>,
): { readonly root: string | null; readonly relative: string } {
  const normalized = path.replaceAll("\\", "/");
  let best: { root: string; trimmed: string } | null = null;
  for (const candidate of roots) {
    if (!candidate) continue;
    const trimmed = trimSlashes(candidate.replaceAll("\\", "/"));
    if (underRoot(normalized, trimmed) && (best === null || trimmed.length > best.trimmed.length)) {
      best = { root: candidate, trimmed };
    }
  }
  return best === null
    ? { root: null, relative: normalized.replace(/^\.\//, "") }
    : { root: best.root, relative: normalized.slice(best.trimmed.length + 1) };
}

function fileId(path: string): string {
  return `file:${path}`;
}

const VIDEO = new Set(["mp4", "mov", "webm", "m4v"]);
/** What a file a thread names must be to count as something it made. */
const THREAD_MADE_KINDS = new Set<ProjectArtifactKind>([
  "page",
  "document",
  "image",
  "video",
  "slides",
]);

/** What a file is, read from its name. */
export function artifactKindOfFile(path: string): ProjectArtifactKind {
  const extension = libraryFileExtension(path);
  if (extension === "html" || extension === "htm") return "page";
  if (extension === "pptx" || extension === "key") return "slides";
  if (VIDEO.has(extension)) return "video";
  const type = libraryFileType(path);
  return type === "images"
    ? "image"
    : type === "data"
      ? "data"
      : type === "code"
        ? "code"
        : type === "links"
          ? "link"
          : "document";
}

function baseName(path: string): string {
  const trimmed = trimSlashes(path);
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

type Draft = Omit<ProjectArtifact, "pinned">;

const BLANK = {
  path: null,
  url: null,
  byteLength: null,
  thread: null,
  increment: null,
  design: null,
  pullRequestState: null,
  pullRequestNumber: null,
  pullRequestRepository: null,
  missing: false,
  root: null,
} as const;

/**
 * Two sources naming one thing become one artifact: the richer source names
 * and types it, the newest date wins, and whatever either knows is kept.
 */
function merge(current: Draft, next: Draft): Draft {
  const [lead, other] =
    SOURCE_RANK[next.source] < SOURCE_RANK[current.source] ? [next, current] : [current, next];
  const newest =
    lead.updatedAt === null
      ? other.updatedAt
      : other.updatedAt === null
        ? lead.updatedAt
        : Math.max(lead.updatedAt, other.updatedAt);
  const located = lead.path !== null ? lead : other;
  return {
    ...lead,
    updatedAt: newest,
    path: located.path,
    root: located.root,
    url: lead.url ?? other.url,
    byteLength: lead.byteLength ?? other.byteLength,
    thread: lead.thread ?? other.thread,
    increment: lead.increment ?? other.increment,
    // The hub's flag is a live check of the disk; only another live listing
    // (an output the server just found) overrides it. A thread's mention is
    // not evidence the file is still there.
    missing: [lead, other].some((draft) => draft.source === "registered")
      ? [lead, other].some((draft) => draft.source === "registered" && draft.missing) &&
        ![lead, other].some((draft) => draft.source === "output")
      : lead.missing && other.missing,
  };
}

/** Every artifact once, pinned first, then newest; undated ones last. */
export function collectProjectArtifacts(input: ProjectArtifactsInput): ProjectArtifact[] {
  const byId = new Map<string, Draft>();
  const add = (draft: Draft) => {
    const existing = byId.get(draft.id);
    byId.set(draft.id, existing ? merge(existing, draft) : draft);
  };

  for (const design of input.designs) {
    add({
      ...BLANK,
      id: `design:${design.ref.designId}`,
      kind: design.kind === "slides" ? "slides" : "design",
      source: "design",
      title: design.title || "Untitled",
      updatedAt: time(design.updatedAt),
      design,
      thread: design.thread ? (input.threadOf?.(design.thread.threadId) ?? null) : null,
    });
  }

  for (const pullRequest of input.pullRequests) {
    add({
      ...BLANK,
      id: canonicalLinkKey(pullRequest.url),
      kind: "pullRequest",
      source: "pullRequest",
      title: pullRequest.title,
      updatedAt: time(pullRequest.updatedAt),
      url: pullRequest.url,
      pullRequestState: pullRequest.state,
      pullRequestNumber: pullRequest.number,
      pullRequestRepository: pullRequest.repository,
      thread: input.threadOf?.(pullRequest.threadId) ?? null,
    });
  }

  for (const artifact of input.library?.artifacts ?? []) {
    if (artifact.kind === "link") {
      add({
        ...BLANK,
        id: canonicalLinkKey(artifact.location),
        kind: "link",
        source: "registered",
        title: artifact.title,
        updatedAt: time(artifact.createdAt),
        url: artifact.location,
        missing: artifact.missing,
      });
      continue;
    }
    const path = projectRelativePath(artifact.location, input.workspaceRoot);
    add({
      ...BLANK,
      id: fileId(path),
      kind: artifactKindOfFile(path),
      source: "registered",
      title: artifact.title,
      updatedAt: time(artifact.modifiedAt ?? artifact.createdAt),
      path,
      byteLength: artifact.byteLength ?? null,
      missing: artifact.missing,
    });
  }

  for (const output of input.library?.outputs ?? []) {
    add({
      ...BLANK,
      id: fileId(output.path),
      kind: artifactKindOfFile(output.path),
      source: "output",
      title: baseName(output.path),
      updatedAt: time(output.modifiedAt),
      path: output.path,
      byteLength: output.byteLength,
      increment: output.increment,
    });
  }

  for (const { thread, entries } of input.threadArtifacts) {
    for (const entry of entries) {
      // Pull requests come from the threads' own links, with their state.
      if (entry.id.startsWith("pr:")) continue;
      if (entry.path !== undefined) {
        const exact = entry.path.replace(/(?::\d+){1,2}$/, "");
        const located = relativeToRoot(exact, [input.workspaceRoot, thread.root]);
        const path = located.relative;
        const inWorktree =
          located.root !== null &&
          located.root === thread.root &&
          trimSlashes(located.root) !== trimSlashes(input.workspaceRoot);
        // A file only the thread's worktree has opens from there, and stays its
        // own artifact, since another thread may write the same path. It joins
        // the project's file once the project lists it.
        const id =
          inWorktree && !byId.has(fileId(path)) ? `file:${thread.threadId}:${path}` : fileId(path);
        const kind = entry.kind === "native" ? "page" : artifactKindOfFile(path);
        // A source file a thread read or edited is work in progress, not something it made.
        if (!THREAD_MADE_KINDS.has(kind)) continue;
        add({
          ...BLANK,
          id,
          kind,
          source: "thread",
          title: entry.name || baseName(path),
          updatedAt: entry.at ?? null,
          path,
          root: inWorktree ? thread.root! : null,
          url: entry.url ?? null,
          thread,
        });
      } else if (entry.url !== undefined && entry.kind === "native") {
        // Only a page a thread published; a link it merely mentioned is not its work.
        add({
          ...BLANK,
          id: canonicalLinkKey(entry.url),
          kind: "page",
          source: "thread",
          title: entry.name,
          updatedAt: entry.at ?? null,
          url: entry.url,
          thread,
        });
      }
    }
  }

  return [...byId.values()]
    .map((draft) => ({ ...draft, pinned: input.pinned.has(draft.id) }))
    .toSorted(compareArtifacts);
}

export function compareArtifacts(left: ProjectArtifact, right: ProjectArtifact): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftAt = left.updatedAt ?? -Infinity;
  const rightAt = right.updatedAt ?? -Infinity;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return left.title.localeCompare(right.title);
}

/* Type filter ------------------------------------------------------------- */

export const ARTIFACT_TYPE_FILTERS = [
  "all",
  "documents",
  "pages",
  "images",
  "designs",
  "pullRequests",
  "links",
  "files",
] as const;
export type ArtifactTypeFilter = (typeof ARTIFACT_TYPE_FILTERS)[number];
export const ARTIFACT_TYPE_FILTER_LABELS: Record<ArtifactTypeFilter, string> = {
  all: "All types",
  documents: "Documents",
  pages: "Pages",
  images: "Images and video",
  designs: "Designs and decks",
  pullRequests: "Pull requests",
  links: "Links",
  files: "Data and code",
};

const FILTER_OF: Record<ProjectArtifactKind, Exclude<ArtifactTypeFilter, "all">> = {
  design: "designs",
  slides: "designs",
  page: "pages",
  document: "documents",
  image: "images",
  video: "images",
  data: "files",
  code: "files",
  pullRequest: "pullRequests",
  link: "links",
};

export function artifactMatchesType(filter: ArtifactTypeFilter, artifact: ProjectArtifact) {
  return filter === "all" || FILTER_OF[artifact.kind] === filter;
}

/** The filters that would show something, so the menu never offers an empty one. */
export function artifactTypesPresent(
  artifacts: ReadonlyArray<ProjectArtifact>,
): ReadonlySet<ArtifactTypeFilter> {
  return new Set<ArtifactTypeFilter>(["all", ...artifacts.map((item) => FILTER_OF[item.kind])]);
}

export function searchArtifacts(
  artifacts: ReadonlyArray<ProjectArtifact>,
  query: string,
): ReadonlyArray<ProjectArtifact> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return artifacts;
  return artifacts.filter((artifact) => {
    const text = [
      artifact.title,
      artifact.path ?? "",
      artifact.url ?? "",
      artifact.thread?.title ?? "",
      artifact.increment ?? "",
      ARTIFACT_KIND_LABELS[artifact.kind],
    ]
      .join("\n")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export const ARTIFACT_KIND_LABELS: Record<ProjectArtifactKind, string> = {
  design: "Design",
  slides: "Deck",
  page: "Page",
  document: "Document",
  image: "Image",
  video: "Video",
  data: "Data",
  code: "Code",
  pullRequest: "Pull request",
  link: "Link",
};

export const PULL_REQUEST_STATE_WORDS: Record<ProjectPullRequest["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** "Merged PR", "Document": what an artifact is, short enough for a card or a column. */
export function artifactKindLabel(artifact: ProjectArtifact): string {
  if (artifact.kind !== "pullRequest" || artifact.pullRequestState === null) {
    return ARTIFACT_KIND_LABELS[artifact.kind];
  }
  return `${PULL_REQUEST_STATE_WORDS[artifact.pullRequestState]} PR`;
}

/** The number of cards the shelf shows before View all. */
export const ARTIFACT_SHELF_LIMIT = 12;

/** "now", "5m", "3h", "2d", "4w", "Oct 3": a card's age, as the Threads list words it. */
export function artifactAge(at: number | null, now: number): string {
  if (at === null) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The Library's two views: the project's artifacts and its SpecWeave folders. */
export const LIBRARY_SECTIONS = ["artifacts", "files"] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];
