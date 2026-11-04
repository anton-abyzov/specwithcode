/**
 * What the remote-control sheet lists for one machine: its projects, one row per name,
 * and its recent threads, one row per title. Pure, so the grouping, hiding and search
 * rules are tested without rendering.
 */

/** One checkout of a project on the machine, as the settings scope helpers list it. */
export interface RemoteSheetCheckout<P, S> {
  readonly key: string;
  readonly name: string;
  readonly path: string | null;
  readonly projectId: string;
  readonly archived: boolean;
  readonly project: P;
  readonly search: S;
}

export interface RemoteSheetThread {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO time of the last activity; the newest repeat of a title is the one kept. */
  readonly activityAt: string | null;
}

export interface RemoteSheetFolder<P, S> {
  readonly key: string;
  readonly path: string | null;
  /** The row's secondary line: the path with the home folder as ~, or what made a temporary one. */
  readonly shortPath: string | null;
  readonly archived: boolean;
  readonly threadCount: number;
  readonly activityAt: string | null;
  readonly project: P;
  readonly search: S;
}

export interface RemoteSheetProject<P, S> {
  readonly key: string;
  readonly name: string;
  readonly folders: ReadonlyArray<RemoteSheetFolder<P, S>>;
  readonly threadCount: number;
  readonly activityAt: string | null;
  /** Every folder is archived. */
  readonly archived: boolean;
}

export interface RemoteSheetThreadRow {
  readonly id: string;
  readonly title: string;
  readonly projectName: string | null;
  readonly activityAt: string | null;
  /** How many threads share this title, the newest of which is `id`. */
  readonly repeats: number;
}

export interface RemoteSheetModel<P, S> {
  readonly projects: ReadonlyArray<RemoteSheetProject<P, S>>;
  /** Handoff copies and scratch folders, shown only on request. */
  readonly temporary: ReadonlyArray<RemoteSheetProject<P, S>>;
  readonly threads: ReadonlyArray<RemoteSheetThreadRow>;
  /** Rows before the search filter, to decide whether a search field is worth showing. */
  readonly totalRows: number;
}

const UNTITLED = "Untitled thread";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * A folder the app made for its own work, not one the person added: a copy a machine
 * handoff checked out (`.specwithcode/<m>/userdata/machine-handoffs/...`) or a scratch
 * directory (`.specwithcode/<m>/scratch/...`).
 */
export function isTemporaryWorkspace(path: string | null | undefined): boolean {
  if (!path) return false;
  const normalized = normalizePath(path);
  return (
    /\/\.specwithcode\/[^/]+\/userdata\/machine-handoffs(\/|$)/.test(normalized) ||
    /\/\.specwithcode\/[^/]+\/scratch(\/|$)/.test(normalized)
  );
}

/** `/Users/anton/x` and `/home/anton/x` read as `~/x`; Windows home folders too. */
export function shortenHomePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const unix = path.match(/^\/(?:Users|home)\/(?!(?:Shared|Guest)(?:\/|$))[^/]+(?=\/|$)/);
  if (unix) return `~${path.slice(unix[0].length)}`;
  const windows = path.match(/^[A-Za-z]:\\Users\\(?!(?:Public|Default)(?:\\|$))[^\\]+(?=\\|$)/);
  if (windows) return `~${path.slice(windows[0].length)}`;
  return path;
}

/**
 * The secondary line of a temporary folder. Its path is long and generated, so the row
 * says what made it: "Handoff copy · 7f3c2a91" or "Scratch · 2026-11-03-probe".
 */
export function describeTemporaryWorkspace(path: string): string {
  const normalized = normalizePath(path);
  const handoff = normalized.match(
    /\/userdata\/machine-handoffs\/(?:[^/]+\/)*?([0-9a-f]{8})[0-9a-f-]*(?:\/|$)/i,
  );
  if (handoff) return `Handoff copy · ${handoff[1]}`;
  if (normalized.includes("/userdata/machine-handoffs")) return "Handoff copy";
  const scratch = normalized.match(/\/scratch\/([^/]+)/);
  return scratch ? `Scratch · ${scratch[1]}` : "Scratch";
}

function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function byActivityThenName<T extends { activityAt: string | null; name: string }>(a: T, b: T) {
  const at = a.activityAt ? Date.parse(a.activityAt) : -Infinity;
  const bt = b.activityAt ? Date.parse(b.activityAt) : -Infinity;
  if (at !== bt) return bt - at;
  return a.name.localeCompare(b.name);
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function groupByName<P, S>(
  checkouts: ReadonlyArray<RemoteSheetCheckout<P, S>>,
  threadsByProject: ReadonlyMap<string, { count: number; activityAt: string | null }>,
  keyPrefix: string,
): RemoteSheetProject<P, S>[] {
  const groups = new Map<string, { name: string; folders: RemoteSheetFolder<P, S>[] }>();
  for (const checkout of checkouts) {
    const key = nameKey(checkout.name);
    const group = groups.get(key) ?? { name: checkout.name, folders: [] };
    const threads = threadsByProject.get(checkout.projectId);
    group.folders.push({
      key: checkout.key,
      path: checkout.path,
      shortPath:
        checkout.path && isTemporaryWorkspace(checkout.path)
          ? describeTemporaryWorkspace(checkout.path)
          : shortenHomePath(checkout.path),
      archived: checkout.archived,
      threadCount: threads?.count ?? 0,
      activityAt: threads?.activityAt ?? null,
      project: checkout.project,
      search: checkout.search,
    });
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, { name, folders }]) => {
      const sorted = folders.toSorted((a, b) =>
        byActivityThenName(
          { activityAt: a.activityAt, name: a.path ?? "" },
          { activityAt: b.activityAt, name: b.path ?? "" },
        ),
      );
      return {
        key: `${keyPrefix}${key}`,
        name,
        folders: sorted,
        threadCount: folders.reduce((sum, folder) => sum + folder.threadCount, 0),
        activityAt: folders.reduce<string | null>(
          (at, folder) => newer(at, folder.activityAt),
          null,
        ),
        archived: folders.every((folder) => folder.archived),
      };
    })
    .toSorted((a, b) =>
      a.archived !== b.archived ? (a.archived ? 1 : -1) : byActivityThenName(a, b),
    );
}

function matches(query: string, ...values: ReadonlyArray<string | null | undefined>) {
  return values.some((value) => value?.toLocaleLowerCase().includes(query));
}

export function buildRemoteSheetModel<P, S>(input: {
  checkouts: ReadonlyArray<RemoteSheetCheckout<P, S>>;
  threads: ReadonlyArray<RemoteSheetThread>;
  query?: string;
}): RemoteSheetModel<P, S> {
  const threadsByProject = new Map<string, { count: number; activityAt: string | null }>();
  for (const thread of input.threads) {
    const entry = threadsByProject.get(thread.projectId) ?? { count: 0, activityAt: null };
    threadsByProject.set(thread.projectId, {
      count: entry.count + 1,
      activityAt: newer(entry.activityAt, thread.activityAt),
    });
  }
  const permanent = input.checkouts.filter((checkout) => !isTemporaryWorkspace(checkout.path));
  const temporary = input.checkouts.filter((checkout) => isTemporaryWorkspace(checkout.path));
  const projects = groupByName(permanent, threadsByProject, "");
  const temporaryProjects = groupByName(temporary, threadsByProject, "temporary:");

  const projectNames = new Map<string, string>();
  // Temporary first, so a project id in both reads by its ordinary name.
  for (const checkout of [...temporary, ...permanent])
    projectNames.set(checkout.projectId, checkout.name);

  // Search runs before the merge by title, so a thread is found by its own project even
  // when a newer thread elsewhere shares its title.
  const dedupe = (list: ReadonlyArray<RemoteSheetThread>): RemoteSheetThreadRow[] => {
    const byTitle = new Map<string, { thread: RemoteSheetThread; repeats: number }>();
    for (const thread of list) {
      const title = thread.title.trim() || UNTITLED;
      const key = nameKey(title);
      const seen = byTitle.get(key);
      if (!seen) {
        byTitle.set(key, { thread: { ...thread, title }, repeats: 1 });
        continue;
      }
      const keepNew = newer(seen.thread.activityAt, thread.activityAt) !== seen.thread.activityAt;
      byTitle.set(key, {
        thread: keepNew ? { ...thread, title } : seen.thread,
        repeats: seen.repeats + 1,
      });
    }
    return [...byTitle.values()]
      .map(({ thread, repeats }) => ({
        id: thread.id,
        title: thread.title,
        projectName: projectNames.get(thread.projectId) ?? null,
        activityAt: thread.activityAt,
        repeats,
      }))
      .toSorted((a, b) => byActivityThenName({ ...a, name: a.title }, { ...b, name: b.title }));
  };
  const threads = dedupe(input.threads);

  const totalRows = projects.length + threads.length;
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  if (!query) return { projects, temporary: temporaryProjects, threads, totalRows };
  const projectMatches = (project: RemoteSheetProject<P, S>) =>
    matches(query, project.name, ...project.folders.map((folder) => folder.path));
  return {
    projects: projects.filter(projectMatches),
    temporary: temporaryProjects.filter(projectMatches),
    threads: dedupe(
      input.threads.filter((thread) =>
        matches(query, thread.title.trim() || UNTITLED, projectNames.get(thread.projectId)),
      ),
    ),
    totalRows,
  };
}
