// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the source serves file ranges through no-follow descriptors; close bounds shutdown with a timer.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../../workspace/WorkspaceSensitivePaths.ts";
import { FILE_CLASSES, type FileClass } from "./classify.ts";
import { privateDirectory, readJson, writeJson } from "./durable.ts";
import { runGit } from "./git.ts";
import {
  CHUNK_SIZE,
  expandCollapsed,
  type FolderScan,
  FolderScanError,
  hashFile,
  hashSelected,
  type ManifestEntry,
  type ManifestHeader,
  isScanStopped,
  readManifestFile,
  scanFolder,
  selectEntries,
  writeManifest,
} from "./manifest.ts";
import { CaptureFilesystemRefused } from "./sourceCaptureFilesystem.ts";
import {
  computeDrift,
  driftBasisFile,
  recordServedSecret,
  servedSecretsFile,
  uncopyableCounts,
  indexDigests,
  refDigests,
  readDriftReport,
  type SourceDrift,
} from "./sourceDrift.ts";
import {
  inventoryFingerprint,
  summarize,
  withGitNotice,
  type SourceSummary,
} from "./sourceSummary.ts";
import { isSafeRelativePath, linkTargetOnWire } from "./paths.ts";
import { checkPortableGit, preparePortableGit, sourceEntryRoot } from "./portableGit.ts";
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

import {
  captureSourceFiles,
  capturedRange,
  syncCapturedDirectory,
  removeSourceBackings,
  sourceCleanupCodes,
  loadCapturedIndex,
  validateCapturedSource,
  type CapturedSource,
  type CapturedIndex,
} from "./sourceSnapshot.ts";

import { validProjectRelativePath } from "../folderCopyScope.ts";

export type { SourceSummary } from "./sourceSummary.ts";
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

/** What a scan or build is doing, with its running counts. */
export interface SourceProgress {
  readonly files: number;
  readonly bytes: number;
  readonly step?: "listing" | "checking-worktrees" | "git-snapshot" | "hashing";
  /** While hashing: the selected files and bytes to read in all. */
  readonly totalFiles?: number;
  readonly totalBytes?: number;
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
  readonly scanCompletedAt?: number;
  readonly sourceFingerprint?: string;
  readonly capturedSource?: CapturedSource;
  readonly freshness?: {
    readonly checkedAt: number;
    readonly current: boolean;
    readonly summary?: SourceSummary;
  };
  readonly grant: TransferGrantRecord;
  readonly state: SourceState;
  readonly selection: ReadonlyArray<FileClass> | null;
  readonly summary: SourceSummary | null;
  readonly progress: SourceProgress | null;
  readonly error: string | null;
  readonly releaseReason: string | null;
  /** Retried on a later terminal status read; never invalidates an applied copy. */
  readonly snapshotCleanupPending?: boolean;
  readonly snapshotCleanupCodes?: ReadonlyArray<string>;
  /** Snapshot caveats captured when the offer was made, retained across restarts. */
  readonly warnings?: ReadonlyArray<string>;
  /** Secret files the person ticked for this destination; absent until they approve any. */
  readonly secrets?: SecretApproval | null;
  /** The reviewed change list a coordinator move went ahead with. */
  readonly acceptedDrift?: {
    readonly digest: string;
    readonly total: number;
    readonly acceptedAt: number;
  };
  /** The paths that differed when the coordinator moved; they stay only on this machine. */
  readonly leftOnSource?: {
    readonly digest: string;
    readonly total: number;
    readonly recordedAt: number;
  };
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
  /** Proves a source filesystem for captured copies; tests stand in an unverifiable volume. */
  readonly verifyCaptureFilesystem?: (root: string, mode: CopyMode) => Promise<void>;
  /** The wall clock a capture compares file stamps with; tests move it past fresh files. */
  readonly stampClock?: () => number;
}

interface ChunkPlace {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
}

/** Where a chunk can be read; `also` holds a few other files with the same bytes. */
interface ChunkLocation extends ChunkPlace {
  also?: Array<ChunkPlace>;
}

/** Other places kept per chunk, so one file changing does not fail its duplicates. */
const MAX_CHUNK_ALTERNATES = 4;

interface Loaded {
  record: SourceOperationRecord;
  scan: FolderScan | null;
  entries: Map<string, ManifestEntry> | null;
  chunks: Map<string, ChunkLocation> | null;
  header: ManifestHeader | null;
  capturedIndex: CapturedIndex | null;
  building: Promise<void> | null;
  /** Stops the running scan or build; a cancel or release aborts it. */
  stop: AbortController | null;
  /** A cancel or release is waiting for the running scan or build to stop. */
  stopRequested: boolean;
  /** When `scan` was measured, on this service's clock. */
  scannedAt: number;
  readers: Set<Promise<void>>;
  /** When the destination last asked for anything but a keepalive, on this service's clock. */
  pulledAt: number;
  terminalUpdate: Promise<void>;
  saving: Promise<void>;
}

/** How long `close` lets running chunk reads and transitions finish. */
const CLOSE_SETTLE_MS = 2_000;
/** Scan and build progress reach `operation.json` at most this often; reads see it at once. */
const PROGRESS_SAVE_MS = 3_000;
/**
 * A copy started this soon after measuring reuses the measured listing; later it
 * lists the folder again, so the manifest and Git snapshot match when copying starts.
 */
const MEASURE_REUSE_MS = 30_000;

const TERMINAL: ReadonlySet<SourceState> = new Set(["committed", "released", "cancelled"]);

/** An operation whose chunk reads or transitions were still running when `close` stopped waiting. */
export interface PendingAtClose {
  readonly operationId: string;
  readonly pending: number;
}

/**
 * Saves a restart must honour even after `close`: an end state, a failure, a
 * revoked grant, snapshot cleanup or what a move left here. A cancel or release can already have
 * returned the coordinator, so dropping its record would let a restarted source
 * keep serving the copy. Progress, scan results and grant refreshes stay in memory.
 */
function persistsAfterClose(patch: Partial<SourceOperationRecord>): boolean {
  return (
    (patch.state !== undefined && (TERMINAL.has(patch.state) || patch.state === "failed")) ||
    (patch.grant !== undefined && patch.grant.revokedAt !== null) ||
    patch.snapshotCleanupPending !== undefined ||
    patch.leftOnSource !== undefined
  );
}

const closedStop = (cause: unknown) =>
  cause instanceof SourceTransferError && cause.code === "closed";

const newLoaded = (record: SourceOperationRecord): Loaded => ({
  record,
  scan: null,
  entries: null,
  chunks: null,
  header: null,
  capturedIndex: null,
  building: null,
  stop: null,
  stopRequested: false,
  scannedAt: 0,
  readers: new Set(),
  pulledAt: Number.NEGATIVE_INFINITY,
  terminalUpdate: Promise.resolve(),
  saving: Promise.resolve(),
});

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
  private closed = false;

  readonly stateRoot: string;
  readonly sentSecrets: SentSecretsLedger;
  private readonly hooks: Hooks;

  constructor(stateRoot: string, hooks: Hooks = {}) {
    this.stateRoot = stateRoot;
    this.sentSecrets = new SentSecretsLedger(stateRoot);
    this.hooks = hooks;
    this.now = hooks.now ?? (() => Date.now());
  }

  /**
   * Stops routine record writes before the state folder goes away. `save`
   * publishes a state in memory before its write lands, so a caller that saw
   * "scanned" could otherwise close the service while `operation.json` was
   * still being written.
   *
   * Chunk reads and transitions already running get a short bound to finish;
   * the operations still busy when it fires are returned. A transition queued
   * behind a running scan or build waits for it (minutes, or forever on an
   * unresponsive folder), so it is not awaited. Afterwards queued writes drain,
   * scans and builds stop before their next write, and only the saves in
   * `persistsAfterClose` still reach disk.
   */
  async close(): Promise<ReadonlyArray<PendingAtClose>> {
    const loaded = [...this.operations.values()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), CLOSE_SETTLE_MS);
    });
    const pending = await Promise.all(
      loaded.map(async (item): Promise<PendingAtClose | null> => {
        const work = [...item.readers, ...(item.building ? [] : [item.terminalUpdate])];
        const outcome = await Promise.race([Promise.all(work).then(() => "done" as const), bound]);
        return outcome === "late"
          ? { operationId: item.record.operationId, pending: work.length }
          : null;
      }),
    );
    clearTimeout(timer);
    this.closed = true;
    await Promise.all(loaded.map((item) => item.saving));
    return pending.filter((item): item is PendingAtClose => item !== null);
  }

  /**
   * The operations this source serves right now, for the update gate: a scan or
   * build running, chunk reads in flight, or a destination that pulled within
   * `recentMs`. A measured folder nobody pulls and a held copy's hourly keepalive
   * never count, so an abandoned offer cannot hold an update back.
   */
  activeOperations(recentMs: number): Array<{ operationId: string; state: SourceState }> {
    const now = this.now();
    return [...this.operations.values()]
      .filter(
        (item) =>
          !TERMINAL.has(item.record.state) &&
          item.record.state !== "failed" &&
          (item.building !== null || item.readers.size > 0 || now - item.pulledAt <= recentMs),
      )
      .map((item) => ({ operationId: item.record.operationId, state: item.record.state }));
  }

  /** A scan or build stops before its next write into the state folder once closed. */
  private assertOpen() {
    if (this.closed) throw new SourceTransferError(503, "closed", "The copy service stopped.");
  }

  private directory(operationId: string) {
    if (!OPERATION_ID.test(operationId)) throw new SourceTransferError(404, "not_found");
    return NodePath.join(this.stateRoot, "folder-sources", operationId);
  }

  /** `durable` writes even after `close`, for a removal `persistsAfterClose` cannot see. */
  private async save(loaded: Loaded, patch: Partial<SourceOperationRecord>, durable = false) {
    loaded.record = { ...loaded.record, ...patch };
    if (this.closed && !durable && !persistsAfterClose(patch)) return;
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
    const loaded = newLoaded(record);
    this.operations.set(operationId, loaded);
    // A restart interrupted measuring or building: run it again rather than
    // leave the dialog waiting on work that no longer runs.
    if (!this.closed) {
      if (record.state === "scanning") loaded.building = this.scan(loaded);
      else if (record.state === "building" && record.selection)
        loaded.building = this.build(loaded, new Set(record.selection));
    }
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
    this.assertOpen();
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
    const loaded = newLoaded({
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
    });
    this.operations.set(input.operationId, loaded);
    await this.save(loaded, {});
    loaded.building = this.scan(loaded);
    return { token: minted.token, record: loaded.record };
  }

  /**
   * Measures the folder: a listing only. The Git snapshot is prepared by `build`
   * when copying starts, so measuring never copies object databases.
   */
  private async scan(loaded: Loaded): Promise<void> {
    const stop = new AbortController();
    loaded.stop = stop;
    if (loaded.stopRequested) stop.abort();
    try {
      const scanned = await scanFolder(loaded.record.folder, {
        shouldStop: () => this.closed || stop.signal.aborted,
        onProgress: this.progressReporter(loaded, stop, "listing"),
      });
      await checkPortableGit(scanned);
      this.assertOpen();
      // A cancel or release is about to record the end state.
      if (stop.signal.aborted) return;
      loaded.scan = scanned;
      loaded.scannedAt = this.now();
      await this.save(loaded, {
        state: "scanned",
        scanCompletedAt: this.now(),
        sourceFingerprint: inventoryFingerprint(scanned),
        progress: null,
        summary: summarize(withGitNotice(scanned), loaded.record.warnings),
      });
    } catch (cause) {
      await this.clearSnapshot(loaded);
      // Stopped by shutdown: the record keeps its state, so a restart can scan again.
      // Stopped by a cancel or release: that transition records the end state.
      if (!this.stoppedOnPurpose(cause, stop))
        await this.save(loaded, { state: "failed", error: errorText(cause) });
    } finally {
      if (loaded.stop === stop) loaded.stop = null;
      loaded.building = null;
    }
  }

  private stoppedOnPurpose(cause: unknown, stop: AbortController) {
    return closedStop(cause) || stop.signal.aborted || (this.closed && isScanStopped(cause));
  }

  /**
   * Keeps progress in memory for status reads and writes it now and then. A
   * report's own step (the worktree check inside a scan) wins over `step`.
   */
  private progressReporter(
    loaded: Loaded,
    stop: AbortController,
    step: NonNullable<SourceProgress["step"]>,
    totals?: { readonly files: number; readonly bytes: number },
  ) {
    let lastSaved = this.now();
    return (progress: {
      readonly files: number;
      readonly bytes: number;
      readonly step?: SourceProgress["step"];
    }) => {
      // Hashing has no stop check of its own: a cancel, release or close ends it here.
      if (stop.signal.aborted || this.closed) throw new FolderScanError("stopped");
      loaded.record = {
        ...loaded.record,
        progress: {
          files: progress.files,
          bytes: progress.bytes,
          step: progress.step ?? step,
          ...(totals ? { totalFiles: totals.files, totalBytes: totals.bytes } : {}),
        },
      };
      if (this.now() - lastSaved >= PROGRESS_SAVE_MS) {
        lastSaved = this.now();
        void this.save(loaded, {}).catch(() => undefined);
      }
    };
  }

  /**
   * Runs a cancel or release: stops a running scan or build first, so the
   * transition does not wait for it to finish. A transition that fails leaves an
   * interrupted scan or build to start again.
   */
  private async stopping(
    loaded: Loaded,
    change: () => Promise<SourceOperationRecord>,
  ): Promise<SourceOperationRecord> {
    loaded.stopRequested = true;
    loaded.stop?.abort();
    try {
      return await this.transition(loaded, change);
    } finally {
      loaded.stopRequested = false;
      if (!this.closed && !loaded.building) {
        if (loaded.record.state === "scanning") loaded.building = this.scan(loaded);
        else if (loaded.record.state === "building" && loaded.record.selection)
          loaded.building = this.build(loaded, new Set(loaded.record.selection));
      }
    }
  }

  async checkScan(operationId: string): Promise<SourceOperationRecord | null> {
    const loaded = await this.load(operationId);
    if (!loaded) return null;
    // save() publishes the ready state before its durable write completes.
    // A destination can already read that manifest while build() is finishing.
    // Wait for that published result, while genuine measuring still reports busy.
    if (loaded.building && ["scanned", "ready", "committed"].includes(loaded.record.state))
      await loaded.building;
    if (loaded.building || !["scanned", "ready", "committed"].includes(loaded.record.state))
      throw new SourceTransferError(
        409,
        "busy",
        "Wait for this copy to finish measuring before refreshing its scan.",
      );
    const original = loaded.record;
    const scan = await scanFolder(original.folder, {
      expandRebuildable: original.selection?.includes("rebuildable") ?? false,
      shouldStop: () => this.closed,
    });
    if (loaded.record !== original || loaded.building)
      throw new SourceTransferError(
        409,
        "busy",
        "The copy changed while its scan was being checked. Refresh again.",
      );
    return {
      ...original,
      freshness: {
        checkedAt: this.now(),
        summary: summarize(withGitNotice(scan), original.warnings),
        current:
          !!original.sourceFingerprint && original.sourceFingerprint === inventoryFingerprint(scan),
      },
    };
  }

  async read(operationId: string): Promise<SourceOperationRecord | null> {
    const loaded = await this.load(operationId);
    if (
      loaded?.record.snapshotCleanupPending &&
      (TERMINAL.has(loaded.record.state) || loaded.record.state === "failed")
    )
      await this.transition(loaded, async () => {
        await this.clearSnapshot(loaded);
        return loaded.record;
      });
    return loaded?.record ?? null;
  }

  /**
   * Checks the bearer on every request; the refreshed last use is saved lazily.
   * A commit, a release or a hello may present the grant that commit revoked:
   * when the commit's reply was lost, the destination's retry gets the committed
   * answer again, and its Undo learns the copy is committed (hello answers with
   * the state, release with 409 committed) instead of a 401.
   */
  async authorize(
    operationId: string,
    token: string | null,
    action?: "commit" | "release" | "hello",
  ): Promise<Loaded> {
    const loaded = OPERATION_ID.test(operationId) ? await this.load(operationId) : null;
    const verdict = verifyTransferGrant(loaded?.record.grant ?? null, {
      operationId,
      token,
      now: this.now(),
      ...(action !== undefined && loaded?.record.state === "committed"
        ? { revokedFor: "committed" }
        : {}),
    });
    if (!verdict.ok || !loaded) throw new SourceTransferError(401, "unauthorized");
    if (action !== "hello") loaded.pulledAt = this.now();
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
      if (loaded.stopRequested) throw new SourceTransferError(409, "stopping");
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
    const stop = new AbortController();
    loaded.stop = stop;
    if (loaded.stopRequested) stop.abort();
    const shouldStop = () => this.closed || stop.signal.aborted;
    const checkStop = () => {
      if (stop.signal.aborted) throw new FolderScanError("stopped");
      this.assertOpen();
    };
    try {
      // The working tree listing is reused for a copy started soon after
      // measuring; Git metadata is always listed again by the snapshot.
      const measured =
        loaded.scan && this.now() - loaded.scannedAt <= MEASURE_REUSE_MS ? loaded.scan : null;
      const listing = () => ({
        shouldStop,
        onProgress: this.progressReporter(loaded, stop, "listing"),
      });
      let scan = measured ?? (await scanFolder(loaded.record.folder, listing()));
      // A prepared scan carries an earlier Git snapshot. Re-read the live
      // index/refs before making the actual manifest.
      if (scan.entries.some((entry) => entry.portableGit))
        scan = await scanFolder(loaded.record.folder, listing());
      if (selection.has("rebuildable")) scan = await expandCollapsed(scan, listing());
      checkStop();
      const sourceFingerprint = inventoryFingerprint(scan);
      const scanCompletedAt = this.now();
      scan = await preparePortableGit(scan, this.snapshotRoot(loaded), {
        shouldStop,
        onProgress: this.progressReporter(loaded, stop, "git-snapshot"),
      });
      checkStop();
      const entries = selectEntries(scan.entries, selection);
      const listed = new Map(
        entries.map(({ path, size, mtimeMs, sha256, chunks }) => [
          path,
          { size, mtimeMs, sha256, chunks },
        ]),
      );
      const toHash = entries.filter((entry) => entry.type === "file");
      const hashing = this.progressReporter(loaded, stop, "hashing", {
        files: toHash.length,
        bytes: toHash.reduce((sum, entry) => sum + entry.size, 0),
      });
      hashing({ files: 0, bytes: 0 });
      // A moving copy keeps the last read of a file that never settles; its drift check lists it.
      const moving = loaded.record.mode === "copy-and-move";
      const capture = await captureSourceFiles({
        root: this.capturedRoot(loaded),
        entries,
        stop: checkStop,
        sourceRoot: (entry) =>
          sourceEntryRoot(loaded.record.folder, this.snapshotRoot(loaded), entry),
        progress: hashing,
        onChanging: moving ? "keep-last" : "fail",
        ...(this.hooks.stampClock ? { now: this.hooks.stampClock } : {}),
        ...(this.hooks.verifyCaptureFilesystem
          ? {
              verifyFilesystem: (root: string) =>
                this.hooks.verifyCaptureFilesystem!(root, loaded.record.mode),
            }
          : {}),
      }).catch(async (cause: unknown) => {
        // Network and unverified volumes, and a source without room to capture, keep
        // the live checks a moving copy always had.
        if (!moving || !(cause instanceof CaptureFilesystemRefused)) throw cause;
        await removeSourceBackings([this.capturedRoot(loaded)]);
        for (const entry of entries) Object.assign(entry, listed.get(entry.path));
        return null;
      });
      if (capture)
        for (const entry of entries)
          scan.totals[entry.class].bytes += entry.size - listed.get(entry.path)!.size;
      if (!capture)
        await hashSelected(scan, selection, hashing, (entry) =>
          sourceEntryRoot(loaded.record.folder, this.snapshotRoot(loaded), entry),
        );
      checkStop();
      const header: ManifestHeader = {
        ...(capture ? { capturedAt: this.now() } : {}),
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
      checkStop();
      await writeManifest(this.manifestFile(loaded.record.operationId), { header, entries });
      // Kept outside the wire manifest; only the later drift check reads it.
      if (moving)
        await writeJson(driftBasisFile(this.directory(loaded.record.operationId)), {
          capturedAt: header.capturedAt ?? this.now(),
          stats: Object.fromEntries(
            entries.flatMap((entry) =>
              !entry.portableGit && capture?.stats[entry.path]
                ? [[entry.path, capture.stats[entry.path]]]
                : [],
            ),
          ),
          changing: capture?.changing ?? [],
          indexes: await indexDigests(this.snapshotRoot(loaded), scan.repositories),
          refs: await refDigests(this.snapshotRoot(loaded), scan.repositories),
          uncopyable: uncopyableCounts(scan.warnings),
        });
      loaded.scan = scan;
      this.index(loaded, header, entries);
      const manifestHandle = await NodeFSP.open(
        this.manifestFile(loaded.record.operationId),
        NodeFS.constants.O_RDWR | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      const capturedSource: CapturedSource | undefined = capture
        ? {
            version: capture.version,
            packHash: capture.packHash,
            indexHash: capture.indexHash,
            capturedAt: header.capturedAt!,
            manifestHash: sha256Hex(
              await NodeFSP.readFile(this.manifestFile(loaded.record.operationId)),
            ),
          }
        : undefined;
      if (capturedSource)
        loaded.capturedIndex = await loadCapturedIndex(this.capturedRoot(loaded), capturedSource);
      await this.save(loaded, {
        state: "ready",
        ...(capturedSource ? { capturedSource } : {}),
        sourceFingerprint,
        scanCompletedAt,
        summary: summarize(scan, loaded.record.warnings),
      });
      if (capturedSource) await syncCapturedDirectory(this.directory(loaded.record.operationId));
    } catch (cause) {
      await this.clearSnapshot(loaded);
      // Stopped by shutdown: the record keeps its state, so a restart can scan again.
      // Stopped by a cancel or release: that transition records the end state.
      if (!this.stoppedOnPurpose(cause, stop))
        await this.save(loaded, { state: "failed", error: errorText(cause) });
    } finally {
      if (loaded.stop === stop) loaded.stop = null;
      loaded.building = null;
    }
  }

  private manifestFile(operationId: string) {
    return NodePath.join(this.directory(operationId), "manifest.ndjson.gz");
  }

  private capturedRoot(loaded: Loaded) {
    return NodePath.join(this.directory(loaded.record.operationId), "captured-files");
  }

  /** Validate the reviewed artifact, separately from whether the live source still matches. */
  async validateReviewed(operationId: string): Promise<{ current?: boolean; captured?: boolean }> {
    const loaded = await this.load(operationId);
    if (loaded?.building && loaded.record.state === "ready") await loaded.building;
    if (loaded?.record.capturedSource) {
      this.assertOpen();
      return this.snapshotRead(loaded, async () => {
        if (loaded.record.state !== "ready")
          throw new SourceTransferError(409, loaded.record.state);
        try {
          await this.ready(loaded);
          await validateCapturedSource(
            this.capturedRoot(loaded),
            loaded.record.capturedSource!,
            await NodeFSP.readFile(this.manifestFile(operationId)),
          );
          return { current: true, captured: true };
        } catch {
          throw new SourceTransferError(
            409,
            "snapshot_unavailable",
            "The captured copy files are missing or changed. Measure and compare again.",
          );
        }
      });
    }
    if (loaded?.record.state === "ready") await this.ready(loaded);
    const checked = await this.checkScan(operationId);
    return { current: checked?.freshness?.current === true };
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
    if (loaded.building && loaded.record.state === "ready") await loaded.building;
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
      await removeSourceBackings([this.snapshotRoot(loaded), this.capturedRoot(loaded)]);
      loaded.capturedIndex = null;
      loaded.scan = null;
      if (loaded.record.snapshotCleanupPending)
        await this.save(loaded, {
          snapshotCleanupPending: false,
          snapshotCleanupCodes: [],
          warnings: (loaded.record.warnings ?? []).filter((item) => item !== warning),
        });
    } catch (cause) {
      // The files were already applied and the grant ended. Housekeeping must
      // not turn that acknowledgment into a failure that cannot be retried.
      await this.save(loaded, {
        snapshotCleanupPending: true,
        snapshotCleanupCodes: sourceCleanupCodes(cause),
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
      const place = {
        path: entry.path,
        offset: index * CHUNK_SIZE,
        length: Math.min(CHUNK_SIZE, entry.size - index * CHUNK_SIZE),
      };
      const known = loaded.chunks!.get(sha);
      if (!known) loaded.chunks!.set(sha, place);
      else if (
        known.path !== place.path &&
        (known.also?.length ?? 0) < MAX_CHUNK_ALTERNATES &&
        !known.also?.some((other) => other.path === place.path)
      )
        (known.also ??= []).push(place);
    });
  }

  private async ready(loaded: Loaded): Promise<void> {
    if (loaded.record.capturedSource) {
      if (loaded.building) await loaded.building;
      this.assertOpen();
    }
    if (loaded.record.state !== "ready" && loaded.record.state !== "committed")
      throw new SourceTransferError(409, loaded.record.state);
    if (loaded.record.capturedSource && !loaded.capturedIndex)
      loaded.capturedIndex = await loadCapturedIndex(
        this.capturedRoot(loaded),
        loaded.record.capturedSource,
      );
    if (!loaded.entries) {
      const manifest = await readManifestFile(this.manifestFile(loaded.record.operationId));
      this.index(loaded, manifest.header, manifest.entries);
    }
    for (const entry of loaded.entries!.values())
      if (
        entry.class !== "tracked" &&
        entry.class !== "repository" &&
        isSecretLikeProjectPath(entry.path)
      )
        throw new SourceTransferError(
          409,
          "secret_reapproval_required",
          "This saved comparison includes a newly protected secret-like file. Measure and compare again, then approve secrets separately.",
        );
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
        let found: Buffer | null = null;
        // A file that changed since hashing may share the chunk with one that did not.
        for (const place of [location, ...(location.also ?? [])]) {
          const data = await this.readPlace(loaded, place).catch(() => null);
          if (data && sha256Hex(data) === sha256) {
            found = data;
            break;
          }
        }
        frames.push(
          found
            ? { sha256, status: CHUNK_OK, data: found }
            : { sha256, status: CHUNK_CHANGED, data: Buffer.alloc(0) },
        );
      }
      return frames;
    });
  }

  private async readPlace(loaded: Loaded, place: ChunkPlace): Promise<Buffer> {
    if (loaded.record.capturedSource) {
      if (!loaded.capturedIndex) throw new SourceTransferError(409, "snapshot_unavailable");
      return capturedRange(
        this.capturedRoot(loaded),
        loaded.capturedIndex,
        place.path,
        place.offset,
        place.length,
      );
    }
    const handle = await openInside(this.entryRoot(loaded, place.path), place.path);
    try {
      const data = Buffer.alloc(place.length);
      const { bytesRead } = await handle.read(data, 0, place.length, place.offset);
      return data.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
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
        if (loaded.record.capturedSource) {
          const entry = loaded.entries!.get(path)!;
          result.push({
            path,
            type: entry.type,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            ...(entry.target !== undefined ? { target: entry.target } : {}),
          });
          continue;
        }
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
          ...(stat.isSymbolicLink()
            ? { target: linkTargetOnWire(await NodeFSP.readlink(absolute)) }
            : {}),
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
      if (loaded.record.capturedSource) {
        await this.validateReviewed(loaded.record.operationId);
        return paths.flatMap((path) => {
          const entry = loaded.entries!.get(path);
          return entry ? [entry] : [];
        });
      }
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
            target: linkTargetOnWire(await NodeFSP.readlink(absolute)),
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

  /** What differs from the committed copy now; the durable copied manifest is the reference. */
  async driftSince(operationId: string): Promise<SourceDrift> {
    const loaded = await this.load(operationId);
    if (!loaded || loaded.record.state !== "committed")
      throw new SourceTransferError(409, "not_committed");
    const directory = this.directory(operationId);
    return computeDrift({
      folder: loaded.record.folder,
      directory,
      manifestFile: this.manifestFile(operationId),
      basisFile: driftBasisFile(directory),
      servedSecretsFile: servedSecretsFile(directory),
      now: () => this.now(),
    });
  }

  /** A change list this source produced for the operation; null for any other digest. */
  driftReport(operationId: string, digest: string) {
    return readDriftReport(this.directory(operationId), digest);
  }

  /**
   * Records the reviewed list a move went ahead with, and what stays only here. Null
   * means the move found nothing different: a list an earlier attempt saved is cleared.
   */
  async recordDriftDecision(
    operationId: string,
    decision: {
      readonly accepted: { readonly digest: string; readonly total: number };
      readonly leftOnSource: { readonly digest: string; readonly total: number };
    } | null,
  ): Promise<SourceOperationRecord> {
    const loaded = await this.load(operationId);
    if (!loaded) throw new SourceTransferError(404, "not_found");
    // Queued with commit, release and abandon, so a decision never lands on an ended copy.
    return this.transition(loaded, async () => {
      if (loaded.record.state !== "committed")
        throw new SourceTransferError(409, loaded.record.state);
      if (!decision && !loaded.record.acceptedDrift && !loaded.record.leftOnSource)
        return loaded.record;
      if (!decision) {
        const { acceptedDrift: _accepted, leftOnSource: _left, ...rest } = loaded.record;
        loaded.record = rest;
        await this.save(loaded, {}, true);
        return loaded.record;
      }
      const at = this.now();
      await this.save(loaded, {
        acceptedDrift: { ...decision.accepted, acceptedAt: at },
        leftOnSource: { ...decision.leftOnSource, recordedAt: at },
      });
      return loaded.record;
    });
  }

  /** A later context transfer must never run against an older copied tree. */
  async assertCurrentSnapshot(operationId: string): Promise<void> {
    if ((await this.driftSince(operationId)).total > 0)
      throw new SourceTransferError(409, "source_changed");
  }

  /** Whether each commit exists here and is an ancestor of (or equal to) the repository's HEAD. */
  async ancestry(loaded: Loaded, repository: string, commits: ReadonlyArray<string>) {
    await this.ready(loaded);
    if (!loaded.header!.repositories.some((repo) => repo.path === repository))
      throw new SourceTransferError(404, "unknown_repository");
    const ancestryRoot = loaded.record.capturedSource
      ? this.snapshotRoot(loaded)
      : loaded.record.folder;
    const cwd = repository === "." ? ancestryRoot : NodePath.join(ancestryRoot, repository);
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
      const offered = await this.withLiveSecretFiles(
        loaded.record.folder,
        loaded.record.summary.secretFiles,
        input.paths,
      );
      files = selectSecretFiles(offered, input.paths);
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

  /**
   * The measured secret files plus any ticked path the summary lacks that is still
   * a secret-like regular file in the folder. The dialog can list a file from a later
   * scan (a refreshed check, a build that listed the folder again) than the one this
   * record kept; refusing it would fail the whole copy for a file the person may send.
   */
  private async withLiveSecretFiles(
    folder: string,
    offered: ReadonlyArray<{ readonly path: string; readonly size: number }>,
    paths: ReadonlyArray<string>,
  ): Promise<Array<{ path: string; size: number }>> {
    const known = new Set(offered.map((file) => file.path));
    const result = [...offered];
    for (const path of new Set(paths)) {
      if (known.has(path) || !isSafeRelativePath(path)) continue;
      if (!isSecretLikeProjectPath(path) && !isUntrackedSecretConfigPath(path)) continue;
      if (path.split("/").includes(".git")) continue;
      let handle: NodeFSP.FileHandle | null = null;
      try {
        handle = await openInside(folder, path);
        const stat = await handle.stat();
        if (stat.isFile()) result.push({ path, size: stat.size });
      } catch {
        // Gone, a link, or behind a link: it stays refused below.
      } finally {
        await handle?.close();
      }
    }
    return result;
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
    // The drift check compares the live secret with these bytes before a move.
    await recordServedSecret(servedSecretsFile(this.directory(loaded.record.operationId)), {
      path,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
    });
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
    return this.stopping(loaded, async () => {
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
    return this.stopping(loaded, async () => {
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
