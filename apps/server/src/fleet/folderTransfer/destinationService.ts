// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - plain async destination worker with private 0600 records.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FOLDER_COPY_ALL_CONFLICTS_PREFIX } from "@specweave-studio/contracts";
import { applyPlan, ApplyRefusedError, bytesNeeded, type RepositoryCheck } from "./apply.ts";
import { DEFAULT_SELECTION, FILE_CLASSES, type FileClass } from "./classify.ts";
import { repositoryRelations, scanDestination } from "./destinationScan.ts";
import { reachableOrigin } from "./git.ts";
import { deviceOf, exists, freeBytes, privateDirectory, readJson, writeJson } from "./durable.ts";
import { readManifestFile, writeManifest, type Manifest } from "./manifest.ts";
import { finalPass, pullFiles, type PullProgress } from "./pullWorker.ts";
import {
  machineSlug,
  repoRowId,
  planReady,
  planReconcile,
  pullRequirements,
  type Choice,
  type Plan,
} from "./reconcile.ts";
import { validProjectRelativePath } from "../folderCopyScope.ts";
import { isSafeRelativePath } from "./paths.ts";
import { SourceClient, SourceClientError } from "./sourceClient.ts";
import { previewUndo, undoApply, type UndoPreview, type UndoResult } from "./undo.ts";
import { type ReceivedSecret, removeReceivedSecrets, writeSecretFile } from "./secrets.ts";

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
  | "cancelled"
  | "busy";

/**
 * A record-only code: the files were applied, but a copy that moves the
 * coordinator found repository checks failing or files changing on the source,
 * so it neither committed nor moved. Retry moves it anyway; Undo restores.
 */
export type CopyRecordErrorCode = CopyErrorCode | "checks_failed";

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
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
  readonly version: 1;
  readonly operationId: string;
  readonly sourceUrl: string;
  /** The source's SpecWithCode Connect address, used when `sourceUrl` does not answer. */
  readonly sourceConnectUrl?: string;
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
  /** Repository rows left out of the copy; missing on records from before it existed. */
  readonly skip?: ReadonlyArray<string>;
  readonly mirror: boolean;
  readonly state: CopyState;
  readonly failedStep: CopyState | null;
  readonly error: { readonly code: CopyRecordErrorCode; readonly message: string } | null;
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
  /** Secret files received after Apply: paths and sizes, never contents. */
  readonly secrets?: ReadonlyArray<ReceivedSecret>;
  /** Every approved secret file was received (or the source offered none). */
  readonly secretsDone?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StartCopyInput {
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
  readonly operationId: string;
  readonly sourceUrl: string;
  readonly sourceConnectUrl?: string;
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
  /** How often held copies call the source to keep their grant; hourly by default. */
  readonly keepaliveMs?: number;
  /** The origin address this machine can read, or null; `git ls-remote` by default. */
  readonly reachableOrigin?: (origin: string, signal: AbortSignal) => Promise<string | null>;
}

export const BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A held copy (applied here, not committed) pulls nothing while the person
 * decides, but its source grant ends after a day without use. An hourly call
 * keeps it well inside that limit so Retry can still commit and Undo release.
 */
export const HELD_KEEPALIVE_MS = 60 * 60 * 1000;
/** One keepalive call waits this long; the next tick tries again. */
const KEEPALIVE_CALL_MS = 15_000;

/** Undo moves edited files and undone clones here; the backup expiry never deletes them. */
const UNDO_KEPT_FOLDERS: ReadonlySet<string> = new Set(["kept-edits", "undone-clones"]);

async function discardApplyBackups(backups: string): Promise<void> {
  const names = await NodeFSP.readdir(backups).catch(() => [] as Array<string>);
  for (const name of names) {
    if (UNDO_KEPT_FOLDERS.has(name)) continue;
    await NodeFSP.rm(NodePath.join(backups, name), { recursive: true, force: true });
  }
  if (!names.some((name) => UNDO_KEPT_FOLDERS.has(name)))
    await NodeFSP.rm(backups, { recursive: true, force: true });
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEFORE_APPLY: ReadonlySet<CopyState> = new Set([
  "planned",
  "scanning",
  "previewed",
  "approved",
  "transferring",
  "verifying",
]);
/** States in which no transfer has begun; approving launches it. */
const BEFORE_TRANSFER: ReadonlySet<CopyState> = new Set(["planned", "scanning", "previewed"]);

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
  /** Retry or Undo between its check and its work; the other one is refused meanwhile. */
  private readonly claimed = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private keeping: Promise<unknown> | null = null;
  /** Aborted by `close`, so a keepalive call to a silent source does not hold shutdown. */
  private keepaliveAbort: AbortController | null = null;
  /** Origins checked from this machine: the address that answered, or null. */
  private readonly origins = new Map<string, Promise<string | null>>();

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

  private client(
    record: DestinationRecord,
    signal?: AbortSignal,
    once?: { readonly timeoutMs: number },
  ) {
    return new SourceClient({
      baseUrl: record.sourceUrl,
      ...(record.sourceConnectUrl !== undefined
        ? {
            fallbackBaseUrl: record.sourceConnectUrl,
            expectedEnvironmentId: record.sourceEnvironmentId,
          }
        : {}),
      operationId: record.operationId,
      token: record.token,
      ...(this.hooks.allowLoopback ? { allowLoopback: true } : {}),
      ...(this.hooks.fetch ? { fetch: this.hooks.fetch } : {}),
      ...(this.hooks.sleep ? { sleep: this.hooks.sleep } : {}),
      ...(signal ? { signal } : {}),
      ...(once ? { retry: false, timeoutMs: once.timeoutMs } : {}),
    });
  }

  /** Records the copy and starts the preview: manifest from the source, then the plan. */
  async start(input: StartCopyInput): Promise<DestinationRecord> {
    const { record, created, restart } = await this.locked(input.operationId, () =>
      this.startLocked(input),
    );
    // Preview updates take this same lock; launch only after creation releases it.
    if (created)
      this.background(input.operationId, "scanning", (signal) => this.preview(record, signal));
    else if (restart) await this.restartPreview(input.operationId);
    return record;
  }

  /** Stops a running preview, which holds the revoked token, and runs it again with the record's. */
  private async restartPreview(operationId: string) {
    const running = this.running.get(operationId);
    running?.abort.abort();
    await running?.done.catch(() => undefined);
    const current = await this.read(operationId);
    if (current?.state !== "planned" && current?.state !== "scanning") return;
    this.background(operationId, "scanning", (signal) =>
      current.state === "planned" ? this.preview(current, signal) : this.replan(current, signal),
    );
  }

  /** The lock owns the directory through hello, persistence, and failed-start cleanup. */
  private async startLocked(
    input: StartCopyInput,
  ): Promise<{ record: DestinationRecord; created: boolean; restart?: boolean }> {
    if (!NodePath.isAbsolute(input.targetFolder))
      throw new CopyError("not_a_folder", "Choose an absolute folder for the copy.");
    const target = NodePath.resolve(input.targetFolder);
    const selection = [...new Set(input.selection ?? DEFAULT_SELECTION)];
    if (selection.some((value) => !FILE_CLASSES.includes(value) || value === "secret"))
      throw new CopyError("refused", "Secret-like files are not copied in this step.");
    const existing = await this.read(input.operationId);
    if (existing) {
      if (
        existing.sourceUrl !== input.sourceUrl ||
        existing.sourceConnectUrl !== input.sourceConnectUrl ||
        existing.targetFolder !== target ||
        existing.sourceEnvironmentId !== input.sourceEnvironmentId ||
        existing.sourceProjectId !== input.sourceProjectId ||
        existing.mode !== input.mode ||
        existing.requestedProjectId !== (input.projectId ?? null) ||
        (input.copyRoot !== undefined && existing.copyRoot !== input.copyRoot) ||
        (existing.projectRelativePath ?? ".") !== (input.projectRelativePath ?? ".")
      )
        throw new CopyError("refused", "This copy already exists with different details.");
      // A re-offer replaces the source's token and revokes the old one. Before the
      // transfer starts, keep the newer token so the preview and the transfer use it.
      if (existing.token !== input.token && BEFORE_TRANSFER.has(existing.state)) {
        const refreshed: DestinationRecord = {
          ...existing,
          token: input.token,
          updatedAt: this.now(),
        };
        await writeJson(this.paths(input.operationId).record, refreshed);
        // A comparison running on the old token would be refused: run it again.
        return { record: refreshed, created: false, restart: existing.state !== "previewed" };
      }
      // A preview that failed (often on the revoked token) starts over with the new one.
      if (
        existing.token !== input.token &&
        existing.state === "failed" &&
        existing.failedStep !== null &&
        BEFORE_TRANSFER.has(existing.failedStep)
      ) {
        const reset: DestinationRecord = {
          ...existing,
          token: input.token,
          state: "planned",
          failedStep: null,
          error: null,
          progress: null,
          updatedAt: this.now(),
        };
        await writeJson(this.paths(input.operationId).record, reset);
        return { record: reset, created: false, restart: true };
      }
      return { record: existing, created: false };
    }
    const stat = await NodeFSP.lstat(target).catch(() => null);
    if (stat && !stat.isDirectory())
      throw new CopyError("not_a_folder", `${target} exists and is not a folder.`);
    await privateDirectory(this.root);
    const paths = this.paths(input.operationId);
    await privateDirectory(paths.directory);
    const now = this.now();
    let record: DestinationRecord = {
      version: 1,
      operationId: input.operationId,
      sourceUrl: input.sourceUrl,
      ...(input.sourceConnectUrl !== undefined ? { sourceConnectUrl: input.sourceConnectUrl } : {}),
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
    // Check the source answers before going to the background.
    try {
      const hello = await this.client(record).hello(input.sourceEnvironmentId);
      const relative = hello.projectRelativePath ?? ".";
      if (
        !validProjectRelativePath(relative) ||
        (input.projectRelativePath ?? ".") !== relative ||
        (input.copyRoot !== undefined && input.copyRoot !== hello.copyRoot) ||
        (hello.projectId !== undefined && hello.projectId !== input.sourceProjectId) ||
        (relative !== "." && (!hello.copyRoot || hello.projectId !== input.sourceProjectId))
      )
        throw new CopyError("refused", "The source copy scope changed. Start a new copy.");
      record = {
        ...record,
        ...(hello.copyRoot ? { copyRoot: hello.copyRoot } : {}),
        projectRelativePath: relative,
      };
      await writeJson(paths.record, record);
    } catch (cause) {
      await NodeFSP.rm(paths.directory, { recursive: true, force: true });
      throw toCopyError(cause);
    }
    return { record, created: true };
  }

  /** Changes decisions, clone rows, skipped rows or "mirror exactly", then re-plans. */
  async decide(
    operationId: string,
    input: {
      readonly decisions?: Readonly<Record<string, Choice>>;
      readonly clone?: ReadonlyArray<string>;
      readonly skip?: ReadonlyArray<string>;
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
      ...(input.skip ? { skip: [...input.skip] } : {}),
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
    // Revalidation is read-only and keeps the resumable job and all existing choices.
    await this.client(record).validateScan();
    const manifest = await readManifestFile(this.paths(operationId).manifest);
    const currentPlan = await this.plan(record, manifest, new AbortController().signal);
    const assertSamePreview = async () => {
      if (
        JSON.stringify(await this.require(operationId)) !== JSON.stringify(record) ||
        JSON.stringify(await this.readPlan(operationId)) !== JSON.stringify(plan)
      )
        throw new CopyError(
          "refused",
          "The copy changed while checking its preview. Review it again.",
        );
    };
    if (JSON.stringify(currentPlan) !== JSON.stringify(plan)) {
      await this.locked(operationId, async () => {
        await assertSamePreview();
        await writeJson(this.paths(operationId).plan, currentPlan);
      });
      throw new CopyError(
        "refused",
        "The destination changed. Review the updated comparison before copying.",
      );
    }
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
    const next = await this.locked(operationId, async () => {
      await assertSamePreview();
      const approved: DestinationRecord = {
        ...record,
        state: "approved",
        disk: { needed, free },
        error: null,
        updatedAt: this.now(),
      };
      await writeJson(this.paths(operationId).record, approved);
      return approved;
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
    if (
      after.state === "failed" &&
      (after.failedStep === "applying" || after.failedStep === "applied")
    )
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
      this.claim(operationId);
      try {
        const applied = await this.update(operationId, { state: "applied", error: null });
        this.background(operationId, "applied", () => this.finish(applied));
        return applied;
      } finally {
        this.claimed.delete(operationId);
      }
    }
    if (record.state !== "failed")
      throw new CopyError("refused", "Only a failed copy can be retried.");
    if (record.failedStep !== "applying")
      // Before Apply the source has let the copy go and nothing changed here: copy again.
      throw new CopyError(
        "refused",
        "Nothing was changed on this machine. Start the copy again from the source.",
      );
    this.claim(operationId);
    try {
      const next = await this.update(operationId, { state: "applying", error: null });
      this.background(operationId, "applying", (signal) => this.apply(next, signal));
      return next;
    } finally {
      this.claimed.delete(operationId);
    }
  }

  /** Refuses while a retry, an Undo or a background step holds the copy. */
  private claim(operationId: string) {
    if (this.running.has(operationId) || this.claimed.has(operationId))
      throw new CopyError("busy", "The copy is still finishing. Wait for it, then try again.");
    this.claimed.add(operationId);
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
    // A Retry still committing could register the folder Undo is about to empty.
    this.claim(operationId);
    try {
      return await this.undoClaimed(operationId, force);
    } finally {
      this.claimed.delete(operationId);
    }
  }

  private async undoClaimed(operationId: string, force: boolean) {
    const record = await this.require(operationId);
    if (!canUndo(record)) throw new CopyError("refused", "There is nothing to undo.");
    // A commit whose every reply was lost: the source finished, this record never heard.
    // Ask before removing anything; a committed copy is finished here, not undone.
    const probe = record.committed ? null : await this.sourceState(record);
    if (probe === "committed") {
      const applied = await this.update(operationId, {
        state: "applied",
        committed: true,
        error: null,
      });
      this.background(operationId, "applied", () => this.finish(applied));
      throw new CopyError("refused", alreadyCommittedMessage(record));
    }
    const paths = this.paths(operationId);
    const preview = await previewUndo({
      targetRoot: record.targetFolder,
      journalFile: paths.journal,
    });
    if (preview.edited > 0 && !force) return { record, result: null, preview };
    const keptSecrets = await removeReceivedSecrets(record.targetFolder, record.secrets ?? []);
    const result = await undoApply({
      targetRoot: record.targetFolder,
      backupRoot: paths.backups,
      journalFile: paths.journal,
      force,
    });
    // An uncommitted copy still holds the source: give it back, so a held coordinator stays there.
    // When the source refuses or cannot be reached, the person must end it there.
    // An unreachable source was already retried by the question above.
    const sourceError = record.committed
      ? null
      : probe instanceof CopyError && probe.code === "unreachable"
        ? probe
        : await this.client(record)
            .release("The copy was undone on the destination.")
            .then(
              () => null,
              (cause: unknown) => toCopyError(cause),
            );
    const next = await this.update(operationId, {
      state: "undone",
      error: sourceError
        ? { code: sourceError.code, message: undoneButHeldMessage(record, sourceError.code) }
        : null,
      ...(keptSecrets.length > 0
        ? {
            warnings: [
              ...record.warnings,
              ...keptSecrets.map((path) => `${path} was edited after the copy and was kept.`),
            ].slice(0, 200),
          }
        : {}),
    });
    return { record: next, result, preview };
  }

  /** The source's state for this copy, or why it could not say. */
  private async sourceState(record: DestinationRecord): Promise<string | CopyError> {
    return this.client(record)
      .hello(record.sourceEnvironmentId)
      .then(
        (hello) => hello.state,
        (cause: unknown) => toCopyError(cause),
      );
  }

  /**
   * Discards Apply backups once the retention passes. The copied files stay;
   * only Undo stops being possible. Files a forced Undo moved aside are kept.
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
      await discardApplyBackups(this.paths(record.operationId).backups);
      await this.update(record.operationId, { backupsDiscardedAt: now.toISOString() });
      discarded.push(record.operationId);
    }
    return discarded;
  }

  /**
   * Calls the source for every held copy, which counts as use of its grant.
   * One short attempt each; the next tick tries again. Returns how many answered.
   */
  async keepHeldGrantsAlive(signal?: AbortSignal): Promise<number> {
    let answered = 0;
    for (const record of await this.list()) {
      if (signal?.aborted) break;
      if (!holdsSource(record)) continue;
      try {
        await this.client(record, signal, { timeoutMs: KEEPALIVE_CALL_MS }).hello(
          record.sourceEnvironmentId,
        );
        answered += 1;
      } catch {
        // An unreachable or refusing source is reported when Retry or Undo runs.
      }
    }
    return answered;
  }

  private startKeepalive() {
    if (this.keepalive !== null) return;
    const abort = new AbortController();
    this.keepaliveAbort = abort;
    const tick = () => {
      if (this.keeping || abort.signal.aborted) return;
      this.keeping = this.keepHeldGrantsAlive(abort.signal)
        .catch(() => 0)
        .finally(() => {
          this.keeping = null;
        });
    };
    this.keepalive = setInterval(tick, this.hooks.keepaliveMs ?? HELD_KEEPALIVE_MS);
    this.keepalive.unref?.();
    tick();
  }

  /** Continues every copy the last run left mid-way. */
  async resume(): Promise<void> {
    this.startKeepalive();
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
    this.keepaliveAbort?.abort();
    this.keepaliveAbort = null;
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    await this.keeping;
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
    let error = aborted ? new CopyError("cancelled", "The copy was stopped.") : toCopyError(cause);
    // Applied but never committed: Retry cannot finish without the source, which still holds it.
    if (
      error.code === "unauthorized" &&
      !record.committed &&
      (step === "applying" || step === "applied")
    )
      error = new CopyError("unauthorized", appliedButRefusedMessage(record));
    if (aborted && BEFORE_APPLY.has(step)) return;
    await this.update(operationId, {
      state: "failed",
      failedStep: step,
      error: { code: error.code, message: error.message },
      // A stopped step's counts would read as still running.
      progress: null,
    });
    if (BEFORE_APPLY.has(step)) {
      // The target folder is untouched; give the source back.
      await this.client(record)
        .release(`The copy failed on this machine: ${error.message}`.slice(0, 480))
        .catch(() => undefined);
      await NodeFSP.rm(this.paths(operationId).staging, { recursive: true, force: true });
    }
  }

  private checkedManifest(record: DestinationRecord, manifest: Manifest): Manifest {
    if (
      (manifest.header.projectRelativePath ?? ".") !== (record.projectRelativePath ?? ".") ||
      (record.copyRoot !== undefined && manifest.header.copyRoot !== record.copyRoot)
    )
      throw new CopyError("refused", "The source manifest belongs to a different copy scope.");
    return manifest;
  }

  private async fetchManifest(record: DestinationRecord, signal: AbortSignal) {
    const client = this.client(record, signal);
    const paths = this.paths(record.operationId);
    if (await exists(paths.manifest))
      return this.checkedManifest(record, await readManifestFile(paths.manifest));
    await client.requestManifest(record.selection);
    for (;;) {
      signal.throwIfAborted();
      const result = await client.manifest();
      if ("entries" in result) {
        this.checkedManifest(record, result);
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

  /**
   * Checks, before the preview, that this machine can read the origin of every
   * repository chosen to clone, so a clone without access is copied whole instead
   * of failing at the end of the copy. A failed check is asked again next time.
   */
  private async cloneOrigins(
    record: DestinationRecord,
    manifest: Manifest,
    signal: AbortSignal,
  ): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    const chosen = new Set(record.clone);
    const check =
      this.hooks.reachableOrigin ??
      ((origin: string, stop: AbortSignal) => reachableOrigin(origin, NodeOS.homedir(), stop));
    await Promise.all(
      manifest.header.repositories.map(async (repo) => {
        const id = repoRowId(repo.path);
        if (!chosen.has(id) || !repo.origin) return;
        let answer = this.origins.get(repo.origin);
        if (!answer) {
          answer = check(repo.origin, signal).catch(() => null);
          this.origins.set(repo.origin, answer);
        }
        result[id] = await answer;
        if (result[id] === null) this.origins.delete(repo.origin);
      }),
    );
    return result;
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
    return {
      ...planReconcile({
        sourceMachine: record.sourceMachine,
        repositories: manifest.header.repositories,
        entries: manifest.entries,
        targetRoot: record.targetFolder,
        destination,
        relations,
        caseInsensitive: destination.caseInsensitive,
        decisions: record.decisions,
        clone: record.clone,
        cloneOrigins: await this.cloneOrigins(record, manifest, signal),
        skip: record.skip ?? [],
        mirror: record.mirror,
      }),
      ...(destination.fingerprint !== undefined
        ? { destinationFingerprint: destination.fingerprint }
        : {}),
    };
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
    const manifest = this.checkedManifest(record, await readManifestFile(paths.manifest));
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
    const warnings = [...record.warnings, ...result.warnings].slice(0, 200);
    const differing = result.checks.filter((check) => !check.ok);
    // Files Apply put back to the Git snapshot: the source has newer work there.
    const restored = result.restored ?? [];
    if (
      record.mode === "copy-and-move" &&
      (differing.length > 0 || unstable.size > 0 || restored.length > 0)
    ) {
      // The source keeps the coordinator until the person looks: no commit, no move.
      await this.update(op, {
        state: "failed",
        failedStep: "applied",
        error: {
          code: "checks_failed",
          // An unstable file Apply restored is named once, as restored.
          message: checksFailedMessage(
            differing,
            [...unstable].filter((path) => !restored.includes(path)).length,
            restored,
          ),
        },
        checks: result.checks,
        warnings,
        progress: null,
      });
      await NodeFSP.rm(paths.staging, { recursive: true, force: true });
      return;
    }
    const next = await this.update(op, {
      state: "applied",
      checks: result.checks,
      warnings,
      progress: null,
    });
    await NodeFSP.rm(paths.staging, { recursive: true, force: true });
    await this.finish(next);
  }

  /**
   * Pulls the secret files the person approved on the source, one at a time, and
   * records each as it lands so a retry neither repeats nor forgets one.
   */
  private async receiveSecrets(record: DestinationRecord): Promise<DestinationRecord> {
    const client = this.client(record);
    const offered = await client.secrets();
    let current = record;
    const machine = machineSlug(record.sourceMachine);
    for (const file of offered) {
      if ((current.secrets ?? []).some((item) => item.path === file.path)) continue;
      if (!isSafeRelativePath(file.path))
        throw new CopyError("refused", "The source offered a secret file outside the folder.");
      const bytes = await client.secretFile(file.path);
      const received = await writeSecretFile({
        targetRoot: current.targetFolder,
        path: file.path,
        bytes,
        sourceMachine: machine,
      });
      current = await this.update(current.operationId, {
        secrets: [...(current.secrets ?? []), received],
      });
    }
    return this.update(current.operationId, { secretsDone: true });
  }

  /** Tells the source the copy is complete, then registers the folder here. */
  private async finish(record: DestinationRecord) {
    this.checkedManifest(record, await readManifestFile(this.paths(record.operationId).manifest));
    let current = record;
    if (!current.committed && current.secretsDone !== true)
      current = await this.receiveSecrets(current);
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

function checksFailedMessage(
  differing: ReadonlyArray<RepositoryCheck>,
  unstable: number,
  restored: ReadonlyArray<string> = [],
) {
  const parts: Array<string> = [];
  if (differing.length > 0)
    parts.push(
      `${differing.length === 1 ? "1 repository differs" : `${differing.length} repositories differ`} from the source (${differing
        .slice(0, 5)
        .map((check) => (check.repo === "." ? "the root" : check.repo))
        .join(", ")}${differing.length > 5 ? ", …" : ""})`,
    );
  if (unstable > 0)
    parts.push(
      `${unstable === 1 ? "1 file" : `${unstable} files`} kept changing on the source during the copy`,
    );
  if (restored.length > 0)
    parts.push(
      `${restored.length === 1 ? "1 file was" : `${restored.length} files were`} committed or edited on the source after copying started and ${restored.length === 1 ? "is" : "are"} here as ${restored.length === 1 ? "it was" : "they were"} then (${restored
        .slice(0, 5)
        .join(
          ", ",
        )}${restored.length > 5 ? ", …" : ""}); the source has newer work there that would not travel`,
    );
  return restored.length > 0
    ? `The files are in place, but ${parts.join(" and ")}, so the coordinator stayed on the source. Copy again to bring that work, or Move anyway to move without it.`
    : `The files are in place, but ${parts.join(" and ")}, so the coordinator stayed on the source. Undo the copy, or retry to move it anyway.`;
}

/** The source machine as the person knows it, for "cancel it there" advice. */
const sourceName = (record: DestinationRecord) => record.sourceMachine || "the source machine";

function appliedButRefusedMessage(record: DestinationRecord) {
  const name = sourceName(record);
  return `${name} no longer accepts this copy, so it cannot be finished. The files are in place here. Undo the copy here, then cancel it on ${name}${record.mode === "copy-and-move" ? " to give the project back there" : ""}.`;
}

function alreadyCommittedMessage(record: DestinationRecord) {
  const name = sourceName(record);
  return record.mode === "copy-and-move"
    ? `${name} had already finished this move, so the project now lives on this machine. Nothing was removed; the copy is being finished here.`
    : `${name} had already finished this copy. Nothing was removed; the copy is being finished here.`;
}

function undoneButHeldMessage(record: DestinationRecord, code: CopyErrorCode) {
  const name = sourceName(record);
  const reason =
    code === "unauthorized" ? `${name} no longer accepts this copy` : `${name} could not be told`;
  return `The files here were restored, but ${reason}, so the copy is still open there. Cancel the copy on ${name}${record.mode === "copy-and-move" ? " to give the project back there" : " to end it"}.`;
}

/** Applied here (or mid-Apply) but not committed: the source still holds the copy open. */
function holdsSource(record: DestinationRecord) {
  if (record.committed) return false;
  return (
    record.state === "applied" ||
    record.state === "applying" ||
    (record.state === "failed" &&
      (record.failedStep === "applying" || record.failedStep === "applied"))
  );
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
