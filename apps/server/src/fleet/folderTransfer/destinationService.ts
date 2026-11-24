// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - plain async destination worker with private 0600 records.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FOLDER_COPY_ALL_CONFLICTS_PREFIX } from "@specweave-studio/contracts";
import { applyPlan, ApplyRefusedError, bytesNeeded, type RepositoryCheck } from "./apply.ts";
import { DEFAULT_SELECTION, FILE_CLASSES, type FileClass } from "./classify.ts";
import * as Messages from "./copyMessages.ts";
import { caseInsensitiveAt, repositoryRelations, scanDestination } from "./destinationScan.ts";
import { reachableOrigin } from "./git.ts";
import { deviceOf, exists, freeBytes, privateDirectory, readJson, writeJson } from "./durable.ts";
import {
  type DestinationLanRecord,
  type DestinationLanState,
  type LanDestination,
  type LanDestinationAccess,
  lanPathFor,
  NO_LAN_STATE,
} from "./lanDestination.ts";
import {
  readManifestFile,
  validateManifestEntries,
  validateManifestRepositories,
  writeManifest,
  type Manifest,
} from "./manifest.ts";
import { batchChunksFor, finalPass, pullFiles, type PullProgress } from "./pullWorker.ts";
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
import { olderThan } from "../../failClosedAge.ts";
import { isSafeRelativePath } from "./paths.ts";
import {
  LanFirstSourceClient,
  SourceClient,
  SourceClientError,
  type SourceClientOptions,
  StaleScanError,
  UnavailableSnapshotError,
} from "./sourceClient.ts";
import { previewUndo, undoApply, type UndoPreview, type UndoResult } from "./undo.ts";
import { type ReceivedSecret, removeReceivedSecrets, writeSecretFile } from "./secrets.ts";
import { dropReceivingKey, openSealedSecret, receivingKeyFor } from "./secretsKey.ts";
import {
  homeSecretRelative,
  isDotnetUserSecretsFile,
  isHomeSecretPath,
  platformHomePath,
} from "./secretLocations.ts";

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
  readonly capturedAt?: number;
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
  readonly version: 1;
  readonly operationId: string;
  /** The source's remaining address: its Tailscale one when both are offered (the fallback), or its only address. */
  readonly sourceUrl: string;
  /** The source's SpecWithCode Connect address, pulled from first when present. */
  readonly sourceConnectUrl?: string;
  readonly token: string;
  readonly sourceEnvironmentId: string;
  readonly sourceProjectId: string;
  readonly sourceMachine: string;
  readonly mode: "copy-only" | "copy-and-move";
  readonly targetFolder: string;
  /**
   * Frozen at approval: whether the target was missing or empty, and which
   * folder it was (device and file id, null when missing). Apply writes only
   * into that folder.
   */
  readonly targetApproved?: {
    readonly kind: "empty" | "reviewed";
    readonly identity: string | null;
  };
  readonly title: string;
  readonly selection: ReadonlyArray<FileClass>;
  readonly purpose?: "add-to-machine" | "review";
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
  /** Undo started but has not finished. Preserve original backups until it succeeds. */
  readonly undoIncomplete?: boolean;
  /** Secret files received after Apply: paths and sizes, never contents. */
  readonly secrets?: ReadonlyArray<ReceivedSecret>;
  /** Every approved secret file was received (or the source offered none). */
  readonly secretsDone?: boolean;
  /** Approved without secrets: none are pulled, whatever the source has staged. */
  readonly withoutSecrets?: boolean;
  /** The secret files the approving window sent: the copy finishes only with all of them. */
  readonly secretsExpected?: ReadonlyArray<string>;
  /** Chunks per batch the source offered in its hello; older sources and records omit it. */
  readonly sourceBatchChunks?: number;
  /**
   * The local-network path of this copy (1334 S-10): the highest generation seen, the
   * latch to Connect and bytes per path. Never an address, a key, a hash or a token.
   */
  readonly lan?: DestinationLanState;
  /** When the person approved the copy; the copy's clock starts here. */
  readonly startedAt?: string;
  /** When Apply finished: the files are in place, checked or not. */
  readonly finishedAt?: string;
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
  readonly purpose?: "add-to-machine" | "review";
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
  /** Caps chunks per batch below what the source offers; tests use it to get several batches. */
  readonly maxBatchChunks?: number;
  /** How often held copies call the source to keep their grant; hourly by default. */
  readonly keepaliveMs?: number;
  /** The origin address this machine can read, or null; `git ls-remote` by default. */
  readonly reachableOrigin?: (origin: string, signal: AbortSignal) => Promise<string | null>;
  /** Where `~/` secret files land; the user's home by default. */
  readonly home?: () => string;
  /** The local-network path, built over this service's records; absent means Connect only. */
  readonly lan?: (access: LanDestinationAccess) => LanDestination;
}

/** States after which a copy never gets a local-network generation again. */
const LAN_TERMINAL: ReadonlySet<CopyState> = new Set(["applied", "undone", "failed", "cancelled"]);

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
  private readonly running = new Map<
    string,
    { abort: AbortController; done: Promise<void>; step: CopyState }
  >();
  /** Retry or Undo between its check and its work; the other one is refused meanwhile. */
  private readonly claimed = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private keeping: Promise<unknown> | null = null;
  /** Aborted by `close`, so a keepalive call to a silent source does not hold shutdown. */
  private keepaliveAbort: AbortController | null = null;
  /** Origins checked from this machine: the address that answered, or null. */
  private readonly origins = new Map<string, Promise<string | null>>();

  /** The local-network half, when this machine has one. */
  readonly lan: LanDestination | null;

  constructor(stateRoot: string, hooks: DestinationHooks = {}) {
    this.root = NodePath.join(stateRoot, "folder-copies");
    this.hooks = hooks;
    this.lan = hooks.lan?.(this.lanAccess()) ?? null;
  }

  /** The only parts of a copy's record the local-network path reads and writes. */
  private lanAccess(): LanDestinationAccess {
    return {
      lanRecord: async (operationId): Promise<DestinationLanRecord | null> => {
        const record = await this.read(operationId).catch(() => null);
        return record ? { ...record, terminal: LAN_TERMINAL.has(record.state) } : null;
      },
      lanRetire: async (operationId, generation) => {
        const record = await this.read(operationId).catch(() => null);
        if (!record) return;
        // Plain Connect, with the copy's own grant, tried once.
        await this.client(record, undefined, { timeoutMs: 5_000 }, true).lanRetire(generation);
      },
      lanSave: (operationId, change) =>
        this.locked(operationId, async () => {
          const current = await this.read(operationId);
          if (!current) throw new CopyError("refused", "Unknown copy.");
          await writeJson(this.paths(operationId).record, {
            ...current,
            lan: change(current.lan ?? NO_LAN_STATE),
          });
        }),
    };
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
      const now = this.now();
      // Apply ended (with or without differing checks): the copy's clock stops once.
      const finished =
        current.startedAt !== undefined &&
        current.finishedAt === undefined &&
        (patch.state === "applied" || (patch.state === "failed" && patch.failedStep === "applied"));
      const next = {
        ...current,
        ...patch,
        ...(finished ? { finishedAt: now } : {}),
        updatedAt: now,
      } as DestinationRecord;
      await writeJson(this.paths(operationId).record, next);
      return next;
    }).then(async (next) => {
      if (patch.state !== undefined && LAN_TERMINAL.has(patch.state))
        await this.lan?.end(operationId, "terminal");
      return next;
    });
  }

  private client(
    record: DestinationRecord,
    signal?: AbortSignal,
    once?: { readonly timeoutMs: number },
    connectOnly = false,
  ) {
    // SpecWithCode Connect is the primary route; the tailnet is the fallback.
    const options: SourceClientOptions = {
      baseUrl: record.sourceConnectUrl ?? record.sourceUrl,
      ...(record.sourceConnectUrl !== undefined
        ? {
            fallbackBaseUrl: record.sourceUrl,
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
    };
    // The local network carries only the manifest and the chunks, through its own connector.
    return this.lan === null || connectOnly
      ? new SourceClient(options)
      : new LanFirstSourceClient(
          options,
          lanPathFor(
            this.lan,
            this.lanAccess(),
            record.operationId,
            this.paths(record.operationId),
          ),
        );
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
      ...(input.purpose ? { purpose: input.purpose } : {}),
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
        // A newer source takes larger chunk batches; an older one omits this and gets 32.
        ...(typeof hello.maxBatchChunks === "number"
          ? { sourceBatchChunks: hello.maxBatchChunks }
          : {}),
        projectRelativePath: relative,
      };
      await writeJson(paths.record, record);
    } catch (cause) {
      await NodeFSP.rm(paths.directory, { recursive: true, force: true });
      throw toCopyError(cause, record);
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
  async approve(
    operationId: string,
    options: {
      readonly withoutSecrets?: boolean;
      readonly expectedSecrets?: ReadonlyArray<string>;
    } = {},
  ): Promise<DestinationRecord> {
    const record = await this.require(operationId);
    if (record.state !== "previewed")
      throw new CopyError("refused", "Review the copy before approving it.");
    const plan = await this.readPlan(operationId);
    if (!plan || !planReady(plan))
      throw new CopyError("refused", "Some rows still need a decision.");
    // Revalidation is read-only and keeps the resumable job and all existing choices.
    // A live source (logs, ledgers, Git objects) changes every few seconds, so it
    // never matches its scan exactly. When nothing is here yet, no change there can
    // overwrite work here: the copy goes ahead from the reviewed scan, and the
    // transfer re-reads files that change. Anything already here keeps the refusal.
    const sourceMoved = await this.client(record)
      .validateScan()
      .then(
        () => false,
        (error: unknown) => {
          if (error instanceof StaleScanError && nothingHere(plan)) return true;
          throw toCopyError(error, record);
        },
      );
    const manifest = await readManifestFile(this.paths(operationId).manifest);
    // The preview's origin answers stand: approving re-checks the folders, not the network,
    // so a host that stopped answering for a moment cannot read as a changed destination.
    const currentPlan = await this.plan(
      record,
      manifest,
      new AbortController().signal,
      plan.cloneOrigins,
    );
    const assertSamePreview = async () => {
      if (
        JSON.stringify(withoutLan(await this.require(operationId))) !==
          JSON.stringify(withoutLan(record)) ||
        JSON.stringify(await this.readPlan(operationId)) !== JSON.stringify(plan)
      )
        throw new CopyError(
          "refused",
          "The copy changed while checking its preview. Review it again.",
        );
    };
    // A preview saved before plans kept their origin answers is compared without them.
    const { cloneOrigins: _answers, ...withoutAnswers } = currentPlan;
    const comparable = plan.cloneOrigins === undefined ? withoutAnswers : currentPlan;
    if (JSON.stringify(comparable) !== JSON.stringify(plan)) {
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
      const { finishedAt: _finishedAt, ...unfinished } = record;
      // The local-network state moves on its own while a preview is checked: keep what is saved.
      const saved = (await this.require(operationId)).lan;
      const approved: DestinationRecord = {
        ...unfinished,
        ...(saved ? { lan: saved } : {}),
        state: "approved",
        targetApproved: await approvedTarget(record.targetFolder),
        disk: { needed, free },
        ...(sourceMoved ? { warnings: [...record.warnings, SOURCE_MOVED] } : {}),
        error: null,
        ...(options.withoutSecrets ? { withoutSecrets: true } : {}),
        // An empty list is an expectation too: the window sent none, so none are pulled.
        ...(!options.withoutSecrets && options.expectedSecrets
          ? { secretsExpected: [...new Set(options.expectedSecrets)] }
          : {}),
        startedAt: this.now(),
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
    await dropReceivingKey(this.directory(operationId));
    return this.update(operationId, { state: "cancelled", progress: null });
  }

  /** Retries a copy that stopped during Apply; the journal skips finished steps. */
  async retry(operationId: string): Promise<DestinationRecord> {
    // Reserve before reading: Undo may otherwise complete while an earlier read
    // is in flight, leaving Retry to dispatch from obsolete recovery state.
    this.claim(operationId);
    try {
      const record = await this.require(operationId);
      if (record.undoIncomplete)
        throw new CopyError(
          "refused",
          "Undo did not finish. Retry Undo to restore the original files.",
        );
      if (record.state === "failed" && record.failedStep === "applied") {
        // Files are in place; only the source commit or the registration failed.
        const applied = await this.update(operationId, { state: "applied", error: null });
        this.background(operationId, "applied", () => this.finish(applied));
        return applied;
      }
      if (record.state !== "failed")
        throw new CopyError("refused", "Only a failed copy can be retried.");
      if (record.failedStep !== "applying")
        // Before Apply the source has let the copy go and nothing changed here: copy again.
        throw new CopyError(
          "refused",
          "Nothing was changed on this machine. Start the copy again from the source.",
        );
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
    // Once restoration has started, its durable recovery marker wins over a
    // late commit reply. Finishing/registering now would publish mixed originals
    // and copied files instead of completing Undo.
    if (probe === "committed" && !record.undoIncomplete) {
      const applied = await this.update(operationId, {
        state: "applied",
        committed: true,
        error: null,
      });
      this.background(operationId, "applied", () => this.finish(applied));
      throw new CopyError("refused", Messages.alreadyCommittedMessage(record));
    }
    const paths = this.paths(operationId);
    const preview = await previewUndo({
      targetRoot: record.targetFolder,
      journalFile: paths.journal,
    });
    if (preview.edited > 0 && !force) return { record, result: null, preview };
    // Persist before restoring anything: a crash or partial failure must not let
    // retention discard an original that still needs restoring.
    await this.update(operationId, { undoIncomplete: true });
    const keptSecrets = await removeReceivedSecrets(
      record.targetFolder,
      record.secrets ?? [],
      this.hooks.home?.() ?? NodeOS.homedir(),
    );
    const result = await undoApply({
      targetRoot: record.targetFolder,
      backupRoot: paths.backups,
      journalFile: paths.journal,
      force,
    });
    if (result.problems.length > 0) {
      const next = await this.update(operationId, {
        state: "failed",
        failedStep: record.failedStep === "applying" ? "applying" : "applied",
        error: {
          code: "copy_failed",
          message: `Undo did not finish. Retry Undo after resolving these problems: ${result.problems.join(" ")}`,
        },
      });
      return { record: next, result, preview };
    }
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
      undoIncomplete: false,
      error: sourceError
        ? {
            code: sourceError.code,
            message: Messages.undoneButHeldMessage(record, sourceError.code),
          }
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
        (cause: unknown) => toCopyError(cause, record),
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
    for (const saved of await this.list()) {
      const op = saved.operationId;
      if (this.running.has(op) || this.claimed.has(op)) continue;
      // Retention and Undo share ownership, not just a snapshot of eligibility.
      // Reserve before re-reading and hold through deletion and its durable marker.
      this.claim(op);
      try {
        const record = await this.require(op);
        if (record.backupsDiscardedAt !== undefined || record.undoIncomplete) continue;
        if (record.state !== "applied" && record.state !== "undone" && record.state !== "failed")
          continue;
        // An unreadable updatedAt is never old enough: the backups stay.
        if (!olderThan(Date.parse(record.updatedAt), retention, now.getTime())) continue;
        await discardApplyBackups(this.paths(op).backups);
        await this.update(op, { backupsDiscardedAt: now.toISOString() });
        discarded.push(op);
      } finally {
        this.claimed.delete(op);
      }
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
    void this.closeSupersededPreviews().catch(() => undefined);
    for (const saved of await this.list()) {
      const op = saved.operationId;
      if (this.running.has(op) || this.claimed.has(op)) continue;
      // Reserve before re-reading: a foreground Undo cannot start between this
      // read and dispatch, and a stale startup snapshot cannot restart Apply.
      this.claim(op);
      try {
        const record = await this.require(op);
        if (record.undoIncomplete) {
          await this.update(op, {
            state: "failed",
            failedStep:
              record.failedStep === "applying" || record.state === "applying"
                ? "applying"
                : "applied",
            error: record.error?.message.startsWith("Undo")
              ? record.error
              : {
                  code: "copy_failed",
                  message:
                    "Undo was interrupted. Retry Undo to finish restoring the original files.",
                },
          });
          continue;
        }
        switch (record.state) {
          case "planned":
          case "scanning":
            this.background(op, "scanning", (signal) =>
              record.state === "planned"
                ? this.preview(record, signal)
                : this.replan(record, signal),
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
      } finally {
        this.claimed.delete(op);
      }
    }
  }

  /**
   * The copies working here right now, for the update gate: measuring,
   * transferring, verifying, applying or finishing in the background. A copy
   * waiting on a person (previewed, or applied and held) runs nothing and never counts.
   */
  async activeOperations(): Promise<Array<{ operationId: string; state: CopyState }>> {
    return Promise.all(
      [...this.running].map(async ([operationId, running]) => ({
        operationId,
        // The record says how far the step got: a transfer goes on to verify and apply.
        state: (await this.read(operationId).catch(() => null))?.state ?? running.step,
      })),
    );
  }

  async waitFor(operationId: string): Promise<void> {
    await this.running.get(operationId)?.done.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.lan?.close();
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
    this.running.set(operationId, { abort, done, step });
  }

  private async fail(operationId: string, fallback: CopyState, cause: unknown, aborted: boolean) {
    const record = await this.read(operationId);
    if (!record || record.state === "cancelled") return;
    const step = record.state === "failed" ? (record.failedStep ?? fallback) : record.state;
    let error = aborted
      ? new CopyError("cancelled", "The copy was stopped.")
      : toCopyError(cause, record);
    // Applied but never committed: Retry cannot finish without the source, which still holds it.
    if (
      error.code === "unauthorized" &&
      !record.committed &&
      (step === "applying" || step === "applied")
    )
      error = new CopyError("unauthorized", Messages.appliedButRefusedMessage(record));
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

  /** A manifest of this copy's scope whose every path this machine can take, before any chunk is asked for. */
  private async safeManifest(record: DestinationRecord, manifest: Manifest): Promise<Manifest> {
    this.checkedManifest(record, manifest);
    const refusal =
      validateManifestRepositories(manifest.header.repositories ?? [], process.platform) ??
      validateManifestEntries(manifest.entries, {
        platform: process.platform,
        caseInsensitive: await caseInsensitiveAt(record.targetFolder),
      });
    if (refusal)
      throw new CopyError(
        "refused",
        `The source manifest has a path this machine cannot take safely (${refusal.reason}): ${refusal.path.slice(0, 200)}`,
      );
    return manifest;
  }

  private async fetchManifest(record: DestinationRecord, signal: AbortSignal) {
    const client = this.client(record, signal);
    const paths = this.paths(record.operationId);
    if (await exists(paths.manifest))
      return this.safeManifest(record, await readManifestFile(paths.manifest));
    await client.requestManifest(record.selection);
    for (;;) {
      signal.throwIfAborted();
      const result = await client.manifest();
      if ("entries" in result) {
        await this.safeManifest(record, result);
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
      ...(manifest.header.capturedAt !== undefined
        ? { capturedAt: manifest.header.capturedAt }
        : {}),
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
    const repositories = manifest.header.repositories.filter(
      (repo) => chosen.has(repoRowId(repo.path)) && repo.origin,
    );
    // A few at a time: Git hosts drop bursts of SSH connections, which would read as refusals.
    await forEachLimited(repositories, ORIGIN_CHECKS_AT_ONCE, async (repo) => {
      const origin = repo.origin!;
      const id = repoRowId(repo.path);
      let answer = this.origins.get(origin);
      if (!answer) {
        answer = check(origin, signal).catch(() => null);
        this.origins.set(origin, answer);
      }
      result[id] = await answer;
      if (result[id] === null) this.origins.delete(origin);
    });
    signal.throwIfAborted();
    // Sorted, so the same answers always write the same plan.
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
  }

  private async plan(
    record: DestinationRecord,
    manifest: Manifest,
    signal: AbortSignal,
    /** Origin answers already shown in the preview; probed again when absent. */
    checked?: Plan["cloneOrigins"],
  ): Promise<Plan> {
    const client = this.client(record, signal);
    const destination = await scanDestination(record.targetFolder, manifest.entries);
    const relations = await repositoryRelations(
      record.targetFolder,
      manifest.header.repositories,
      destination.repositories,
      (repo, commits) => client.ancestry(repo, commits),
    );
    const cloneOrigins = checked ?? (await this.cloneOrigins(record, manifest, signal));
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
        cloneOrigins,
        skip: record.skip ?? [],
        mirror: record.mirror,
        // Only a copy the person reviews in the Copy files dialog may take theirs on a
        // diverged repository; any other start, with or without a purpose, is protected.
        protectDiverged: record.purpose !== "review",
      }),
      ...(destination.fingerprint !== undefined
        ? { destinationFingerprint: destination.fingerprint }
        : {}),
      ...(Object.keys(cloneOrigins).length > 0 ? { cloneOrigins } : {}),
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
    const onProgress = this.progressWriter(op, "files");
    const batchSize = batchChunksFor(this.hooks.maxBatchChunks ?? record.sourceBatchChunks);
    const pulled = await pullFiles({
      client,
      stagingRoot: paths.staging,
      files: needs.files,
      directories: needs.directories,
      signal,
      onProgress,
      maxBatchChunks: batchSize,
    });
    await this.update(op, { state: "verifying" });
    const final = await finalPass({
      client,
      maxBatchChunks: batchSize,
      stagingRoot: paths.staging,
      files: needs.files,
      links: plan.actions
        .filter((action) => action.entry?.type === "symlink" && action.entry.target !== undefined)
        .map((action) => ({ path: action.path, target: action.entry!.target! })),
      signal,
      onProgress: this.progressWriter(op, "verify"),
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

  /** Writes a step's counts at most once a second, and always its last one. */
  private progressWriter(op: string, phase: "files" | "verify" | "apply") {
    let last = 0;
    return (progress: PullProgress) => {
      const now = Date.now();
      if (now - last < 1_000 && progress.filesDone < progress.filesTotal) return;
      last = now;
      void this.update(op, { progress: { phase, ...progress } }).catch(() => undefined);
    };
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
      ...(record.targetApproved ? { approved: record.targetApproved } : {}),
      onProgress: this.progressWriter(op, "apply"),
    });
    // Apply's lines first: they name any folder it refused, and the list is cut.
    const warnings = [...result.warnings, ...record.warnings].slice(0, 200);
    const differing = result.checks.filter((check) => !check.ok);
    // Files Apply put back to the Git snapshot: the source has newer work there.
    const restored = result.restored ?? [];
    if (
      record.mode === "copy-and-move" &&
      // An entry refused for its folder did not arrive: the source keeps the work.
      (differing.length > 0 ||
        unstable.size > 0 ||
        restored.length > 0 ||
        result.refused.length > 0)
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
            result.refused.length,
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
    // Approved without secrets: the source's staged list is never read.
    if (record.withoutSecrets === true) {
      await dropReceivingKey(this.directory(record.operationId));
      return this.update(record.operationId, { secretsDone: true });
    }
    const client = this.client(record);
    // The approval named the files the window sent: only those are pulled, so a list another
    // window staged meanwhile neither adds a file nor brings back one the person unticked.
    const named = record.secretsExpected ? new Set(record.secretsExpected) : null;
    const offer = await client.secretsOffer();
    const offered = offer.files.filter((file) => !named || named.has(file.path));
    let current = record;
    const machine = machineSlug(record.sourceMachine);
    for (const file of offered) {
      if ((current.secrets ?? []).some((item) => item.path === file.path)) continue;
      // A `~/` file is only ever .NET user secrets, written to the same place in this
      // machine's home; anything else must stay inside the folder.
      const home = isHomeSecretPath(file.path) ? homeSecretRelative(file.path) : null;
      if (
        isHomeSecretPath(file.path)
          ? home === null || !isDotnetUserSecretsFile(home)
          : !isSafeRelativePath(file.path)
      )
        throw new CopyError("refused", "The source offered a secret file outside the folder.");
      const served = await client.secretFile(file.path);
      const bytes = await this.secretBytes(current, served, offer.sealed);
      const written = await writeSecretFile({
        targetRoot:
          home === null ? current.targetFolder : (this.hooks.home?.() ?? NodeOS.homedir()),
        path: home === null ? file.path : platformHomePath(home, process.platform),
        bytes,
        sourceMachine: machine,
      });
      const received =
        home === null
          ? written
          : { ...written, path: file.path, writtenAs: `~/${written.writtenAs}` };
      current = await this.update(current.operationId, {
        secrets: [...(current.secrets ?? []), received],
      });
    }
    // The window sent these before approving: a source that no longer offers one (its list
    // was withdrawn or lost, or it answers as if it had none) must not read as a full copy.
    const arrived = new Set((current.secrets ?? []).map((item) => item.path));
    const missing = (current.secretsExpected ?? []).filter((path) => !arrived.has(path));
    if (missing.length > 0)
      throw new CopyError("refused", Messages.secretsNotOfferedMessage(current, missing.length), {
        missingSecrets: missing.length,
      });
    await dropReceivingKey(this.directory(current.operationId));
    return this.update(current.operationId, { secretsDone: true });
  }

  /** A served secret's plain bytes: as sent, or opened with this copy's receiving key. */
  private async secretBytes(
    record: DestinationRecord,
    served: { readonly bytes: Uint8Array; readonly sealed: boolean },
    /** The source's list said these files come sealed: a plain body is not what it staged. */
    listedSealed: boolean,
  ): Promise<Uint8Array> {
    if (!served.sealed && listedSealed)
      throw new CopyError(
        "refused",
        `${record.sourceMachine} listed its secret files as sealed and sent one that is not, so it was not written. The other files are in place. Sync again to send the secret files.`,
      );
    if (!served.sealed) return served.bytes;
    const opened = await openSealedSecret(this.directory(record.operationId), served.bytes);
    if (opened === null)
      throw new CopyError(
        "refused",
        `${record.sourceMachine} sent a secret file sealed to a key this machine does not hold, so it was not written. The other files are in place. Sync again to send the secret files.`,
      );
    return opened;
  }

  /**
   * This copy's receiving key (public half), for the machine that offered the copy and
   * for no one else. The source seals each secret file to it, so the files open only
   * here. Refused once the secrets are in or the copy has ended.
   */
  async secretsKey(operationId: string, sourceEnvironmentId: string): Promise<string> {
    return this.locked(operationId, async () => {
      const record = await this.read(operationId);
      // The same answer for an unknown copy and for another machine's: neither learns more.
      if (!record || record.sourceEnvironmentId !== sourceEnvironmentId)
        throw new CopyError("refused", "That copy came from another machine.");
      if (
        record.committed ||
        record.secretsDone === true ||
        record.state === "undone" ||
        record.state === "cancelled"
      )
        throw new CopyError("refused", "This copy no longer takes secret files.");
      return receivingKeyFor(this.directory(operationId), this.now());
    });
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
    void this.closeSupersededPreviews().catch(() => undefined);
  }

  /**
   * A comparison left waiting for review is out of date once a later copy of the same
   * folder from the same project finished: it would only ask about files already there.
   * Only previews close; they have written nothing. Telling the source can wait on a slow
   * network, so callers do not hold startup or a finished copy on it.
   */
  async closeSupersededPreviews(): Promise<ReadonlyArray<string>> {
    const records = await this.list();
    const closed: Array<string> = [];
    for (const record of records) {
      if (record.state !== "previewed" || this.running.has(record.operationId)) continue;
      const finished = records.some(
        (other) =>
          other.state === "applied" &&
          other.committed &&
          other.targetFolder === record.targetFolder &&
          other.sourceEnvironmentId === record.sourceEnvironmentId &&
          other.sourceProjectId === record.sourceProjectId &&
          // Started after this comparison last changed; a finished copy's updatedAt moves later.
          Date.parse(other.createdAt) > Date.parse(record.updatedAt) &&
          // It carried at least what this comparison asks about.
          (record.mode === "copy-only" || other.mode === "copy-and-move") &&
          record.selection.every((value) => other.selection.includes(value)),
      );
      if (!finished) continue;
      const cancelled = await this.locked(record.operationId, async () => {
        const current = await this.read(record.operationId);
        if (
          current?.state !== "previewed" ||
          current.updatedAt !== record.updatedAt ||
          this.running.has(record.operationId)
        )
          return null;
        const next: DestinationRecord = {
          ...current,
          state: "cancelled",
          progress: null,
          updatedAt: this.now(),
        };
        await writeJson(this.paths(record.operationId).record, next);
        return next;
      });
      if (cancelled === null) continue;
      await this.client(cancelled)
        .release("A later copy of this folder finished.")
        .catch(() => undefined);
      await NodeFSP.rm(this.paths(record.operationId).staging, { recursive: true, force: true });
      closed.push(record.operationId);
    }
    return closed;
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
  refused = 0,
) {
  const parts: Array<string> = [];
  if (refused > 0)
    parts.push(
      `${refused === 1 ? "1 entry was" : `${refused} entries were`} not copied because a folder on the way is not yours alone (see the warnings)`,
    );
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
    ? `The files are in place, but ${parts.join(" and ")}, so the coordinator stayed on the source. Sync again to bring that work, or Move anyway to move without it.`
    : `The files are in place, but ${parts.join(" and ")}, so the coordinator stayed on the source. Undo the copy, or retry to move it anyway.`;
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

/** How many origins the preview asks at once. */
const ORIGIN_CHECKS_AT_ONCE = 4;

/** Runs `run` over `items` with at most `limit` running at once. */
export async function forEachLimited<T>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const SOURCE_MOVED =
  "The source changed after its scan. This copy carries the scanned files and history; files that change during the copy are read again.";

/** Every row is left out or new with nothing here: no source change could overwrite work here. */
/** The target as the person approved it: which folder stands there, and whether it holds anything. */
async function approvedTarget(
  folder: string,
): Promise<NonNullable<DestinationRecord["targetApproved"]>> {
  const stat = await NodeFSP.lstat(folder, { bigint: true }).catch(() => null);
  if (!stat) return { kind: "empty", identity: null };
  const empty = stat.isDirectory() && (await NodeFSP.readdir(folder)).length === 0;
  return { kind: empty ? "empty" : "reviewed", identity: `${stat.dev}:${stat.ino}` };
}

function nothingHere(plan: Plan): boolean {
  return plan.rows.every(
    (row) =>
      row.status === "skipped" ||
      (row.status === "new" &&
        row.bytesPresent === 0 &&
        row.conflicts.length === 0 &&
        !row.replacing),
  );
}

/** Maps a failure to the copy error people see; with the record, a refusal names the source. */
export function toCopyError(cause: unknown, record?: DestinationRecord): CopyError {
  if (cause instanceof CopyError) return cause;
  if (cause instanceof SourceClientError) {
    if (cause.code === "unauthorized" && record)
      return new CopyError("unauthorized", Messages.staleOfferMessage(record));
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
    return new CopyError(
      code,
      messages[cause.code],
      cause instanceof StaleScanError || cause instanceof UnavailableSnapshotError
        ? { recovery: "compare_again" }
        : {},
    );
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

/** A record without its local-network state, which changes outside a person's review. */
function withoutLan(record: DestinationRecord) {
  const { lan: _lan, updatedAt: _updatedAt, ...rest } = record;
  return rest;
}
