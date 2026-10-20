// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - plain async destination worker with private 0600 records.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { FOLDER_COPY_ALL_CONFLICTS_PREFIX } from "@specweave-studio/contracts";
import { applyPlan, ApplyRefusedError, bytesNeeded, type RepositoryCheck } from "./apply.ts";
import { DEFAULT_SELECTION, FILE_CLASSES, type FileClass } from "./classify.ts";
import { repositoryRelations, scanDestination } from "./destinationScan.ts";
import { deviceOf, exists, freeBytes, privateDirectory, readJson, writeJson } from "./durable.ts";
import { readManifestFile, writeManifest, type Manifest } from "./manifest.ts";
import { finalPass, pullFiles, type PullProgress } from "./pullWorker.ts";
import { planReady, planReconcile, pullRequirements, type Choice, type Plan } from "./reconcile.ts";
import { SourceClient, SourceClientError } from "./sourceClient.ts";
import { previewUndo, undoApply, type UndoPreview, type UndoResult } from "./undo.ts";

export type CopyState =
  | "planned"
  | "scanning"
  | "previewed"
  | "approved"
  | "transferring"
  | "verifying"
  | "applying"
  | "applied"
  | "undone"
  | "failed"
  | "cancelled";

export type CopyErrorCode =
  | "unreachable"
  | "outdated_source"
  | "unauthorized"
  | "wrong_machine"
  | "refused"
  | "disk_space"
  | "not_a_folder"
  | "apply_refused"
  | "copy_failed"
  | "cancelled";

export class CopyError extends Error {
  readonly code: CopyErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: CopyErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export interface CopyProgress {
  readonly phase: "manifest" | "files" | "verify" | "apply";
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  readonly bytesLocal: number;
}

export interface DestinationRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly sourceUrl: string;
  readonly token: string;
  readonly sourceEnvironmentId: string;
  readonly sourceProjectId: string;
  readonly sourceMachine: string;
  readonly mode: "copy-only" | "copy-and-move";
  readonly targetFolder: string;
  readonly title: string;
  readonly selection: ReadonlyArray<FileClass>;
  readonly decisions: Readonly<Record<string, Choice>>;
  readonly clone: ReadonlyArray<string>;
  readonly mirror: boolean;
  readonly state: CopyState;
  readonly failedStep: CopyState | null;
  readonly error: { readonly code: CopyErrorCode; readonly message: string } | null;
  readonly progress: CopyProgress | null;
  readonly disk: { readonly needed: number; readonly free: number } | null;
  readonly checks: ReadonlyArray<RepositoryCheck>;
  readonly warnings: ReadonlyArray<string>;
  /** Files the source kept changing during the copy; left out of Apply and listed. */
  readonly unstable: ReadonlyArray<string>;
  /** The source accepted the end of the transfer. */
  readonly committed: boolean;
  /** The project registered for the copied folder on this machine. */
  readonly projectId: string | null;
  /** The id a moving coordinator expects the copied folder to register under. */
  readonly requestedProjectId: string | null;
  /** When the Apply backups were discarded; Undo is no longer possible after it. */
  readonly backupsDiscardedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StartCopyInput {
  readonly operationId: string;
  readonly sourceUrl: string;
  readonly token: string;
  readonly sourceEnvironmentId: string;
  readonly sourceProjectId: string;
  readonly sourceMachine: string;
  readonly mode: "copy-only" | "copy-and-move";
  readonly targetFolder: string;
  readonly title: string;
  readonly selection?: ReadonlyArray<FileClass>;
  readonly projectId?: string;
}

export interface DestinationHooks {
  /** Registers the applied folder as a project here; returns its id. */
  readonly register?: (record: DestinationRecord) => Promise<string>;
  readonly allowLoopback?: boolean;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly pollMs?: number;
  /** Free bytes at a location; replaced in tests. */
  readonly freeBytes?: (location: string) => Promise<number>;
  /** How long Apply backups stay for Undo; 14 days by default. */
  readonly backupRetentionMs?: number;
}

export const BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEFORE_APPLY: ReadonlySet<CopyState> = new Set([
  "planned",
  "scanning",
  "previewed",
  "approved",
  "transferring",
  "verifying",
]);

/**
 * Destination half of a folder copy. Each operation is a private folder under
 * `<stateRoot>/folder-copies/<op>` holding the record, the manifest, the plan,
 * staging, backups and the Apply journal. Nothing touches the target folder
 * until Apply, and a failure before Apply releases the source with a reason.
 */
export class DestinationCopies {
  private readonly root: string;
  private readonly hooks: DestinationHooks;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(stateRoot: string, hooks: DestinationHooks = {}) {
    this.root = NodePath.join(stateRoot, "folder-copies");
    this.hooks = hooks;
  }

  private now() {
    return (this.hooks.now?.() ?? new Date()).toISOString();
  }

  private directory(operationId: string) {
    if (!OPERATION_ID.test(operationId)) throw new CopyError("refused", "Unknown copy.");
    return NodePath.join(this.root, operationId);
  }

  private paths(operationId: string) {
    const directory = this.directory(operationId);
    return {
      directory,
      record: NodePath.join(directory, "operation.json"),
      manifest: NodePath.join(directory, "manifest.ndjson.gz"),
      plan: NodePath.join(directory, "plan.json"),
      staging: NodePath.join(directory, "staging"),
      backups: NodePath.join(directory, "backups"),
      journal: NodePath.join(directory, "journal.ndjson"),
    };
  }

  /** Serializes record updates per operation. */
  private async locked<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(operationId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(
      operationId,
      next.catch(() => undefined),
    );
    return next;
  }

  async read(operationId: string): Promise<DestinationRecord | null> {
    const file = this.paths(operationId).record;
    if (!(await exists(file))) return null;
    return readJson<DestinationRecord>(file);
  }

  async readPlan(operationId: string): Promise<Plan | null> {
    const file = this.paths(operationId).plan;
    if (!(await exists(file))) return null;
    return readJson<Plan>(file);
  }

  async list(): Promise<ReadonlyArray<DestinationRecord>> {
    let names: Array<string>;
    try {
      names = await NodeFSP.readdir(this.root);
    } catch {
      return [];
    }
    const records: Array<DestinationRecord> = [];
    for (const name of names) {
      if (!OPERATION_ID.test(name)) continue;
      const record = await this.read(name).catch(() => null);
      if (record) records.push(record);
    }
    return records;
  }

  private async update(
    operationId: string,
    patch: Partial<DestinationRecord>,
  ): Promise<DestinationRecord> {
    return this.locked(operationId, async () => {
      const current = await this.read(operationId);
      if (!current) throw new CopyError("refused", "Unknown copy.");
      const next = { ...current, ...patch, updatedAt: this.now() } as DestinationRecord;
      await writeJson(this.paths(operationId).record, next);
      return next;
    });
  }

  private client(record: DestinationRecord, signal?: AbortSignal) {
    return new SourceClient({
      baseUrl: record.sourceUrl,
      operationId: record.operationId,
      token: record.token,
      ...(this.hooks.allowLoopback ? { allowLoopback: true } : {}),
      ...(this.hooks.fetch ? { fetch: this.hooks.fetch } : {}),
      ...(this.hooks.sleep ? { sleep: this.hooks.sleep } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Records the copy and starts the preview: manifest from the source, then the plan. */
  async start(input: StartCopyInput): Promise<DestinationRecord> {
    if (!NodePath.isAbsolute(input.targetFolder))
      throw new CopyError("not_a_folder", "Choose an absolute folder for the copy.");
    const target = NodePath.resolve(input.targetFolder);
    const selection = [...new Set(input.selection ?? DEFAULT_SELECTION)];
    if (selection.some((value) => !FILE_CLASSES.includes(value) || value === "secret"))
      throw new CopyError("refused", "Secret-like files are not copied in this step.");
    const existing = await this.read(input.operationId);
    if (existing) {
      if (existing.sourceUrl !== input.sourceUrl || existing.targetFolder !== target)
        throw new CopyError("refused", "This copy already exists with different details.");
      return existing;
    }
    const stat = await NodeFSP.lstat(target).catch(() => null);
    if (stat && !stat.isDirectory())
      throw new CopyError("not_a_folder", `${target} exists and is not a folder.`);
    await privateDirectory(this.root);
    const paths = this.paths(input.operationId);
    await privateDirectory(paths.directory);
    const now = this.now();
    const record: DestinationRecord = {
      version: 1,
      operationId: input.operationId,
      sourceUrl: input.sourceUrl,
      token: input.token,
      sourceEnvironmentId: input.sourceEnvironmentId,
      sourceProjectId: input.sourceProjectId,
      sourceMachine: input.sourceMachine,
      mode: input.mode,
      targetFolder: target,
      title: input.title,
      selection,
      decisions: {},
      clone: [],
      mirror: false,
      state: "planned",
      failedStep: null,
      error: null,
      progress: null,
      disk: null,
      checks: [],
      warnings: [],
      unstable: [],
      committed: false,
      projectId: null,
      requestedProjectId: input.projectId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(paths.record, record);
    // Check the source answers before going to the background.
    try {
      await this.client(record).hello(input.sourceEnvironmentId);
    } catch (cause) {
      await NodeFSP.rm(paths.directory, { recursive: true, force: true });
      throw toCopyError(cause);
    }
    this.background(input.operationId, "scanning", (signal) => this.preview(record, signal));
    return record;
  }

  /** Changes decisions, clone rows or "mirror exactly", then re-plans. */
  async decide(
    operationId: string,
    input: {
      readonly decisions?: Readonly<Record<string, Choice>>;
      readonly clone?: ReadonlyArray<string>;
      readonly mirror?: boolean;
    },
  ): Promise<DestinationRecord> {
    const record = await this.require(operationId);
    if (record.state !== "previewed")
      throw new CopyError("refused", "Decisions can change only on the preview.");
    const decisions: Record<string, Choice> = {};
    const plan = await this.readPlan(operationId);
    for (const [id, choice] of Object.entries(input.decisions ?? {})) {
      if (!id.startsWith(FOLDER_COPY_ALL_CONFLICTS_PREFIX)) {
        decisions[id] = choice;
        continue;
      }
      // One answer for every file conflict in a row, including those the preview does not list.
      const row = plan?.rows.find(
        (entry) => entry.id === id.slice(FOLDER_COPY_ALL_CONFLICTS_PREFIX.length),
      );
      for (const conflict of row?.conflicts ?? [])
        if (conflict.choices.includes(choice)) decisions[conflict.id] = choice;
    }
    const next = await this.update(operationId, {
      decisions: { ...record.decisions, ...decisions },
      ...(input.clone ? { clone: [...input.clone] } : {}),
      ...(input.mirror !== undefined ? { mirror: input.mirror } : {}),
      state: "scanning",
    });
    this.background(operationId, "scanning", (signal) => this.replan(next, signal));
    return next;
  }

  /**
   * Starts the transfer after a ready preview. Disk space is checked first and
   * the copy is refused early with the size it needs.
   */
  async approve(operationId: string): Promise<DestinationRecord> {
    const record = await this.require(operationId);
    if (record.state !== "previewed")
      throw new CopyError("refused", "Review the copy before approving it.");
    const plan = await this.readPlan(operationId);
    if (!plan || !planReady(plan))
      throw new CopyError("refused", "Some rows still need a decision.");
    const paths = this.paths(operationId);
    const sameVolume = (await deviceOf(paths.staging)) === (await deviceOf(record.targetFolder));
    const needed = bytesNeeded(plan, sameVolume);
    const free = await (this.hooks.freeBytes ?? freeBytes)(record.targetFolder);
    if (needed > free) {
      await this.update(operationId, { disk: { needed, free } });
      throw new CopyError(
        "disk_space",
        `The copy needs ${formatBytes(needed)} free here and ${formatBytes(free)} is available.`,
        { needed, free },
      );
    }
    const next = await this.update(operationId, {
      state: "approved",
      disk: { needed, free },
      error: null,
    });
    this.background(operationId, "transferring", (signal) => this.transfer(next, signal));
    return next;
  }

  /** Stops a copy before Apply and releases the source. Apply itself cannot be cancelled. */
  async cancel(operationId: string, reason: string): Promise<DestinationRecord> {
    const record = await this.require(operationId);
    if (record.state === "applying")
      throw new CopyError("refused", "Apply is running; wait for it, then undo.");
    if (!BEFORE_APPLY.has(record.state) && record.state !== "failed") return record;
    const running = this.running.get(operationId);
    running?.abort.abort();
    await running?.done.catch(() => undefined);
    const after = await this.require(operationId);
    if (after.state === "failed" && after.failedStep === "applying")
      throw new CopyError("refused", "Apply started; undo the copy instead.");
    await this.client(after)
      .release(reason)
      .catch(() => undefined);
    await NodeFSP.rm(this.paths(operationId).staging, { recursive: true, force: true });
    return this.update(operationId, { state: "cancelled", progress: null });
  }

  /** Retries a copy that stopped during Apply; the journal skips finished steps. */
  async retry(operationId: string): Promise<DestinationRecord> {
    const record = await this.require(operationId);
    if (record.state === "failed" && record.failedStep === "applied") {
      // Files are in place; only the source commit or the registration failed.
      const applied = await this.update(operationId, { state: "applied", error: null });
      this.background(operationId, "applied", () => this.finish(applied));
      return applied;
    }
    if (record.state !== "failed" || record.failedStep !== "applying")
      throw new CopyError("refused", "Only an interrupted Apply can be retried.");
    const next = await this.update(operationId, { state: "applying", error: null });
    this.background(operationId, "applying", (signal) => this.apply(next, signal));
    return next;
  }

  async undoPreview(operationId: string): Promise<UndoPreview> {
    const record = await this.require(operationId);
    if (!canUndo(record)) throw new CopyError("refused", "There is nothing to undo.");
    return previewUndo({
      targetRoot: record.targetFolder,
      journalFile: this.paths(operationId).journal,
    });
  }

  /**
   * Undo restores the backups. Files edited after Apply are kept unless `force`;
   * with `force` they move to the backup folder rather than being deleted.
   */
  async undo(
    operationId: string,
    force: boolean,
  ): Promise<{
    readonly record: DestinationRecord;
    readonly result: UndoResult | null;
    readonly preview: UndoPreview;
  }> {
    const record = await this.require(operationId);
    if (!canUndo(record)) throw new CopyError("refused", "There is nothing to undo.");
    const paths = this.paths(operationId);
    const preview = await previewUndo({
      targetRoot: record.targetFolder,
      journalFile: paths.journal,
    });
    if (preview.edited > 0 && !force) return { record, result: null, preview };
    const result = await undoApply({
      targetRoot: record.targetFolder,
      backupRoot: paths.backups,
      journalFile: paths.journal,
      force,
    });
    const next = await this.update(operationId, { state: "undone" });
    return { record: next, result, preview };
  }

  /**
   * Discards Apply backups once the retention passes. The copied files stay;
   * only Undo stops being possible.
   */
  async discardExpiredBackups(): Promise<ReadonlyArray<string>> {
    const retention = this.hooks.backupRetentionMs ?? BACKUP_RETENTION_MS;
    const now = this.hooks.now?.() ?? new Date();
    const discarded: Array<string> = [];
    for (const record of await this.list()) {
      if (record.backupsDiscardedAt !== undefined || this.running.has(record.operationId)) continue;
      if (record.state !== "applied" && record.state !== "undone" && record.state !== "failed")
        continue;
      if (now.getTime() - Date.parse(record.updatedAt) < retention) continue;
      await NodeFSP.rm(this.paths(record.operationId).backups, { recursive: true, force: true });
      await this.update(record.operationId, { backupsDiscardedAt: now.toISOString() });
      discarded.push(record.operationId);
    }
    return discarded;
  }

  /** Continues every copy the last run left mid-way. */
  async resume(): Promise<void> {
    await this.discardExpiredBackups().catch(() => undefined);
    for (const record of await this.list()) {
      const op = record.operationId;
      switch (record.state) {
        case "planned":
        case "scanning":
          this.background(op, "scanning", (signal) =>
            record.state === "planned" ? this.preview(record, signal) : this.replan(record, signal),
          );
          break;
        case "approved":
        case "transferring":
        case "verifying":
          this.background(op, "transferring", (signal) => this.transfer(record, signal));
          break;
        case "applying":
          this.background(op, "applying", (signal) => this.apply(record, signal));
          break;
        case "applied":
          if (!record.committed || record.projectId === null)
            this.background(op, "applied", () => this.finish(record));
          break;
        default:
          break;
      }
    }
  }

  async waitFor(operationId: string): Promise<void> {
    await this.running.get(operationId)?.done.catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const running of this.running.values()) running.abort.abort();
    await Promise.all(
      [...this.running.values()].map((running) => running.done.catch(() => undefined)),
    );
  }

  private async require(operationId: string) {
    const record = await this.read(operationId);
    if (!record) throw new CopyError("refused", "Unknown copy.");
    return record;
  }

  private background(
    operationId: string,
    step: CopyState,
    task: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.running.has(operationId)) return;
    const abort = new AbortController();
    const done = (async () => {
      try {
        await task(abort.signal);
      } catch (cause) {
        await this.fail(operationId, step, cause, abort.signal.aborted);
      } finally {
        this.running.delete(operationId);
      }
    })();
    this.running.set(operationId, { abort, done });
  }

  private async fail(operationId: string, fallback: CopyState, cause: unknown, aborted: boolean) {
    const record = await this.read(operationId);
    if (!record || record.state === "cancelled") return;
    const step = record.state === "failed" ? (record.failedStep ?? fallback) : record.state;
    const error = aborted
      ? new CopyError("cancelled", "The copy was stopped.")
      : toCopyError(cause);
    if (aborted && BEFORE_APPLY.has(step)) return;
    await this.update(operationId, {
      state: "failed",
      failedStep: step,
      error: { code: error.code, message: error.message },
    });
    if (BEFORE_APPLY.has(step)) {
      // The target folder is untouched; give the source back.
      await this.client(record)
        .release(`The copy failed on this machine: ${error.message}`.slice(0, 480))
        .catch(() => undefined);
      await NodeFSP.rm(this.paths(operationId).staging, { recursive: true, force: true });
    }
  }

  private async fetchManifest(record: DestinationRecord, signal: AbortSignal) {
    const client = this.client(record, signal);
    const paths = this.paths(record.operationId);
    if (await exists(paths.manifest)) return readManifestFile(paths.manifest);
    await client.requestManifest(record.selection);
    for (;;) {
      signal.throwIfAborted();
      const result = await client.manifest();
      if ("entries" in result) {
        await writeManifest(paths.manifest, result);
        return result;
      }
      if (result.progress)
        await this.update(record.operationId, {
          progress: {
            phase: "manifest",
            filesDone: result.progress.files,
            filesTotal: 0,
            bytesDone: result.progress.bytes,
            bytesTotal: 0,
            bytesLocal: 0,
          },
        });
      await (this.hooks.sleep ?? delay)(this.hooks.pollMs ?? 1_000);
    }
  }

  private async preview(record: DestinationRecord, signal: AbortSignal) {
    await this.update(record.operationId, { state: "scanning" });
    await this.fetchManifest(record, signal);
    await this.replan(record, signal);
  }

  private async replan(record: DestinationRecord, signal: AbortSignal) {
    const current = await this.require(record.operationId);
    const manifest = await this.fetchManifest(current, signal);
    const plan = await this.plan(current, manifest, signal);
    await writeJson(this.paths(record.operationId).plan, plan);
    await this.update(record.operationId, {
      state: "previewed",
      progress: null,
      warnings: [...manifest.header.warnings, ...plan.warnings].slice(0, 200),
    });
  }

  private async plan(
    record: DestinationRecord,
    manifest: Manifest,
    signal: AbortSignal,
  ): Promise<Plan> {
    const client = this.client(record, signal);
    const destination = await scanDestination(record.targetFolder, manifest.entries);
    const relations = await repositoryRelations(
      record.targetFolder,
      manifest.header.repositories,
      destination.repositories,
      (repo, commits) => client.ancestry(repo, commits),
    );
    return planReconcile({
      sourceMachine: record.sourceMachine,
      repositories: manifest.header.repositories,
      entries: manifest.entries,
      targetRoot: record.targetFolder,
      destination,
      relations,
      caseInsensitive: destination.caseInsensitive,
      decisions: record.decisions,
      clone: record.clone,
      mirror: record.mirror,
    });
  }

  private async transfer(record: DestinationRecord, signal: AbortSignal) {
    const op = record.operationId;
    const paths = this.paths(op);
    const plan = await this.readPlan(op);
    if (!plan) throw new CopyError("copy_failed", "The copy plan is missing.");
    await this.update(op, { state: "transferring" });
    await privateDirectory(paths.staging);
    const client = this.client(record, signal);
    const needs = pullRequirements(plan);
    let last = 0;
    const onProgress = (progress: PullProgress) => {
      const now = Date.now();
      if (now - last < 1_000 && progress.filesDone < progress.filesTotal) return;
      last = now;
      void this.update(op, { progress: { phase: "files", ...progress } }).catch(() => undefined);
    };
    const pulled = await pullFiles({
      client,
      stagingRoot: paths.staging,
      files: needs.files,
      directories: needs.directories,
      signal,
      onProgress,
    });
    await this.update(op, { state: "verifying" });
    const final = await finalPass({
      client,
      stagingRoot: paths.staging,
      files: needs.files,
      links: plan.actions
        .filter((action) => action.entry?.type === "symlink" && action.entry.target !== undefined)
        .map((action) => ({ path: action.path, target: action.entry!.target! })),
      signal,
    });
    // Refreshed files carry new hashes; Apply checks replayed writes against them.
    const refreshed = new Map([...pulled.refreshed, ...final.refreshed]);
    const updatedPlan: Plan = refreshed.size
      ? {
          ...plan,
          actions: plan.actions.map((action) =>
            action.entry && refreshed.has(action.path)
              ? { ...action, entry: refreshed.get(action.path)! }
              : action,
          ),
        }
      : plan;
    if (refreshed.size) await writeJson(paths.plan, updatedPlan);
    const unstable = [
      ...new Set([...pulled.unstable, ...final.unstable, ...pulled.vanished, ...final.vanished]),
    ];
    const warnings = [...record.warnings];
    if (final.linkChanges.length)
      warnings.push(
        `${final.linkChanges.length} links changed on the source during the copy; they are copied as previewed.`,
      );
    const next = await this.update(op, { state: "applying", unstable, warnings, progress: null });
    await this.apply(next, signal);
  }

  private async apply(record: DestinationRecord, _signal: AbortSignal) {
    const op = record.operationId;
    const paths = this.paths(op);
    const plan = await this.readPlan(op);
    const manifest = await readManifestFile(paths.manifest);
    if (!plan) throw new CopyError("copy_failed", "The copy plan is missing.");
    const unstable = new Set(record.unstable);
    const result = await applyPlan({
      operationId: op,
      targetRoot: record.targetFolder,
      stagingRoot: paths.staging,
      backupRoot: paths.backups,
      journalFile: paths.journal,
      plan,
      sourceRepositories: manifest.header.repositories,
      leftBehind: leftBehind(manifest, unstable),
      unstable,
    });
    const next = await this.update(op, {
      state: "applied",
      checks: result.checks,
      warnings: [...record.warnings, ...result.warnings].slice(0, 200),
      progress: null,
    });
    await NodeFSP.rm(paths.staging, { recursive: true, force: true });
    await this.finish(next);
  }

  /** Tells the source the copy is complete, then registers the folder here. */
  private async finish(record: DestinationRecord) {
    let current = record;
    if (!current.committed) {
      await this.client(current).commit();
      current = await this.update(current.operationId, { committed: true });
    }
    if (current.projectId === null && this.hooks.register) {
      const projectId = await this.hooks.register(current);
      await this.update(current.operationId, { projectId });
    }
  }
}

/**
 * Paths the source shows in `git status` that the copy deliberately skipped
 * (secret-like and unselected files) or left out as unstable.
 */
export function leftBehind(manifest: Manifest, unstable: ReadonlySet<string>): ReadonlySet<string> {
  const present = new Set(manifest.entries.map((entry) => entry.path));
  const result = new Set(unstable);
  for (const repo of manifest.header.repositories) {
    const prefix = repo.path === "." ? "" : `${repo.path}/`;
    for (const line of repo.status) {
      const path = `${prefix}${line.slice(3).replace(/\/$/, "")}`;
      if (line.startsWith(" D") || line.startsWith("D ")) continue;
      if (!present.has(path)) result.add(path);
    }
  }
  return result;
}

function canUndo(record: DestinationRecord) {
  if (record.backupsDiscardedAt !== undefined) return false;
  return (
    record.state === "applied" ||
    (record.state === "failed" &&
      (record.failedStep === "applying" || record.failedStep === "applied"))
  );
}

function toCopyError(cause: unknown): CopyError {
  if (cause instanceof CopyError) return cause;
  if (cause instanceof SourceClientError) {
    const messages: Record<SourceClientError["code"], string> = {
      unsupported_url: "The source address is not a private tailnet address.",
      unreachable: "The source machine stopped answering.",
      outdated_source:
        "The source machine runs an older SpecWithCode without folder copy. Update it first.",
      unauthorized: "The source no longer accepts this copy. Start it again.",
      wrong_machine: "The source address answered for a different machine.",
      refused: cause.message,
    };
    const code = cause.code === "unsupported_url" ? "refused" : cause.code;
    return new CopyError(code, messages[cause.code]);
  }
  if (cause instanceof ApplyRefusedError) return new CopyError("apply_refused", cause.message);
  return new CopyError("copy_failed", cause instanceof Error ? cause.message : String(cause));
}

export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
