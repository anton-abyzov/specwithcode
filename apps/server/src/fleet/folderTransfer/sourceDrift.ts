// @effect-diagnostics nodeBuiltinImport:off - the drift check only stats and reads the source folder; it never writes inside it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readJson, writeJson } from "./durable.ts";
import { runGit } from "./git.ts";
import {
  forEachLimited,
  hashFile,
  readManifestFile,
  scanFolder,
  selectEntries,
  type ManifestEntry,
  type RepositoryInfo,
} from "./manifest.ts";
import type { CapturedStat } from "./sourceSnapshot.ts";
import { sha256Hex } from "./wire.ts";

export type DriftKind = "changed" | "added" | "removed" | "unreadable" | "repository";

export interface DriftRepository {
  readonly headFrom?: string;
  readonly headTo?: string;
  readonly branchesChanged: ReadonlyArray<string>;
  readonly stashFrom: number;
  readonly stashTo: number;
  readonly indexChanged: boolean;
  /** A tag, note, remote-tracking or other ref differs; branches and stashes are listed apart. */
  readonly refsChanged?: boolean;
  /** The repository's config, exclude rules or hooks differ from what the copy carried. */
  readonly settingsChanged?: boolean;
}

export interface DriftRow {
  readonly path: string;
  readonly kind: DriftKind;
  readonly size?: number;
  readonly repository?: DriftRepository;
  /**
   * A changed file still being written on the copy's last read: the destination may
   * hold a mix of two versions, not an older complete one.
   */
  readonly unsettled?: true;
}

/** What differs between the copied tree and the live source folder. */
export interface SourceDrift {
  readonly checkedAt: number;
  readonly total: number;
  /** Over the sorted paths and kinds only: edits on the same path keep it. */
  readonly digest: string;
  readonly rows: ReadonlyArray<DriftRow>;
  readonly truncated: boolean;
}

/** Each captured file's identity, kept beside the manifest for the stat shortcut. */
export interface DriftBasis {
  readonly capturedAt: number;
  readonly stats: Readonly<Record<string, CapturedStat>>;
  readonly changing: ReadonlyArray<string>;
  /** Each copied repository's staged entries, as Git lists them from the frozen snapshot. */
  readonly indexes?: Readonly<Record<string, string | null>>;
  /** Each copied repository's refs, as Git lists them from the frozen snapshot. */
  readonly refs?: Readonly<Record<string, string | null>>;
  /** How many entries each folder skipped for an uncopyable name; the header keeps one line per folder. */
  readonly uncopyable?: Readonly<Record<string, number>>;
}

/** An approved secret's bytes as the destination pulled them, read back by `servedSecrets`. */
export interface ServedSecret {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface StoredReport {
  readonly version: 1;
  readonly digest: string;
  readonly checkedAt: number;
  readonly total: number;
  readonly rows: ReadonlyArray<DriftRow>;
}

export const MAX_DRIFT_ROWS = 500;
const DIGEST = /^[a-f0-9]{64}$/;
const STAT_CONCURRENCY = 16;

const UNREADABLE = /^Could not read (.+)$/;
const UNCOPYABLE = /^Skipped an entry whose name cannot be copied safely below (.+)$/;
/** What the copy carries of a main repository's own Git folder besides refs, objects and logs. */
const SETTINGS = (path: string) =>
  path === "config" || path === "info/exclude" || path.startsWith("hooks/");

export const driftBasisFile = (directory: string) => NodePath.join(directory, "drift-basis.json");
export const servedSecretsFile = (directory: string) =>
  NodePath.join(directory, "secrets-served.ndjson");
const reportFile = (directory: string, digest: string) =>
  NodePath.join(directory, `drift-${digest}.json`);

const gitPrefix = (repository: string) => (repository === "." ? ".git" : `${repository}/.git`);
/** Refs where the copy carried them: a main repository's loose refs and packed-refs. */
const REFS = (path: string) => path === "packed-refs" || path.startsWith("refs/");

/**
 * Rows are keyed by what they describe, so a repository row and a file row at the
 * same path both stay listed, and accepting one never covers the other.
 */
export const driftRowKey = (row: { readonly path: string; readonly kind: DriftKind }) =>
  `${row.kind === "repository" ? "repository" : "path"}:${row.path}`;
const fileKey = (path: string) => `path:${path}`;

/** Folders and how many entries each skipped for an uncopyable name. */
export function uncopyableCounts(warnings: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const warning of warnings) {
    const path = UNCOPYABLE.exec(warning)?.[1];
    if (path) counts[path] = (counts[path] ?? 0) + 1;
  }
  return counts;
}

/** Key order cannot make two equal repository readings differ. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The copy turns an external worktree into its own repository; compare it the same way. */
function comparable(repo: RepositoryInfo): string {
  const { status: _status, worktrees: _worktrees, ...rest } = repo;
  const external =
    (repo.kind === "linked" && repo.mainRepository === null) || repo.kind === "gitfile";
  return canonical(external ? { ...rest, kind: "main", mainRepository: null } : rest);
}

const repositoryFolder = (root: string, repository: string) =>
  NodePath.join(root, repository === "." ? "" : repository);

/**
 * The staged entries Git lists, not the index file's bytes: the copy may rewrite a
 * split index whole, and a refresh rewrites stat data without staging anything.
 */
const indexDigest = (cwd: string) =>
  runGit(cwd, ["ls-files", "--stage", "-z"]).then(
    (result) => sha256Hex(Buffer.from(result.stdout)),
    () => null,
  );

/** Every ref Git lists, not the files holding them: packing refs changes none of them. */
const refsDigest = (cwd: string) =>
  runGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]).then(
    (result) => sha256Hex(Buffer.from(result.stdout)),
    () => null,
  );

async function digestsOf(
  snapshotRoot: string,
  repositories: ReadonlyArray<RepositoryInfo>,
  read: (cwd: string) => Promise<string | null>,
): Promise<Record<string, string | null>> {
  const digests: Record<string, string | null> = {};
  for (const repo of repositories)
    digests[repo.path] = await read(repositoryFolder(snapshotRoot, repo.path));
  return digests;
}

/** Read from the operation's frozen snapshot while the build still holds it. */
export const indexDigests = (snapshotRoot: string, repositories: ReadonlyArray<RepositoryInfo>) =>
  digestsOf(snapshotRoot, repositories, indexDigest);

/** Read from the operation's frozen snapshot while the build still holds it. */
export const refDigests = (snapshotRoot: string, repositories: ReadonlyArray<RepositoryInfo>) =>
  digestsOf(snapshotRoot, repositories, refsDigest);

/** Older records keep no digest: where Git keeps the index now, and where the copy carried it. */
async function indexPaths(folder: string, repo: RepositoryInfo) {
  const cwd = repositoryFolder(folder, repo.path);
  const live = NodePath.resolve(
    (
      await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
    ).stdout.trim(),
  );
  const copied =
    repo.kind === "linked" && repo.mainRepository !== null
      ? `${gitPrefix(repo.mainRepository)}/worktrees/${NodePath.basename(NodePath.dirname(live))}/index`
      : `${gitPrefix(repo.path)}/index`;
  return { live, copied };
}

const liveHash = (absolute: string) =>
  hashFile(absolute, false).then(
    (hashed) => hashed.sha256,
    (cause: NodeJS.ErrnoException) => {
      if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
      throw cause;
    },
  );

/** A small Git metadata file's bytes, read like the index and refs: never through a link. */
async function smallFileHash(absolute: string): Promise<string | null> {
  const stat = await NodeFSP.lstat(absolute).catch((cause: NodeJS.ErrnoException) => {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
    throw cause;
  });
  return stat?.isFile() ? sha256Hex(await NodeFSP.readFile(absolute)) : null;
}

/**
 * Whether a main repository's Git files the predicate picks differ from the copied
 * ones. Only a main repository's Git folder travels whole; the copy writes an
 * external worktree's settings and refs itself.
 */
async function gitFilesDiffer(
  folder: string,
  repo: RepositoryInfo,
  copiedEntries: ReadonlyMap<string, ManifestEntry>,
  pick: (path: string) => boolean,
  files: ReadonlyArray<string>,
  directories: ReadonlyArray<string>,
): Promise<boolean> {
  if (repo.kind !== "main") return false;
  const prefix = `${gitPrefix(repo.path)}/`;
  const copied = new Map<string, string | undefined>();
  for (const [path, entry] of copiedEntries)
    if (path.startsWith(prefix) && entry.type === "file" && pick(path.slice(prefix.length)))
      copied.set(path.slice(prefix.length), entry.sha256);
  const gitDir = NodePath.join(folder, gitPrefix(repo.path));
  const live = [...files];
  for (const directory of directories) {
    const listed = await NodeFSP.readdir(NodePath.join(gitDir, directory), {
      recursive: true,
      withFileTypes: true,
    }).catch((cause: NodeJS.ErrnoException) => {
      if (cause?.code === "ENOENT") return [];
      throw cause;
    });
    for (const entry of listed)
      if (entry.isFile() && !entry.name.endsWith(".lock"))
        live.push(
          NodePath.relative(gitDir, NodePath.join(entry.parentPath, entry.name))
            .split(NodePath.sep)
            .join("/"),
        );
  }
  for (const path of new Set([...copied.keys(), ...live]))
    if ((await smallFileHash(NodePath.join(gitDir, path))) !== (copied.get(path) ?? null))
      return true;
  return false;
}

/** Config, exclude rules and hooks. */
const settingsDiffer = (
  folder: string,
  repo: RepositoryInfo,
  copiedEntries: ReadonlyMap<string, ManifestEntry>,
) => gitFilesDiffer(folder, repo, copiedEntries, SETTINGS, ["config", "info/exclude"], ["hooks"]);

/** Older records keep no ref digest: the copied loose refs and packed-refs files instead. */
const refFilesDiffer = (
  folder: string,
  repo: RepositoryInfo,
  copiedEntries: ReadonlyMap<string, ManifestEntry>,
) => gitFilesDiffer(folder, repo, copiedEntries, REFS, ["packed-refs"], ["refs"]);

async function repositoryRows(
  folder: string,
  copiedRepositories: ReadonlyArray<RepositoryInfo>,
  liveRepositories: ReadonlyArray<RepositoryInfo>,
  copiedEntries: ReadonlyMap<string, ManifestEntry>,
  basis: DriftBasis | null,
): Promise<Array<DriftRow>> {
  const before = new Map(copiedRepositories.map((repo) => [repo.path, repo]));
  const after = new Map(liveRepositories.map((repo) => [repo.path, repo]));
  const rows: Array<DriftRow> = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const from = before.get(path);
    const to = after.get(path);
    let indexChanged = false;
    let refsChanged = false;
    let settingsChanged = false;
    if (from && to && comparable(from) === comparable(to)) {
      const live = repositoryFolder(folder, path);
      const indexes = basis?.indexes;
      try {
        if (indexes && Object.hasOwn(indexes, path)) {
          const copied = indexes[path];
          indexChanged = copied === null || (await indexDigest(live)) !== copied;
        } else {
          const place = await indexPaths(folder, to);
          indexChanged =
            (await liveHash(place.live)) !== (copiedEntries.get(place.copied)?.sha256 ?? null);
        }
      } catch {
        indexChanged = true;
      }
      const refs = basis?.refs;
      if (refs && Object.hasOwn(refs, path))
        refsChanged = refs[path] === null || (await refsDigest(live)) !== refs[path];
      else if (!basis)
        refsChanged = await refFilesDiffer(folder, to, copiedEntries).catch(() => true);
      settingsChanged = await settingsDiffer(folder, to, copiedEntries).catch(() => true);
      if (!indexChanged && !refsChanged && !settingsChanged) continue;
    }
    const branches = new Set([
      ...Object.keys(from?.branches ?? {}),
      ...Object.keys(to?.branches ?? {}),
    ]);
    rows.push({
      path,
      kind: "repository",
      repository: {
        ...(from?.head ? { headFrom: from.head } : {}),
        ...(to?.head ? { headTo: to.head } : {}),
        branchesChanged: [...branches]
          .filter((name) => from?.branches[name] !== to?.branches[name])
          .sort()
          .slice(0, 50),
        stashFrom: from?.stashCount ?? 0,
        stashTo: to?.stashCount ?? 0,
        indexChanged,
        ...(refsChanged ? { refsChanged } : {}),
        ...(settingsChanged ? { settingsChanged } : {}),
      },
    });
  }
  return rows;
}

/** The last bytes the destination pulled of each approved secret; a later pull replaces them. */
async function readServedSecrets(file: string): Promise<Array<ServedSecret>> {
  const text = await NodeFSP.readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause?.code === "ENOENT") return "";
    throw cause;
  });
  const served = new Map<string, ServedSecret>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<ServedSecret>;
      if (
        typeof value.path === "string" &&
        typeof value.sha256 === "string" &&
        typeof value.size === "number"
      )
        served.set(value.path, { path: value.path, sha256: value.sha256, size: value.size });
    } catch {
      // A torn last line from a crash; the earlier lines stand.
    }
  }
  return [...served.values()];
}

/** Records one approved secret as served; content never, only its hash and size. */
export async function recordServedSecret(file: string, secret: ServedSecret): Promise<void> {
  await NodeFSP.appendFile(file, `${JSON.stringify(secret)}\n`, { mode: 0o600 });
}

/**
 * Lists every selected path and repository that differs from the copied manifest,
 * and every approved secret that differs from what the destination pulled.
 * A file keeps its copied bytes without being read when its size, inode, device
 * and nanosecond change time all match its capture. The kernel sets the change
 * time, but from a coarse clock on some filesystems, so the capture records no
 * stat for a file stamped within a tick of its read (see settledStat), and such a
 * file is always read here.
 */
export async function computeDrift(input: {
  readonly folder: string;
  readonly directory: string;
  readonly manifestFile: string;
  readonly basisFile: string;
  readonly servedSecretsFile?: string;
  readonly now: () => number;
}): Promise<SourceDrift> {
  const copied = await readManifestFile(input.manifestFile);
  const basis = await readJson<DriftBasis>(input.basisFile);
  const changing = new Set(basis?.changing ?? []);
  const selection = new Set(copied.header.selection);
  const current = await scanFolder(input.folder, {
    expandRebuildable: selection.has("rebuildable"),
  });
  const prefixes = [...copied.header.repositories, ...current.repositories].map((repo) =>
    gitPrefix(repo.path),
  );
  const isGit = (path: string) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const copiedEntries = new Map(copied.entries.map((entry) => [entry.path, entry]));
  const before = copied.entries.filter((entry) => !entry.portableGit && !isGit(entry.path));
  const after = new Map(
    selectEntries(current.entries, selection)
      .filter((entry) => !isGit(entry.path))
      .map((entry) => [entry.path, entry]),
  );
  const rows = new Map<string, DriftRow>();
  const unreadable = current.warnings.flatMap((warning) => {
    const path = UNREADABLE.exec(warning)?.[1];
    return path &&
      !isGit(path) &&
      before.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))
      ? [path]
      : [];
  });
  for (const path of unreadable) rows.set(fileKey(path), { path, kind: "unreadable" });
  // A new entry the scan skipped for its name would otherwise stay here unlisted. The
  // header keeps one warning per folder, so the basis counts them; older records only
  // know whether a folder had any.
  const copiedWarnings = new Set(copied.header.warnings);
  const copiedUncopyable = basis?.uncopyable;
  for (const [path, count] of Object.entries(uncopyableCounts(current.warnings))) {
    const known = copiedUncopyable
      ? (copiedUncopyable[path] ?? 0)
      : copiedWarnings.has(`Skipped an entry whose name cannot be copied safely below ${path}`)
        ? count
        : 0;
    if (
      count > known &&
      !isGit(path) &&
      !rows.has(fileKey(path)) &&
      (path === "." ||
        before.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`)))
    )
      rows.set(fileKey(path), { path, kind: "unreadable" });
  }
  // Older records refused on any warning, and still do: nothing the scan skipped is listed otherwise.
  if (!basis)
    for (const warning of current.warnings) {
      const path = UNREADABLE.exec(warning)?.[1] ?? UNCOPYABLE.exec(warning)?.[1] ?? ".";
      if (!rows.has(fileKey(path))) rows.set(fileKey(path), { path, kind: "unreadable" });
    }
  const hidden = (path: string) =>
    unreadable.some((folder) => path === folder || path.startsWith(`${folder}/`));
  const files: Array<{ readonly from: ManifestEntry; readonly to: ManifestEntry }> = [];
  for (const from of before) {
    const to = after.get(from.path);
    after.delete(from.path);
    // Its unreadable row already covers it, a mode change included.
    if (hidden(from.path)) continue;
    if (!to) {
      rows.set(fileKey(from.path), {
        path: from.path,
        kind: "removed",
        ...(from.type === "file" ? { size: from.size } : {}),
      });
    } else if (
      from.unstable ||
      to.type !== from.type ||
      to.mode !== from.mode ||
      to.target !== from.target ||
      (from.type === "file" && to.size !== from.size)
    )
      rows.set(fileKey(from.path), {
        path: from.path,
        kind: "changed",
        ...(to.type === "file" ? { size: to.size } : {}),
        ...(from.type === "file" && changing.has(from.path) ? { unsettled: true as const } : {}),
      });
    else if (from.type === "file") files.push({ from, to });
  }
  for (const to of after.values())
    rows.set(fileKey(to.path), {
      path: to.path,
      kind: "added",
      ...(to.type === "file" ? { size: to.size } : {}),
    });
  await forEachLimited(files, STAT_CONCURRENCY, async ({ from, to }) => {
    const absolute = NodePath.join(input.folder, from.path);
    const known = changing.has(from.path) ? undefined : basis?.stats[from.path];
    if (known) {
      const stat = await NodeFSP.lstat(absolute, { bigint: true }).catch(() => null);
      if (
        stat?.isFile() &&
        String(stat.size) === known.size &&
        String(stat.ctimeNs) === known.ctimeNs &&
        String(stat.ino) === known.ino &&
        String(stat.dev) === known.dev
      )
        return;
    }
    let sha256: string | null;
    try {
      sha256 = await liveHash(absolute);
    } catch {
      rows.set(fileKey(from.path), { path: from.path, kind: "unreadable" });
      return;
    }
    if (sha256 === null)
      rows.set(fileKey(from.path), { path: from.path, kind: "removed", size: from.size });
    else if (sha256 !== from.sha256)
      rows.set(fileKey(from.path), {
        path: from.path,
        kind: "changed",
        size: to.size,
        // The copied bytes come from a read that moved: they may be no version at all.
        ...(changing.has(from.path) ? { unsettled: true as const } : {}),
      });
  });
  // Approved secrets travel by a live read at pull time, outside the manifest.
  if (input.servedSecretsFile)
    await forEachLimited(
      await readServedSecrets(input.servedSecretsFile),
      STAT_CONCURRENCY,
      async (secret) => {
        const absolute = NodePath.join(input.folder, secret.path);
        let stat: Awaited<ReturnType<typeof NodeFSP.lstat>> | null;
        let sha256: string | null;
        try {
          stat = await NodeFSP.lstat(absolute).catch((cause: NodeJS.ErrnoException) => {
            if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
            throw cause;
          });
          sha256 = stat?.isFile() ? await smallFileHash(absolute) : null;
        } catch {
          rows.set(fileKey(secret.path), { path: secret.path, kind: "unreadable" });
          return;
        }
        if (sha256 === null)
          rows.set(fileKey(secret.path), { path: secret.path, kind: "removed", size: secret.size });
        else if (sha256 !== secret.sha256)
          rows.set(fileKey(secret.path), {
            path: secret.path,
            kind: "changed",
            size: Number(stat!.size),
          });
      },
    );
  for (const row of await repositoryRows(
    input.folder,
    copied.header.repositories,
    current.repositories,
    copiedEntries,
    basis,
  ))
    rows.set(driftRowKey(row), row);
  const all = [...rows.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : driftRowKey(a) < driftRowKey(b) ? -1 : 1,
  );
  const digest = sha256Hex(Buffer.from(JSON.stringify(all.map((row) => [row.path, row.kind]))));
  const checkedAt = input.now();
  if (all.length > 0)
    await writeJson(reportFile(input.directory, digest), {
      version: 1,
      digest,
      checkedAt,
      total: all.length,
      rows: all,
    } satisfies StoredReport);
  return {
    checkedAt,
    total: all.length,
    digest,
    rows: all.slice(0, MAX_DRIFT_ROWS),
    truncated: all.length > MAX_DRIFT_ROWS,
  };
}

/** A report this source produced for the operation, or null for any other digest. */
export async function readDriftReport(
  directory: string,
  digest: string,
): Promise<StoredReport | null> {
  if (!DIGEST.test(digest)) return null;
  const report = await readJson<StoredReport>(reportFile(directory, digest)).catch(() => null);
  return report?.version === 1 && report.digest === digest && Array.isArray(report.rows)
    ? report
    : null;
}
