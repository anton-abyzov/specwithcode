/**
 * The project's right pane, laid out as the Claude desktop app's project
 * panel: Threads, Library, PRs and Scheduled tabs. Pure rules only; the
 * components live in components/studio/shell.
 */
import type { PullRequestState } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

export const PROJECT_PANE_TABS = ["threads", "library", "prs", "scheduled"] as const;
export type ProjectPaneTab = (typeof PROJECT_PANE_TABS)[number];
export const PROJECT_PANE_TAB_LABELS: Record<ProjectPaneTab, string> = {
  threads: "Threads",
  library: "Library",
  prs: "PRs",
  scheduled: "Scheduled",
};

/* Library ------------------------------------------------------------------ */

export const LIBRARY_TYPE_FILTERS = [
  "all",
  "documents",
  "images",
  "code",
  "data",
  "links",
] as const;
export type LibraryTypeFilter = (typeof LIBRARY_TYPE_FILTERS)[number];
export const LIBRARY_TYPE_FILTER_LABELS: Record<LibraryTypeFilter, string> = {
  all: "All types",
  documents: "Documents",
  images: "Images",
  code: "Code",
  data: "Data",
  links: "Links",
};
export type LibraryFileType = Exclude<LibraryTypeFilter, "all">;

const EXTENSION_TYPES: Record<string, LibraryFileType> = {};
for (const [type, extensions] of [
  ["documents", "md mdx markdown txt pdf doc docx rtf odt html htm pptx ppt key"],
  ["images", "png jpg jpeg gif webp svg avif bmp ico heic"],
  ["data", "json jsonl ndjson csv tsv yaml yml toml xml xlsx xls sqlite db parquet"],
  [
    "code",
    "ts tsx js jsx mjs cjs py rb go rs java kt swift c h cc cpp cs php sh bash zsh sql css scss vue svelte",
  ],
] as const) {
  for (const extension of extensions.split(" ")) EXTENSION_TYPES[extension] = type;
}

export function libraryFileExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The Type filter's bucket for a file; anything unrecognised is a document. */
export function libraryFileType(name: string): LibraryFileType {
  return EXTENSION_TYPES[libraryFileExtension(name)] ?? "documents";
}

const KIND_NAMES: Record<string, string> = {
  md: "Markdown",
  mdx: "MDX",
  txt: "Plain text",
  pdf: "PDF",
  json: "JSON",
  jsonl: "JSON Lines",
  csv: "CSV",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  svg: "SVG image",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  py: "Python",
  sh: "Shell script",
};

/** The Kind column, as a file manager names it. */
export function libraryKindLabel(entry: { kind: "file" | "directory" | "link"; name: string }) {
  if (entry.kind === "directory") return "Folder";
  if (entry.kind === "link") return "Link";
  const extension = libraryFileExtension(entry.name);
  return KIND_NAMES[extension] ?? (extension ? `${extension.toUpperCase()} file` : "File");
}

export function libraryMatchesType(
  filter: LibraryTypeFilter,
  entry: { kind: "file" | "directory" | "link"; name: string },
): boolean {
  if (filter === "all" || entry.kind === "directory") return true;
  if (entry.kind === "link") return filter === "links";
  return libraryFileType(entry.name) === filter;
}

/** "12 KB", "1.4 MB": the Size column. */
export function formatLibrarySize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Today shows the time; anything older shows the date, as Finder does. */
export function formatLibraryDate(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `Today at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      });
}

export function libraryBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/* Pull requests ------------------------------------------------------------ */

export type ProjectPullRequestState = PullRequestState | "draft";

export interface ProjectPullRequest {
  readonly key: string;
  readonly number: number;
  readonly repository: string;
  readonly url: string;
  readonly title: string;
  readonly state: ProjectPullRequestState;
  readonly updatedAt: string;
  readonly threadId: EnvironmentThreadShell["id"];
  readonly threadTitle: string;
}

export const PROJECT_PULL_REQUEST_GROUPS = ["Open", "Merged", "Closed"] as const;
export type ProjectPullRequestGroup = (typeof PROJECT_PULL_REQUEST_GROUPS)[number];

export function pullRequestGroup(state: ProjectPullRequestState): ProjectPullRequestGroup {
  return state === "merged" ? "Merged" : state === "closed" ? "Closed" : "Open";
}

/**
 * Every pull request the project's threads opened or linked, once each. A
 * pull request two threads link is listed under the thread that linked it
 * last; the newest activity sorts first.
 */
export function collectProjectPullRequests(
  threads: readonly EnvironmentThreadShell[],
): ProjectPullRequest[] {
  const byKey = new Map<string, ProjectPullRequest & { linkedAt: string }>();
  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    for (const link of thread.pullRequests ?? []) {
      if (link.source === "stack-dismissed") continue;
      const key = `${link.host}/${link.repository}#${link.number}`;
      const snapshot = link.snapshot;
      const state: ProjectPullRequestState =
        snapshot?.state === "open" && snapshot.isDraft ? "draft" : (snapshot?.state ?? "open");
      const candidate = {
        key,
        number: link.number,
        repository: link.repository,
        url: link.url,
        title: snapshot?.title ?? `${link.repository} #${link.number}`,
        state,
        updatedAt: snapshot?.updatedAt ?? link.linkedAt,
        threadId: thread.id,
        threadTitle: thread.title || "Untitled thread",
        linkedAt: link.linkedAt,
      };
      const existing = byKey.get(key);
      if (!existing || existing.linkedAt < candidate.linkedAt) byKey.set(key, candidate);
    }
  }
  return [...byKey.values()]
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ linkedAt: _linkedAt, ...pullRequest }) => pullRequest);
}

export function openPullRequestCount(pullRequests: readonly ProjectPullRequest[]): number {
  return pullRequests.filter((pr) => pullRequestGroup(pr.state) === "Open").length;
}
