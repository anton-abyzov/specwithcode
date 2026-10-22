// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the source serves file ranges through no-follow descriptors.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { FILE_CLASSES, type FileClass } from "./classify.ts";
import { privateDirectory, readJson, writeJson } from "./durable.ts";
import { runGit } from "./git.ts";
import {
  CHUNK_SIZE,
  expandCollapsed,
  type FolderScan,
  hashFile,
  hashSelected,
  type ManifestEntry,
  type ManifestHeader,
  readManifestFile,
  scanFolder,
  selectEntries,
  writeManifest,
  type ClassTotals,
  type RepositoryInfo,
} from "./manifest.ts";
import { isSafeRelativePath } from "./paths.ts";
import { preparePortableGit, sourceEntryRoot } from "./portableGit.ts";
import {
  MAX_SECRET_FILE_BYTES,
  type SecretApproval,
  SecretStepError,
  selectSecretFiles,
  SentSecretsLedger,
} from "./secrets.ts";
import {
  mintTransferGrant,
  revokeTransferGrant,
  transferGrantExpiresAt,
  type TransferGrantRecord,
  verifyTransferGrant,
} from "./transferGrant.ts";
import {
  CHUNK_CHANGED,
  CHUNK_OK,
  CHUNK_UNKNOWN,
  type ChunkFrame,
  OPERATION_ID,
  sha256Hex,
} from "./wire.ts";

import { validProjectRelativePath } from "../folderCopyScope.ts";

export type CopyMode = "copy-only" | "copy-and-move";
export type SourceState =
  | "scanning"
  | "scanned"
  | "building"
  | "ready"
  | "failed"
  | "committed"
  | "released"
  | "cancelled";

export interface SourceSummary {
  readonly totals: ClassTotals;
  readonly repositories: ReadonlyArray<{
    readonly path: string;
    readonly kind: RepositoryInfo["kind"];
    readonly head: string | null;
    readonly branch: string | null;
    readonly branchCount: number;
    readonly stashCount: number;
    readonly changedFiles: number;
  }>;
  readonly secretFiles: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly linksOutside: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface SourceOperationRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly projectId: string;
  readonly folder: string;
  readonly projectRelativePath?: string;
  readonly mode: CopyMode;
  readonly destinationEnvironmentId: string;
  readonly createdAt: number;
  readonly grant: TransferGrantRecord;
  readonly state: SourceState;
  readonly selection: ReadonlyArray<FileClass> | null;
  readonly summary: SourceSummary | null;
  readonly progress: { readonly files: number; readonly bytes: number } | null;
  readonly error: string | null;
  readonly releaseReason: string | null;
  /** Retried on a later terminal status read; never invalidates an applied copy. */
  readonly snapshotCleanupPending?: boolean;
  /** Snapshot caveats captured when the offer was made, retained across restarts. */
  readonly warnings?: ReadonlyArray<string>;
  /** Secret files the person ticked for this destination; absent until they approve any. */
  readonly secrets?: SecretApproval | null;
}

export class SourceTransferError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

interface Hooks {
  /** Returns the source coordinator to active after a copy-and-move fails before Apply. */
  readonly release?: (record: SourceOperationRecord, reason: string) => Promise<void>;
  readonly now?: () => number;
}

interface Loaded {
  record: SourceOperationRecord;
  scan: FolderScan | null;
  entries: Map<string, ManifestEntry> | null;
  chunks: Map<string, { path: string; offset: number; length: number }> | null;
  header: ManifestHeader | null;
  building: Promise<void> | null;
  readers: Set<Promise<void>>;
  terminalUpdate: Promise<void>;
  saving: Promise<void>;
}

const TERMINAL: ReadonlySet<SourceState> = new Set(["committed", "released", "cancelled"]);

function summarize(scan: FolderScan, warnings: ReadonlyArray<string> = []): SourceSummary {
  return {
    totals: scan.totals,
    repositories: scan.repositories.map((repo) => ({
      path: repo.path,
      kind: repo.kind,
      head: repo.head,
      branch: repo.branch,
      branchCount: Object.keys(repo.branches).length,
      stashCount: repo.stashCount,
      changedFiles: repo.status.length,
    })),
    secretFiles: scan.entries
      .filter((entry) => entry.class === "secret" && entry.type === "file")
      .slice(0, 500)
      .map((entry) => ({ path: entry.path, size: entry.size })),
    linksOutside: scan.entries.filter(
      (entry) => entry.type === "symlink" && entry.target?.startsWith("/"),
    ).length,
    warnings: [...new Set([...warnings, ...scan.warnings, ...(scan.notices ?? [])])].slice(0, 50),
  };
}

/**
 * Opens a manifest file for reading only if no folder on its path became a link
 * since the scan, and the file itself is not one.
 */
async function openInside(root: string, relative: string): Promise<NodeFSP.FileHandle> {
  if (!isSafeRelativePath(relative)) throw new SourceTransferError(400, "unsafe_path");
  const absolute = NodePath.join(root, relative);
  const parent = NodePath.dirname(absolute);
  if ((await NodeFSP.realpath(parent)) !== parent) throw new SourceTransferError(409, "changed");
  return NodeFSP.open(absolute, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
}

export class SourceTransfers {
  private readonly operations = new Map<string, Loaded>();
  private readonly now: () => number;

  readonly stateRoot: string;
  readonly sentSecrets: SentSecretsLedger;
  private readonly hooks: Hooks;

  constructor(stateRoot: string, hooks: Hooks = {}) {
    this.stateRoot = stateRoot;
    this.sentSecrets = new SentSecretsLedger(stateRoot);
    this.hooks = hooks;
    this.now = hooks.now ?? (() => Date.now());
  }

  private directory(operationId: string) {
    if (!OPERATION_ID.test(operationId)) throw new SourceTransferError(404, "not_found");
    return NodePath.join(this.stateRoot, "folder-sources", operationId);
  }

  private async save(loaded: Loaded, patch: Partial<SourceOperationRecord>) {
    loaded.record = { ...loaded.record, ...patch };
    const record = loaded.record;
    const saved = loaded.saving.then(() =>
      writeJson(NodePath.join(this.directory(record.operationId), "operation.json"), record),
    );
    loaded.saving = saved.catch(() => undefined);
    await saved;
  }

  private async load(operationId: string): Promise<Loaded | null> {
    const cached = this.operations.get(operationId);
    if (cached) return cached;
    const record = await readJson<SourceOperationRecord>(
      NodePath.join(this.directory(operationId), "operation.json"),
    );
    if (!record) return null;
    // Another request may have populated the cache during the disk read.
    const concurrent = this.operations.get(operationId);
    if (concurrent) return concurrent;
    const loaded: Loaded = {
      record,
      scan: null,
      entries: null,
      chunks: null,
      header: null,
      building: null,
      readers: new Set(),
      terminalUpdate: Promise.resolve(),
      saving: Promise.resolve(),
    };
    this.operations.set(operationId, loaded);
    return loaded;
  }

  /**
   * Starts a copy offer: scans the folder in the background and mints the grant.
   * Offering the same operation again returns the same record with a fresh token
   * only while nothing has been pulled.
   */
  async offer(input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly folder: string;
    readonly projectRelativePath?: string;
    readonly mode: CopyMode;
    readonly destinationEnvironmentId: string;
    readonly warnings?: ReadonlyArray<string>;
  }): Promise<{ readonly token: string; readonly record: SourceOperationRecord }> {
    const folder = await NodeFSP.realpath(input.folder);
    const projectRelativePath = input.projectRelativePath ?? ".";
    if (!validProjectRelativePath(projectRelativePath))
      throw new SourceTransferError(400, "invalid_scope");
    const directory = this.directory(input.operationId);
    const existing = await this.load(input.operationId);
    if (
      existing &&
      (existing.record.projectId !== input.projectId ||
        existing.record.destinationEnvironmentId !== input.destinationEnvironmentId ||
        existing.record.mode !== input.mode ||
        existing.record.folder !== folder ||
        (existing.record.projectRelativePath ?? ".") !== projectRelativePath)
    )
      throw new SourceTransferError(409, "conflict");
    if (existing && TERMINAL.has(existing.record.state))
      throw new SourceTransferError(409, "finished");
    await privateDirectory(NodePath.dirname(directory));
    await privateDirectory(directory);
    const minted = mintTransferGrant({
      operationId: input.operationId,
      root: folder,
      projectId: input.projectId,
      destinationEnvironmentId: input.destinationEnvironmentId,
      now: this.now(),
    });
    if (existing) {
      // A retried offer replaces the token; the old one stops working at once.
      await this.save(existing, {
        grant: { ...minted.record, issuedAt: existing.record.grant.issuedAt },
      });
      return { token: minted.token, record: existing.record };
    }
    const loaded: Loaded = {
      record: {
        version: 1,
        operationId: input.operationId,
        projectId: input.projectId,
        folder,
        projectRelativePath,
        mode: input.mode,
        destinationEnvironmentId: input.destinationEnvironmentId,
        createdAt: this.now(),
        grant: minted.record,
        state: "scanning",
        selection: null,
        summary: null,
        progress: null,
        error: null,
        releaseReason: null,
        warnings: input.warnings ?? [],
      },
      scan: null,
      entries: null,
      chunks: null,
      header: null,
      building: null,
      readers: new Set(),
      terminalUpdate: Promise.resolve(),
      saving: Promise.resolve(),
    };
    this.operations.set(input.operationId, loaded);
    await this.save(loaded, {});
    loaded.building = this.scan(loaded);
    return { token: minted.token, record: loaded.record };
  }

  private async scan(loaded: Loaded): Promise<void> {
    try {
      loaded.scan = await preparePortableGit(
        await scanFolder(loaded.record.folder),
        this.snapshotRoot(loaded),
      );
      await this.save(loaded, {
        state: "scanned",
        summary: summarize(loaded.scan, loaded.record.warnings),
      });
    } catch (cause) {
      await this.save(loaded, { state: "failed", error: errorText(cause) });
    } finally {
      loaded.building = null;
    }
  }

  async read(operationId: string): Promise<SourceOperationRecord | null> {
    const loaded = await this.load(operationId);
    if (loaded?.record.snapshotCleanupPending && TERMINAL.has(loaded.record.state))
      await this.transition(loaded, async () => {
        await this.clearSnapshot(loaded);
        return loaded.record;
      });
    return loaded?.record ?? null;
  }

  /** Checks the bearer on every request; the refreshed last use is saved lazily. */
  async authorize(operationId: string, token: string | null): Promise<Loaded> {
    const loaded = OPERATION_ID.test(operationId) ? await this.load(operationId) : null;
    const verdict = verifyTransferGrant(loaded?.record.grant ?? null, {
      operationId,
      token,
      now: this.now(),
    });
    if (!verdict.ok || !loaded) throw new SourceTransferError(401, "unauthorized");
    if (verdict.record.lastUsedAt - loaded.record.grant.lastUsedAt > 60_000)
      await this.save(loaded, { grant: verdict.record });
    return loaded;
  }

  hello(loaded: Loaded, environmentId: string) {
    return {
      version: 1,
      projectId: loaded.record.projectId,
      copyRoot: loaded.record.folder,
      projectRelativePath: loaded.record.projectRelativePath ?? ".",
      environmentId,
      operationId: loaded.record.operationId,
      mode: loaded.record.mode,
      state: loaded.record.state,
      expiresAt: transferGrantExpiresAt(loaded.record.grant),
    };
  }

  /** Builds (once) the manifest for the destination's selection. Secrets never enter it here. */
  async requestManifest(
    loaded: Loaded,
    selection: ReadonlyArray<string>,
  ): Promise<SourceOperationRecord> {
    return this.transition(loaded, async () => {
      if (TERMINAL.has(loaded.record.state))
        throw new SourceTransferError(409, loaded.record.state);
      const classes = selection.filter(
        (item): item is FileClass =>
          (FILE_CLASSES as ReadonlyArray<string>).includes(item) && item !== "secret",
      );
      if (classes.length === 0) throw new SourceTransferError(400, "invalid_selection");
      if (loaded.record.selection) {
        if ([...loaded.record.selection].sort().join() !== [...classes].sort().join())
          throw new SourceTransferError(409, "conflict");
        return loaded.record;
      }
      if (loaded.building) await loaded.building;
      if (loaded.record.state !== "scanned" && loaded.record.state !== "scanning")
        throw new SourceTransferError(409, loaded.record.state);
      await this.save(loaded, {
        state: "building",
        selection: classes,
        progress: { files: 0, bytes: 0 },
      });
      loaded.building = this.build(loaded, new Set(classes));
      return loaded.record;
    });
  }

  private async build(loaded: Loaded, selection: ReadonlySet<FileClass>): Promise<void> {
    try {
      let scan = loaded.scan ?? (await scanFolder(loaded.record.folder));
      // Measurement may already have normalized an external worktree to kind
      // "main". Re-read its live index/refs before making the actual manifest.
      if (scan.entries.some((entry) => entry.portableGit))
        scan = await scanFolder(loaded.record.folder);
      if (selection.has("rebuildable")) scan = await expandCollapsed(scan);
      scan = await preparePortableGit(scan, this.snapshotRoot(loaded));
      let lastSaved = 0;
      await hashSelected(
        scan,
        selection,
        (done) => {
          loaded.record = { ...loaded.record, progress: done };
          if (this.now() - lastSaved > 2_000) {
            lastSaved = this.now();
            void this.save(loaded, {}).catch(() => undefined);
          }
        },
        (entry) => sourceEntryRoot(loaded.record.folder, this.snapshotRoot(loaded), entry),
      );
      const entries = selectEntries(scan.entries, selection);
      const header: ManifestHeader = {
        version: 1,
        operationId: loaded.record.operationId,
        copyRoot: loaded.record.folder,
        projectRelativePath: loaded.record.projectRelativePath ?? ".",
        chunkSize: CHUNK_SIZE,
        selection: [...selection],
        repositories: scan.repositories,
        totals: scan.totals,
        warnings: [
          ...new Set([
            ...(loaded.record.warnings ?? []),
            ...scan.warnings,
            ...(scan.notices ?? []),
          ]),
        ],
        entryCount: entries.length,
      };
      await writeManifest(this.manifestFile(loaded.record.operationId), { header, entries });
      loaded.scan = scan;
      this.index(loaded, header, entries);
      await this.save(loaded, { state: "ready", summary: summarize(scan, loaded.record.warnings) });
    } catch (cause) {
      await this.save(loaded, { state: "failed", error: errorText(cause) });
    } finally {
      loaded.building = null;
    }
  }

  private manifestFile(operationId: string) {
    return NodePath.join(this.directory(operationId), "manifest.ndjson.gz");
  }

  private snapshotRoot(loaded: Loaded) {
    return NodePath.join(this.directory(loaded.record.operationId), "portable-git");
  }

  private entryRoot(loaded: Loaded, path: string) {
    const entry = loaded.entries?.get(path);
    return entry
      ? sourceEntryRoot(loaded.record.folder, this.snapshotRoot(loaded), entry)
      : loaded.record.folder;
  }

  private async snapshotRead<T>(loaded: Loaded, read: () => Promise<T>): Promise<T> {
    if (TERMINAL.has(loaded.record.state)) throw new SourceTransferError(409, loaded.record.state);
    let finished!: () => void;
    const pending = new Promise<void>((resolve) => {
      finished = resolve;
    });
    loaded.readers.add(pending);
    try {
      return await read();
    } finally {
      loaded.readers.delete(pending);
      finished();
    }
  }

  private transition(loaded: Loaded, change: () => Promise<SourceOperationRecord>) {
    const result = loaded.terminalUpdate.then(change);
    loaded.terminalUpdate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Only the generated overlay is disposable; the manifest supports later context checks. */
  private async clearSnapshot(loaded: Loaded) {
    await Promise.all(loaded.readers);
    const warning = "Temporary Git snapshot cleanup is pending; the copy result is unchanged.";
    try {
      await NodeFSP.rm(this.snapshotRoot(loaded), { recursive: true, force: true });
      loaded.scan = null;
      if (loaded.record.snapshotCleanupPending)
        await this.save(loaded, {
          snapshotCleanupPending: false,
          warnings: (loaded.record.warnings ?? []).filter((item) => item !== warning),
        });
    } catch {
      // The files were already applied and the grant ended. Housekeeping must
      // not turn that acknowledgment into a failure that cannot be retried.
      await this.save(loaded, {
        snapshotCleanupPending: true,
        warnings: [...new Set([...(loaded.record.warnings ?? []), warning])],
      }).catch(() => undefined);
    }
  }

  private index(loaded: Loaded, header: ManifestHeader, entries: ReadonlyArray<ManifestEntry>) {
    loaded.header = header;
    loaded.entries = new Map(entries.map((entry) => [entry.path, entry]));
    loaded.chunks = new Map();
    for (const entry of entries) this.indexChunks(loaded, entry);
  }

  private indexChunks(loaded: Loaded, entry: ManifestEntry) {
    if (entry.type !== "file" || !entry.chunks) return;
    entry.chunks.forEach((sha, index) => {
      if (!loaded.chunks!.has(sha))
        loaded.chunks!.set(sha, {
          path: entry.path,
          offset: index * CHUNK_SIZE,
          length: Math.min(CHUNK_SIZE, entry.size - index * CHUNK_SIZE),
        });
    });
  }

  private async ready(loaded: Loaded): Promise<void> {
    if (loaded.record.state !== "ready" && loaded.record.state !== "committed")
      throw new SourceTransferError(409, loaded.record.state);
    if (!loaded.entries) {
      const manifest = await readManifestFile(this.manifestFile(loaded.record.operationId));
      this.index(loaded, manifest.header, manifest.entries);
    }
  }

  /** The gzipped manifest, or the build's progress while it is still hashing. */
  async manifest(
    loaded: Loaded,
  ): Promise<
    | { readonly ready: true; readonly bytes: Buffer }
    | { readonly ready: false; readonly record: SourceOperationRecord }
  > {
    if (loaded.record.state === "failed")
      throw new SourceTransferError(409, "failed", loaded.record.error ?? undefined);
    if (loaded.record.state !== "ready") return { ready: false, record: loaded.record };
    await this.ready(loaded);
    return {
      ready: true,
      bytes: await NodeFSP.readFile(this.manifestFile(loaded.record.operationId)),
    };
  }

  /** Reads each requested chunk and re-hashes it, so a changed file is reported, never sent. */
  async chunks(loaded: Loaded, hashes: ReadonlyArray<string>): Promise<Array<ChunkFrame>> {
    return this.snapshotRead(loaded, async () => {
      await this.ready(loaded);
      const frames: Array<ChunkFrame> = [];
      for (const sha256 of hashes) {
        const location = loaded.chunks!.get(sha256);
        if (!location) {
          frames.push({ sha256, status: CHUNK_UNKNOWN, data: Buffer.alloc(0) });
          continue;
        }
        let data: Buffer;
        try {
          const handle = await openInside(this.entryRoot(loaded, location.path), location.path);
          try {
            data = Buffer.alloc(location.length);
            const { bytesRead } = await handle.read(data, 0, location.length, location.offset);
            data = data.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        } catch {
          frames.push({ sha256, status: CHUNK_CHANGED, data: Buffer.alloc(0) });
          continue;
        }
        frames.push(
          sha256Hex(data) === sha256
            ? { sha256, status: CHUNK_OK, data }
            : { sha256, status: CHUNK_CHANGED, data: Buffer.alloc(0) },
        );
      }
      return frames;
    });
  }

  /** Current size and mtime of manifest paths, for the final consistency pass. */
  async stat(loaded: Loaded, paths: ReadonlyArray<string>) {
    return this.snapshotRead(loaded, async () => {
      await this.ready(loaded);
      const result: Array<
        | { path: string; missing: true }
        | {
            path: string;
            type: "file" | "directory" | "symlink" | "other";
            size: number;
            mtimeMs: number;
            target?: string;
          }
      > = [];
      for (const path of paths) {
        if (!loaded.entries!.has(path)) continue;
        const absolute = NodePath.join(this.entryRoot(loaded, path), path);
        const stat = await NodeFSP.lstat(absolute).catch(() => null);
        if (!stat) {
          result.push({ path, missing: true });
          continue;
        }
        result.push({
          path,
          type: stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : stat.isSymbolicLink()
                ? "symlink"
                : "other",
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
          ...(stat.isSymbolicLink() ? { target: await NodeFSP.readlink(absolute) } : {}),
        });
      }
      return result;
    });
  }

  /** Re-reads files that changed after the manifest and returns their new entries. */
  async refresh(loaded: Loaded, paths: ReadonlyArray<string>) {
    return this.snapshotRead(loaded, async () => {
      await this.ready(loaded);
      const updated: Array<ManifestEntry | { path: string; missing: true }> = [];
      for (const path of paths) {
        const previous = loaded.entries!.get(path);
        if (!previous) continue;
        const absolute = NodePath.join(this.entryRoot(loaded, path), path);
        const stat = await NodeFSP.lstat(absolute).catch(() => null);
        if (
          !stat ||
          (previous.type === "file" && !stat.isFile()) ||
          (previous.type === "symlink" && !stat.isSymbolicLink())
        ) {
          updated.push({ path, missing: true });
          continue;
        }
        let next: ManifestEntry;
        if (stat.isSymbolicLink()) {
          next = {
            ...previous,
            target: await NodeFSP.readlink(absolute),
            mtimeMs: Math.trunc(stat.mtimeMs),
          };
        } else {
          const hashed = await hashFile(absolute, false);
          next = { ...previous, ...hashed, mode: stat.mode & 0o7777 };
        }
        loaded.entries!.set(path, next);
        this.indexChunks(loaded, next);
        updated.push(next);
      }
      return updated;
    });
  }

  /** A later context transfer must never run against an older copied tree. */
  async assertCurrentSnapshot(operationId: string): Promise<void> {
    const loaded = await this.load(operationId);
    if (!loaded || loaded.record.state !== "committed")
      throw new SourceTransferError(409, "not_committed");
    // Compare against the durable original manifest, not mutable in-memory refreshes:
    // the destination may have omitted a changing file or kept its own version.
    const copied = await readManifestFile(this.manifestFile(operationId));
    const selection = new Set(copied.header.selection);
    const checkRoot = await NodeFSP.mkdtemp(
      NodePath.join(this.directory(operationId), "git-check-"),
    );
    let current: FolderScan;
    try {
      current = await preparePortableGit(
        await scanFolder(loaded.record.folder, {
          expandRebuildable: selection.has("rebuildable"),
        }),
        checkRoot,
      );
      await hashSelected(current, selection, undefined, (entry) =>
        sourceEntryRoot(loaded.record.folder, checkRoot, entry),
      );
    } finally {
      await NodeFSP.rm(checkRoot, { recursive: true, force: true });
    }
    const entries = selectEntries(current.entries, selection);
    const signature = (items: ReadonlyArray<ManifestEntry>) =>
      JSON.stringify(
        items
          .map(({ path, type, mode, size, sha256, target }) => ({
            path,
            type,
            mode,
            size,
            sha256,
            target,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
    const repositories = (items: ReadonlyArray<RepositoryInfo>) =>
      JSON.stringify(items.map(({ status: _status, worktrees: _worktrees, ...repo }) => repo));
    if (
      current.warnings.length > 0 ||
      copied.entries.some((entry) => entry.unstable) ||
      entries.some((entry) => entry.unstable) ||
      signature(entries) !== signature(copied.entries) ||
      repositories(current.repositories) !== repositories(copied.header.repositories)
    )
      throw new SourceTransferError(409, "source_changed");
  }

  /** Whether each commit exists here and is an ancestor of (or equal to) the repository's HEAD. */
  async ancestry(loaded: Loaded, repository: string, commits: ReadonlyArray<string>) {
    await this.ready(loaded);
    if (!loaded.header!.repositories.some((repo) => repo.path === repository))
      throw new SourceTransferError(404, "unknown_repository");
    const cwd =
      repository === "." ? loaded.record.folder : NodePath.join(loaded.record.folder, repository);
    const result: Array<{ commit: string; present: boolean; ancestorOfHead: boolean }> = [];
    for (const commit of commits) {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) continue;
      const present =
        (await runGit(cwd, ["cat-file", "-e", `${commit}^{commit}`], { allowFailure: true }))
          .code === 0;
      const ancestorOfHead =
        present &&
        (await runGit(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"], { allowFailure: true }))
          .code === 0;
      result.push({ commit, present, ancestorOfHead });
    }
    return result;
  }

  /**
   * Records the secret files the person ticked for this destination. Only files
   * the scan classified as secret can be listed; an empty list withdraws them.
   */
  async approveSecrets(input: {
    readonly operationId: string;
    readonly paths: ReadonlyArray<string>;
    readonly destinationLabel: string;
  }): Promise<SourceOperationRecord> {
    const loaded = await this.load(input.operationId);
    if (!loaded) throw new SourceTransferError(404, "not_found");
    if (TERMINAL.has(loaded.record.state)) throw new SourceTransferError(409, loaded.record.state);
    if (!loaded.record.summary) throw new SourceTransferError(409, "scanning");
    let files;
    try {
      files = selectSecretFiles(loaded.record.summary.secretFiles, input.paths);
    } catch (cause) {
      if (cause instanceof SecretStepError)
        throw new SourceTransferError(400, cause.code, cause.message);
      throw cause;
    }
    await this.save(loaded, {
      secrets:
        files.length === 0
          ? null
          : {
              files,
              approvedAt: this.now(),
              destinationLabel: input.destinationLabel.slice(0, 200),
            },
    });
    return loaded.record;
  }

  /** The secret files the destination may pull: paths and sizes only. */
  secretList(loaded: Loaded) {
    return { files: loaded.record.secrets?.files ?? [] };
  }

  /**
   * Bytes of one approved secret file, read without following links. Each file
   * served is recorded in the sent-secrets ledger (path and size, never content).
   */
  async secretFile(loaded: Loaded, path: string): Promise<Uint8Array> {
    if (TERMINAL.has(loaded.record.state)) throw new SourceTransferError(409, loaded.record.state);
    const approved = loaded.record.secrets?.files.find((file) => file.path === path);
    if (!approved) throw new SourceTransferError(403, "not_approved");
    let bytes: Buffer;
    try {
      const handle = await openInside(loaded.record.folder, path);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_SECRET_FILE_BYTES)
          throw new SourceTransferError(409, "changed");
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (cause instanceof SourceTransferError) throw cause;
      throw new SourceTransferError(409, "changed");
    }
    if (bytes.byteLength > MAX_SECRET_FILE_BYTES) throw new SourceTransferError(409, "changed");
    await this.sentSecrets.record({
      operationId: loaded.record.operationId,
      destinationEnvironmentId: loaded.record.destinationEnvironmentId,
      destinationLabel: loaded.record.secrets?.destinationLabel ?? "",
      folder: loaded.record.folder,
      path,
      size: bytes.byteLength,
      sentAt: new Date(this.now()).toISOString(),
    });
    return bytes;
  }

  /** The destination failed before Apply: unfence a moving coordinator and end the grant. */
  async release(loaded: Loaded, reason: string): Promise<SourceOperationRecord> {
    return this.transition(loaded, async () => {
      if (loaded.building) await loaded.building;
      if (loaded.record.state === "committed") throw new SourceTransferError(409, "committed");
      if (loaded.record.state === "released" || loaded.record.state === "cancelled") {
        await this.clearSnapshot(loaded);
        return loaded.record;
      }
      const text = reason.slice(0, 500) || "The copy stopped before Apply.";
      if (loaded.record.mode === "copy-and-move") await this.hooks.release?.(loaded.record, text);
      await this.save(loaded, {
        state: "released",
        releaseReason: text,
        grant: revokeTransferGrant(loaded.record.grant, "released", this.now()),
      });
      await this.clearSnapshot(loaded);
      return loaded.record;
    });
  }

  /** The destination applied and verified the copy; from now on it cannot be released. */
  async commit(loaded: Loaded): Promise<SourceOperationRecord> {
    return this.transition(loaded, async () => {
      if (loaded.building) await loaded.building;
      if (loaded.record.state === "committed") {
        await this.clearSnapshot(loaded);
        return loaded.record;
      }
      if (loaded.record.state !== "ready") throw new SourceTransferError(409, loaded.record.state);
      await this.save(loaded, {
        state: "committed",
        grant: revokeTransferGrant(loaded.record.grant, "committed", this.now()),
      });
      await this.clearSnapshot(loaded);
      return loaded.record;
    });
  }

  /** Invalidates only deferred context transfer; the applied destination files stay intact.
   * The caller must hold the project admission lock and prove ownership was never published.
   */
  async abandonContextTransfer(
    operationId: string,
    reason: string,
  ): Promise<SourceOperationRecord> {
    const loaded = await this.load(operationId);
    if (!loaded || loaded.record.mode !== "copy-and-move")
      throw new SourceTransferError(409, "invalid");
    return this.transition(loaded, async () => {
      if (loaded.record.state === "released") {
        await this.clearSnapshot(loaded);
        return loaded.record;
      }
      if (loaded.record.state !== "committed") throw new SourceTransferError(409, "not_committed");
      await this.save(loaded, {
        state: "released",
        releaseReason:
          reason.slice(0, 500) ||
          "Coordinator context transfer was abandoned; the copied files remain.",
      });
      await this.clearSnapshot(loaded);
      return loaded.record;
    });
  }

  /** Checked before replaying a cached prepared handoff, including after a restart. */
  async assertContextAvailable(operationId: string): Promise<void> {
    const loaded = await this.load(operationId);
    if (!loaded || ["released", "cancelled", "failed"].includes(loaded.record.state))
      throw new SourceTransferError(409, "context_closed");
  }

  /** The person cancelled on the source. Refused once the destination committed. */
  async cancel(operationId: string, reason: string): Promise<SourceOperationRecord> {
    const loaded = await this.load(operationId);
    if (!loaded) throw new SourceTransferError(404, "not_found");
    return this.transition(loaded, async () => {
      if (loaded.building) await loaded.building;
      if (loaded.record.state === "committed") throw new SourceTransferError(409, "committed");
      if (loaded.record.state === "cancelled" || loaded.record.state === "released") {
        await this.clearSnapshot(loaded);
        return loaded.record;
      }
      if (loaded.record.mode === "copy-and-move") await this.hooks.release?.(loaded.record, reason);
      await this.save(loaded, {
        state: "cancelled",
        releaseReason: reason.slice(0, 500),
        grant: revokeTransferGrant(loaded.record.grant, "cancelled", this.now()),
      });
      await this.clearSnapshot(loaded);
      return loaded.record;
    });
  }
}

export function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
}
