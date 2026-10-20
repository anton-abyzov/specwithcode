// @effect-diagnostics nodeBuiltinImport:off -- Index files live beside statev2.sqlite and are listed and deleted with node:fs.
/**
 * Project knowledge: indexes a project's memory files and Library text into a
 * per-project SQLite FTS5 file, decides whether worker threads receive the
 * memory files and hub artifacts inline or search them, and answers searches
 * and reads. The rendered view is kept in memory and in the index file, so the
 * context snapshot reads it without file work inside its transaction. One
 * queue runs every refresh, rebuild, removal and eviction, so they never
 * overlap; requests use the index only in synchronous steps between them.
 *
 * Writes go in small transactions with other work in between. A document
 * being replaced is marked pending before its passages change, so a refresh
 * cut short anywhere re-indexes it next time instead of trusting half of it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  PROJECT_KNOWLEDGE_FILE_BYTES,
  PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
  PROJECT_KNOWLEDGE_READ_PAGE_CHARACTERS,
  PROJECT_KNOWLEDGE_SEARCH_DEFAULT_RESULTS,
  PROJECT_KNOWLEDGE_SEARCH_MAX_RESULTS,
  ProjectKnowledgeError,
  type ProjectId,
  type ProjectKnowledgeDocument,
  type ProjectKnowledgeMode,
  type ProjectKnowledgeReadInput,
  type ProjectKnowledgeReindexInput,
  type ProjectKnowledgeSearchHit,
  type ProjectKnowledgeSearchInput,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeSkipped,
  type ProjectKnowledgeSourceSummary,
  type ProjectKnowledgeStatus,
  type ProjectKnowledgeStatusInput,
} from "@specweave-studio/contracts";
import { makeDrainableWorker } from "@specweave-studio/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { parseJson, stringifyJson } from "../../json.ts";
import { sha256 } from "../../nodeCrypto.ts";
import * as DiskSpaceMonitor from "../../observability/DiskSpaceMonitor.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { registerLiveDatabase } from "../../persistence/liveDatabaseGuard.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as WorkspaceSensitivePaths from "../../workspace/WorkspaceSensitivePaths.ts";
import { chunkKnowledgeText, markdownTitle, type KnowledgeChunk } from "./knowledgeChunker.ts";
import {
  isDamagedIndexError,
  KNOWLEDGE_SCHEMA_VERSION,
  openKnowledgeIndex,
  PENDING_REVISION,
  type KnowledgeDocument,
  type KnowledgeDocumentRow,
  type KnowledgeIndex,
  type KnowledgeWrite,
} from "./knowledgeIndex.ts";
import { knowledgeMatchExpression } from "./knowledgeQuery.ts";
import {
  inlineKnowledgeLength,
  type KnowledgeInlineDocument,
  type KnowledgeView,
} from "./knowledgeSections.ts";
import {
  isMarkdownLocation,
  readKnowledgeFile,
  scanKnowledgeFiles,
  type KnowledgeFileCandidate,
  type KnowledgeScan,
} from "./knowledgeSources.ts";

export class ProjectKnowledge extends Context.Service<
  ProjectKnowledge,
  {
    /** The rendered view for the context snapshot; never reads Library files. */
    readonly view: (projectId: ProjectId) => Effect.Effect<KnowledgeView | null>;
    /** Before a turn: waits briefly for a first index or for a known change to land. */
    readonly ready: (projectId: ProjectId) => Effect.Effect<void>;
    /** Records a change to the project's knowledge, such as a memory write. */
    readonly markDirty: (projectId: ProjectId) => Effect.Effect<void>;
    readonly status: (
      input: ProjectKnowledgeStatusInput,
    ) => Effect.Effect<ProjectKnowledgeStatus, ProjectKnowledgeError>;
    readonly search: (
      input: ProjectKnowledgeSearchInput,
    ) => Effect.Effect<ProjectKnowledgeSearchResult, ProjectKnowledgeError>;
    readonly read: (
      input: ProjectKnowledgeReadInput,
    ) => Effect.Effect<ProjectKnowledgeDocument, ProjectKnowledgeError>;
    readonly reindex: (
      input: ProjectKnowledgeReindexInput,
    ) => Effect.Effect<ProjectKnowledgeStatus, ProjectKnowledgeError>;
    /** Resolves once queued work has finished; for tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("specweave-studio/project/knowledge/ProjectKnowledge") {}

/**
 * Disk budget for every project's index together; past it the least recently
 * used files are removed and rebuilt on next use. Tests make it small.
 */
export const KnowledgeIndexBudgetBytes = Context.Reference<number>(
  "specweave-studio/project/knowledge/ProjectKnowledge/KnowledgeIndexBudgetBytes",
  { defaultValue: () => 2 * 1024 * 1024 * 1024 },
);

/** A view older than this is refreshed on the next request. */
const FRESH_MS = 30_000;
const READY_WAIT = "2 seconds";
const SEARCH_FIRST_BUILD_WAIT = "10 seconds";
/**
 * Work in one write transaction: each passage written or removed costs 1,
 * and a document 1 more per 20,000 characters of text.
 */
const BATCH_COST = 200;
const CHUNK_SLICE = 100;
const DOCUMENT_COST_CHARACTERS = 20_000;
const MERGE_PAGES = 64;
const MERGE_STEPS = 64;
/** Merge steps after each write batch, so no FTS5 level fills up and merges inside a write. */
const FLUSH_MERGE_STEPS = 2;
const VACUUM_PAGES = 256;
const VACUUM_STEPS = 64;
/** Index calls run on the event loop; a slower one is logged. */
const SLOW_CALL_MS = 250;
/** Matches ranked before the joins, which bounds a broad search; a `within` search takes all. */
const SEARCH_CANDIDATES = 1_000;
const CHUNKS_PER_DOCUMENT = 2;
const RESULT_TEXT_CHARACTERS = 16_000;
const MEMORY_LABEL = "Project memory";
const LABEL_ORDER = [
  MEMORY_LABEL,
  "Hub artifacts",
  "Docs",
  "SpecWeave memory",
  "Reports",
  "Increments",
];
const REFRESH_PROBLEM =
  "The knowledge index could not be updated. Rebuild it, or check that the project folder is readable.";
const DISK_PROBLEM =
  "The disk is almost full, so indexing is paused. It continues once space is freed.";
const SCAN_PROBLEM =
  "Part of the project folder could not be read, so the index keeps what it had. Check that the folder is reachable and its hub file is valid.";

/** Stops a refresh before a write while the disk is critically full. */
class KnowledgePaused extends Data.TaggedError("KnowledgePaused") {}

/** A synchronous index call that threw; `cause` tells a damaged file from a busy or full one. */
class KnowledgeIndexFailure extends Data.TaggedError("KnowledgeIndexFailure")<{
  readonly cause: unknown;
}> {}

const isDamaged = (error: unknown) =>
  isDamagedIndexError(error instanceof KnowledgeIndexFailure ? error.cause : error);

type Totals = {
  readonly documents: number;
  readonly characters: number;
  /** Size on disk of the indexed documents; absent in totals saved before it was counted. */
  readonly bytes?: number;
  readonly inlineCharacters: number;
  readonly sources: readonly ProjectKnowledgeSourceSummary[];
  readonly skipped: ProjectKnowledgeSkipped;
  readonly indexedAt: string | null;
  readonly problem: string | null;
};

type Entry = {
  index: KnowledgeIndex | null;
  unregister: (() => void) | null;
  /** null until loaded from the index file or computed by a refresh. */
  mode: ProjectKnowledgeMode | null;
  view: KnowledgeView | null;
  totals: Totals | null;
  scannedAt: number;
  /** Last time a thread or the app used this project's knowledge; orders evictions. */
  usedAt: number;
  /** Counts known changes; `covered` is the count a finished refresh started from. */
  changes: number;
  covered: number;
  startedFrom: number;
  queued: boolean;
  running: boolean;
  rebuildRequested: boolean;
  rebuilding: boolean;
  /** Resolves when no work for this project is queued or running. */
  idle: Deferred.Deferred<void> | null;
};

type Job = { readonly kind: "refresh" | "purge"; readonly projectId: ProjectId };

type Candidate =
  | {
      readonly source: "memory";
      readonly id: string;
      readonly name: string;
      readonly revision: string;
      readonly size: number;
      readonly modifiedAt: string;
    }
  | {
      readonly source: "file";
      readonly id: string;
      readonly file: KnowledgeFileCandidate;
      readonly revision: string;
      readonly size: number;
      readonly modifiedAt: string;
    };

type SkippedCounts = { tooLarge: number; overCapacity: number; unreadable: number };

const EMPTY_SKIPPED: ProjectKnowledgeSkipped = { tooLarge: 0, overCapacity: 0, unreadable: 0 };

function labelRank(label: string): number {
  const index = LABEL_ORDER.indexOf(label);
  return index === -1 ? LABEL_ORDER.length : index;
}

function sortLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort((left, right) => labelRank(left) - labelRank(right));
}

/** A UTF-16 cut that never separates a surrogate pair. */
function boundedEnd(content: string, end: number): number {
  if (end >= content.length) return content.length;
  const code = content.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(value ?? fallback)));
}

function isoAt(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Math.trunc(millis)));
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isInlineDocument = (value: unknown): value is KnowledgeInlineDocument =>
  typeof value === "object" &&
  value !== null &&
  ["id", "title", "location", "kind", "label", "content"].every(
    (key) => typeof (value as Record<string, unknown>)[key] === "string",
  );

/** A stored view, or null when it is missing or from another build; a refresh replaces it. */
function decodeView(value: string | null): KnowledgeView | null {
  if (value === null) return null;
  try {
    const view = parseJson(value) as Record<string, unknown> | null;
    if (!view || typeof view.root !== "string") return null;
    if (
      view.mode === "inline" &&
      Array.isArray(view.documents) &&
      view.documents.every(isInlineDocument) &&
      isStrings(view.searchLabels)
    )
      return view as KnowledgeView;
    if (view.mode === "search" && isStrings(view.labels) && isStrings(view.artifactTitles))
      return view as KnowledgeView;
    return null;
  } catch {
    return null;
  }
}

function decodeTotals(value: string | null): Totals | null {
  if (value === null) return null;
  try {
    const totals = parseJson(value) as Totals | null;
    return totals && typeof totals.documents === "number" ? totals : null;
  } catch {
    return null;
  }
}

/** Memory, hub artifacts, then Library files in the scan's priority order, until a limit is reached. */
function selectCandidates(candidates: readonly Candidate[]) {
  const skipped: SkippedCounts = { tooLarge: 0, overCapacity: 0, unreadable: 0 };
  const accepted: Candidate[] = [];
  let budget = PROJECT_KNOWLEDGE_MAX_BYTES;
  for (const candidate of candidates) {
    if (candidate.size > PROJECT_KNOWLEDGE_FILE_BYTES) skipped.tooLarge += 1;
    else if (accepted.length >= PROJECT_KNOWLEDGE_MAX_DOCUMENTS || candidate.size > budget)
      skipped.overCapacity += 1;
    else {
      accepted.push(candidate);
      budget -= candidate.size;
    }
  }
  return { accepted, skipped };
}

/**
 * Part of a file's revision: a file that joins or leaves the hub, moves
 * folders or gets a new hub title is indexed again even when its bytes stay.
 */
function placement(file: KnowledgeFileCandidate): string {
  return sha256([file.kind, "\n", file.label, "\n", file.title ?? ""], "hex").slice(0, 12);
}

/** Whether a stored document already carries what indexing it now would record about it. */
function sameDescription(stored: KnowledgeDocumentRow, document: KnowledgeDocument): boolean {
  return (
    stored.kind === document.kind &&
    stored.label === document.label &&
    stored.title === document.title &&
    stored.location === document.location
  );
}

function documentFor(candidate: Candidate, content: string, digest: string): KnowledgeDocument {
  const memory = candidate.source === "memory";
  const location = memory ? candidate.name : candidate.file.location;
  const markdown = memory || isMarkdownLocation(location);
  return {
    id: candidate.id,
    kind: memory ? "memory" : candidate.file.kind,
    label: memory ? MEMORY_LABEL : candidate.file.label,
    location,
    title: memory
      ? candidate.name.replace(/\.md$/, "")
      : (candidate.file.title ??
        (markdown ? markdownTitle(content) : null) ??
        NodePath.posix.basename(location)),
    revision: candidate.revision,
    sha256: digest,
    characters: content.length,
    modifiedAt: candidate.modifiedAt,
    content,
  };
}

/**
 * Memory files and hub artifacts go inline while they fit, with a lower bar
 * to return from search mode so edits near the line do not flap; Library
 * folder files are searched either way. With nothing curated, the project is
 * in search mode.
 */
function chooseView(
  index: KnowledgeIndex,
  root: string,
  previous: ProjectKnowledgeMode | null,
): {
  mode: ProjectKnowledgeMode;
  view: KnowledgeView | null;
  totals: Omit<Totals, "skipped" | "indexedAt" | "problem">;
} {
  const rows = index.totals();
  const documents = rows.reduce((sum, row) => sum + row.documents, 0);
  const characters = rows.reduce((sum, row) => sum + row.characters, 0);
  const curatedCharacters = rows
    .filter((row) => row.kind !== "library")
    .reduce((sum, row) => sum + row.characters, 0);
  const limit =
    previous === "search"
      ? PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT
      : PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT;
  // Fenced text is never shorter than the text itself, so only knowledge that could fit is loaded.
  const curated: KnowledgeInlineDocument[] | null =
    curatedCharacters > 0 && curatedCharacters <= limit
      ? index
          .curatedDocuments()
          .map((document) => ({
            id: document.id,
            title: document.title,
            location: document.location,
            kind: document.kind,
            label: document.label,
            content: document.content,
          }))
          .sort(
            (left, right) =>
              labelRank(left.label) - labelRank(right.label) ||
              left.location.localeCompare(right.location),
          )
      : null;
  const inlineCharacters = curated ? inlineKnowledgeLength(curated) : curatedCharacters;
  const mode: ProjectKnowledgeMode =
    documents === 0 ? "empty" : curated && inlineCharacters <= limit ? "inline" : "search";
  const view: KnowledgeView | null =
    mode === "inline" && curated
      ? {
          mode: "inline",
          root,
          documents: curated,
          searchLabels: sortLabels(
            rows.filter((row) => row.kind === "library").map((row) => row.label),
          ),
        }
      : mode === "search"
        ? {
            mode: "search",
            root,
            labels: sortLabels(rows.map((row) => row.label)),
            artifactTitles: index.artifactTitles(),
          }
        : null;
  return {
    mode,
    view,
    totals: {
      documents,
      characters,
      inlineCharacters,
      sources: rows
        .map((row) => ({
          kind: row.kind,
          label: row.label,
          documents: row.documents,
          characters: row.characters,
        }))
        .sort((left, right) => labelRank(left.label) - labelRank(right.label)),
    },
  };
}

/** A LIKE pattern for locations under `within`, which may also be spelled from the project folder. */
function withinPattern(within: string | undefined, workspaceRoot: string): string {
  let path = (within ?? "").trim().replace(/\\/g, "/");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && (path === root || path.startsWith(`${root}/`))) path = path.slice(root.length);
  path = path.replace(/^(\.?\/)+/, "");
  return `${path.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function fileStat(file: string): NodeFS.Stats | null {
  try {
    return NodeFS.statSync(file);
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const guard = yield* WorkspaceSensitivePaths.sensitivePathGuard;
  const disk = yield* Effect.serviceOption(DiskSpaceMonitor.DiskSpaceMonitor);
  const budgetBytes = yield* KnowledgeIndexBudgetBytes;
  const knowledgeRoot = NodePath.join(config.stateDir, "knowledge");
  const directory = NodePath.join(knowledgeRoot, `v${KNOWLEDGE_SCHEMA_VERSION}`);
  const entries = new Map<ProjectId, Entry>();

  const indexFile = (projectId: ProjectId) =>
    NodePath.join(directory, `${sha256([projectId], "hex")}.sqlite`);

  const entryFor = (projectId: ProjectId): Entry => {
    let entry = entries.get(projectId);
    if (!entry) {
      entry = {
        index: null,
        unregister: null,
        mode: null,
        view: null,
        totals: null,
        scannedAt: 0,
        usedAt: 0,
        changes: 0,
        covered: 0,
        startedFrom: 0,
        queued: false,
        running: false,
        rebuildRequested: false,
        rebuilding: false,
        idle: null,
      };
      entries.set(projectId, entry);
    }
    return entry;
  };

  const touch = (entry: Entry) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        entry.usedAt = now;
      }),
    );

  const removeFiles = (file: string) => {
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      NodeFS.rmSync(`${file}${suffix}`, { force: true });
  };

  const closeIndex = (entry: Entry) => {
    entry.index?.close();
    entry.unregister?.();
    entry.index = null;
    entry.unregister = null;
  };

  /**
   * Opens the project's index. With `create`, a missing file is made and a
   * damaged or foreign one replaced; any other failure, such as a full disk,
   * leaves the file alone and fails the refresh.
   */
  const openIndex = (
    projectId: ProjectId,
    entry: Entry,
    create: boolean,
  ): KnowledgeIndex | null => {
    if (entry.index) return entry.index;
    const file = indexFile(projectId);
    if (!create && !NodeFS.existsSync(file)) return null;
    let index: KnowledgeIndex;
    try {
      index = openKnowledgeIndex(file, projectId);
    } catch (error) {
      if (!create) return null;
      if (!isDamagedIndexError(error)) throw error;
      removeFiles(file);
      index = openKnowledgeIndex(file, projectId);
    }
    entry.index = index;
    entry.unregister = registerLiveDatabase(file);
    return index;
  };

  const loadPersisted = (projectId: ProjectId, entry: Entry) => {
    if (entry.mode !== null) return;
    try {
      const index = openIndex(projectId, entry, false);
      const mode = index?.meta("mode");
      if (!index || (mode !== "empty" && mode !== "inline" && mode !== "search")) return;
      const view = mode === "empty" ? null : decodeView(index.meta("view"));
      // A view this build cannot read is computed again by the next refresh.
      if (mode !== "empty" && view === null) return;
      entry.mode = mode;
      entry.view = view;
      entry.totals = decodeTotals(index.meta("totals"));
      entry.scannedAt = Number(index.meta("scanned_at") ?? 0) || 0;
    } catch {
      // An unreadable file is replaced by the next refresh.
    }
  };

  const failed = (projectId: ProjectId, code: ProjectKnowledgeError["code"]) =>
    new ProjectKnowledgeError({ projectId, code });

  const requireProject = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.mapError(() => failed(projectId, "operation_failed")),
      Effect.flatMap((project) =>
        Effect.fromOption(project).pipe(Effect.mapError(() => failed(projectId, "not_found"))),
      ),
    );

  /** Runs one synchronous index call and logs it when it holds the event loop too long. */
  const timed = <A>(projectId: ProjectId, call: string, run: () => A) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const result = yield* Effect.try({
        try: run,
        catch: (cause) => new KnowledgeIndexFailure({ cause }),
      });
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      if (elapsed > SLOW_CALL_MS)
        yield* Effect.logWarning("Project knowledge index call was slow", {
          projectId,
          call,
          elapsed,
        });
      return result;
    });

  const pauseWhenDiskCritical = Effect.gen(function* () {
    if (Option.isNone(disk)) return;
    const status = yield* disk.value.current;
    if (Option.isSome(status) && status.value.level === "critical")
      return yield* new KnowledgePaused();
  });

  const purge = (projectId: ProjectId) =>
    Effect.sync(() => {
      const entry = entries.get(projectId);
      if (entry) closeIndex(entry);
      removeFiles(indexFile(projectId));
      entries.delete(projectId);
      return entry?.idle ?? null;
    }).pipe(Effect.flatMap((idle) => (idle ? Deferred.succeed(idle, undefined) : Effect.void)));

  const readContent = (projectId: ProjectId, candidate: Candidate, skipped: SkippedCounts) =>
    candidate.source === "memory"
      ? sql<{
          content: string;
        }>`SELECT content FROM project_memory WHERE project_id = ${projectId} AND name = ${candidate.name}`.pipe(
          Effect.map((rows) => rows[0]?.content ?? null),
        )
      : Effect.promise(() => readKnowledgeFile(candidate.file, guard)).pipe(
          Effect.map((text) => {
            if (text.type === "text") return text.content;
            skipped[text.reason] += 1;
            return null;
          }),
        );

  /**
   * Collects index writes into transactions of bounded cost. A replaced or
   * removed document is marked pending, its passages are cleared in slices,
   * and only the last step gives it its real revision.
   */
  const makeWriter = (projectId: ProjectId, index: KnowledgeIndex) => {
    let batch: KnowledgeWrite[] = [];
    let cost = 0;
    let wrote = false;
    const flush = Effect.gen(function* () {
      if (batch.length === 0) return;
      yield* pauseWhenDiskCritical;
      const writes = batch;
      batch = [];
      cost = 0;
      yield* timed(projectId, "write", () => index.write(writes));
      wrote = true;
      yield* Effect.yieldNow;
      for (let step = 0; step < FLUSH_MERGE_STEPS; step += 1) {
        if (!(yield* timed(projectId, "merge", () => index.merge(MERGE_PAGES)))) break;
        yield* Effect.yieldNow;
      }
    });
    const push = (write: KnowledgeWrite, weight: number) =>
      Effect.suspend(() => {
        batch.push(write);
        cost += weight;
        return cost >= BATCH_COST ? flush : Effect.void;
      });
    const clear = (stored: KnowledgeDocumentRow) =>
      Effect.gen(function* () {
        yield* push(
          {
            type: "revision",
            id: stored.id,
            revision: PENDING_REVISION,
            modifiedAt: stored.modifiedAt,
          },
          1,
        );
        for (let left = stored.chunks; left > 0; left -= CHUNK_SLICE)
          yield* push(
            { type: "clearChunks", id: stored.id, limit: CHUNK_SLICE },
            Math.min(left, CHUNK_SLICE),
          );
      });
    return {
      push,
      remove: (stored: KnowledgeDocumentRow) =>
        Effect.gen(function* () {
          yield* clear(stored);
          yield* push({ type: "deleteDocument", id: stored.id }, 1);
        }),
      replace: (
        stored: KnowledgeDocumentRow | undefined,
        document: KnowledgeDocument,
        chunks: readonly KnowledgeChunk[],
      ) =>
        Effect.gen(function* () {
          if (stored) yield* clear(stored);
          yield* push(
            { type: "document", document: { ...document, revision: PENDING_REVISION } },
            1 + Math.floor(document.characters / DOCUMENT_COST_CHARACTERS),
          );
          for (let start = 0; start < chunks.length; start += CHUNK_SLICE) {
            const slice = chunks.slice(start, start + CHUNK_SLICE);
            yield* push({ type: "chunks", document, chunks: slice, ordinal: start }, slice.length);
          }
          yield* push(
            {
              type: "revision",
              id: document.id,
              revision: document.revision,
              modifiedAt: document.modifiedAt,
            },
            1,
          );
        }),
      /** Writes what is left, then merges the full-text index and returns free pages in bounded steps. */
      finish: Effect.gen(function* () {
        yield* flush;
        if (!wrote) return;
        for (let step = 0; step < MERGE_STEPS; step += 1) {
          if (!(yield* timed(projectId, "merge", () => index.merge(MERGE_PAGES)))) break;
          yield* Effect.yieldNow;
        }
        for (let step = 0; step < VACUUM_STEPS; step += 1) {
          if (!(yield* timed(projectId, "vacuum", () => index.vacuum(VACUUM_PAGES)))) break;
          yield* Effect.yieldNow;
        }
        yield* timed(projectId, "checkpoint", () => index.checkpoint());
      }),
    };
  };

  /**
   * Keeps every project's index together under the disk budget: the least
   * recently used files go first, and their projects rebuild on next use.
   */
  const enforceBudget = (current: ProjectId) =>
    Effect.sync(() => {
      const names = NodeFS.existsSync(directory)
        ? NodeFS.readdirSync(directory).filter((name) => name.endsWith(".sqlite"))
        : [];
      const owners = new Map(
        [...entries].map(([projectId, entry]) => [
          NodePath.basename(indexFile(projectId)),
          { projectId, entry },
        ]),
      );
      const files = names.map((name) => {
        const file = NodePath.join(directory, name);
        const stat = fileStat(file);
        const owner = owners.get(name);
        return {
          file,
          owner,
          bytes: (stat?.size ?? 0) + (fileStat(`${file}-wal`)?.size ?? 0),
          usedAt: owner?.entry.usedAt || stat?.mtimeMs || 0,
        };
      });
      let total = files.reduce((sum, file) => sum + file.bytes, 0);
      let evicted = 0;
      const order = files
        .filter((file) => file.owner?.projectId !== current)
        .sort((left, right) => left.usedAt - right.usedAt);
      for (const file of order) {
        if (total <= budgetBytes) break;
        if (file.owner) {
          closeIndex(file.owner.entry);
          // The view stays for threads; the next use rebuilds, archived or not, and searches wait for it.
          file.owner.entry.rebuildRequested = true;
          file.owner.entry.changes += 1;
        }
        removeFiles(file.file);
        total -= file.bytes;
        evicted += 1;
      }
      return evicted;
    }).pipe(
      Effect.flatMap((evicted) =>
        evicted > 0
          ? Effect.logInfo("Project knowledge indexes removed to stay under the disk budget", {
              evicted,
            })
          : Effect.void,
      ),
    );

  const refresh = (projectId: ProjectId, entry: Entry) =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId);
      if (Option.isNone(project)) return yield* purge(projectId);
      const startedAt = yield* Clock.currentTimeMillis;
      if (entry.rebuilding) {
        closeIndex(entry);
        removeFiles(indexFile(projectId));
      } else loadPersisted(projectId, entry);
      // An archived project keeps the index it has; Rebuild index still runs, and a removed file is rebuilt.
      if (
        project.value.workspaceSettings?.archived &&
        entry.mode !== null &&
        !entry.rebuilding &&
        (entry.index !== null || NodeFS.existsSync(indexFile(projectId)))
      ) {
        entry.scannedAt = startedAt;
        return;
      }
      yield* pauseWhenDiskCritical;
      const memory = yield* sql<{
        name: string;
        revision: number;
        updatedAt: string;
        byteLength: number;
      }>`SELECT name, revision, updated_at AS "updatedAt", byte_length AS "byteLength" FROM project_memory WHERE project_id = ${projectId} AND name <> 'MEMORY.md' ORDER BY updated_at DESC, name`;
      const scan = yield* Effect.tryPromise(() =>
        scanKnowledgeFiles(project.value.workspaceRoot, guard),
      ).pipe(Effect.orElseSucceed((): KnowledgeScan => ({ files: [], complete: false })));
      const files = scan.files;
      const problem = scan.complete ? null : SCAN_PROBLEM;
      // A project with nothing to index gets no file.
      if (
        memory.length === 0 &&
        files.length === 0 &&
        !entry.index &&
        !NodeFS.existsSync(indexFile(projectId))
      ) {
        entry.mode = "empty";
        entry.view = null;
        entry.totals = {
          documents: 0,
          characters: 0,
          bytes: 0,
          inlineCharacters: 0,
          sources: [],
          skipped: EMPTY_SKIPPED,
          indexedAt: isoAt(startedAt),
          problem,
        };
        entry.scannedAt = startedAt;
        return;
      }
      const index = openIndex(projectId, entry, true);
      if (!index) return;
      const existing = new Map(index.documents().map((document) => [document.id, document]));
      const { accepted, skipped } = selectCandidates([
        ...memory.map((file): Candidate => ({
          source: "memory",
          id: `memory:${file.name}`,
          name: file.name,
          revision: `r${file.revision}`,
          size: file.byteLength,
          modifiedAt: file.updatedAt,
        })),
        ...files.map((file): Candidate => ({
          source: "file",
          id: file.id,
          file,
          revision: `${Math.trunc(file.modifiedMs)}:${file.size}:${placement(file)}`,
          size: file.size,
          modifiedAt: isoAt(file.modifiedMs),
        })),
      ]);
      const keep = new Set(accepted.map((candidate) => candidate.id));
      const writer = makeWriter(projectId, index);
      // After a partial scan a file it missed may still exist, so only what is known gone is removed.
      for (const stored of existing.values())
        if (
          !keep.has(stored.id) &&
          (scan.complete || stored.kind === "memory" || stored.revision === PENDING_REVISION)
        )
          yield* writer.remove(stored);
      let bytes = 0;
      for (const candidate of accepted) {
        const stored = existing.get(candidate.id);
        if (stored?.revision === candidate.revision) {
          bytes += candidate.size;
          continue;
        }
        const content = yield* readContent(projectId, candidate, skipped);
        if (content === null) {
          if (stored) yield* writer.remove(stored);
          continue;
        }
        bytes += candidate.size;
        const digest = sha256([content], "hex");
        const document = documentFor(candidate, content, digest);
        if (
          stored &&
          stored.revision !== PENDING_REVISION &&
          stored.sha256 === digest &&
          sameDescription(stored, document)
        ) {
          yield* writer.push(
            {
              type: "revision",
              id: candidate.id,
              revision: candidate.revision,
              modifiedAt: candidate.modifiedAt,
            },
            1,
          );
        } else {
          // A new title is in every passage's searchable title, so the passages are written again.
          const markdown = candidate.source === "memory" || isMarkdownLocation(document.location);
          yield* writer.replace(stored, document, chunkKnowledgeText(content, markdown));
        }
      }
      yield* writer.finish;

      const chosen = chooseView(index, project.value.workspaceRoot, entry.mode);
      const totals: Totals = {
        ...chosen.totals,
        bytes,
        skipped,
        indexedAt: isoAt(startedAt),
        problem,
      };
      index.setMeta({
        mode: chosen.mode,
        view: stringifyJson(chosen.view),
        totals: stringifyJson(totals),
        scanned_at: String(startedAt),
      });
      entry.mode = chosen.mode;
      entry.view = chosen.view;
      entry.totals = totals;
      entry.scannedAt = startedAt;
      yield* enforceBudget(projectId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
          const error = Cause.squash(cause);
          const paused = error instanceof KnowledgePaused;
          // A damaged file is replaced by the next refresh; other failures keep it.
          if (isDamaged(error)) {
            closeIndex(entry);
            removeFiles(indexFile(projectId));
          }
          entry.scannedAt = yield* Clock.currentTimeMillis;
          entry.mode ??= "empty";
          entry.totals = {
            documents: entry.totals?.documents ?? 0,
            characters: entry.totals?.characters ?? 0,
            bytes: entry.totals?.bytes ?? 0,
            inlineCharacters: entry.totals?.inlineCharacters ?? 0,
            sources: entry.totals?.sources ?? [],
            skipped: entry.totals?.skipped ?? EMPTY_SKIPPED,
            indexedAt: entry.totals?.indexedAt ?? null,
            problem: paused ? DISK_PROBLEM : REFRESH_PROBLEM,
          };
          if (!paused)
            yield* Effect.logWarning("Project knowledge refresh failed", { projectId, cause });
        }),
      ),
    );

  const runJob = (job: Job) =>
    Effect.gen(function* () {
      if (job.kind === "purge") return yield* purge(job.projectId);
      const entry = entries.get(job.projectId);
      if (!entry) return;
      entry.queued = false;
      entry.running = true;
      entry.rebuilding = entry.rebuildRequested;
      entry.rebuildRequested = false;
      entry.startedFrom = entry.changes;
      yield* refresh(job.projectId, entry).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            entry.running = false;
            entry.rebuilding = false;
            entry.covered = Math.max(entry.covered, entry.startedFrom);
            const idle = entry.queued ? null : entry.idle;
            if (idle) entry.idle = null;
            return idle ? Deferred.succeed(idle, undefined) : Effect.void;
          }),
        ),
      );
    });

  const worker = yield* makeDrainableWorker(runJob);

  const enqueue = (projectId: ProjectId): Effect.Effect<void> =>
    Effect.suspend(() => {
      const entry = entryFor(projectId);
      if (entry.queued) return Effect.void;
      entry.queued = true;
      entry.idle ??= Deferred.makeUnsafe<void>();
      return worker.enqueue({ kind: "refresh", projectId });
    });

  /** Queues a refresh when nothing is known yet, a change is pending or the view is old. */
  const refreshIfDue = (projectId: ProjectId, entry: Entry) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const changed = entry.changes > (entry.running ? entry.startedFrom : entry.covered);
      const due = !entry.running && (entry.mode === null || now - entry.scannedAt > FRESH_MS);
      if (changed || due) yield* enqueue(projectId);
    });

  /**
   * Loads what is known and starts a refresh when due. A first index is
   * waited for up to `first`, and a known change, such as a memory write, up
   * to READY_WAIT. A rebuild keeps the last view, so only a search, which
   * needs the new index, waits for one.
   */
  const prepared = (projectId: ProjectId, first: Duration.Input, waitForRebuild: boolean) =>
    Effect.gen(function* () {
      const entry = entryFor(projectId);
      yield* touch(entry);
      loadPersisted(projectId, entry);
      yield* refreshIfDue(projectId, entry);
      const rebuilding = entry.rebuildRequested || entry.rebuilding;
      const wait =
        entry.mode === null || (rebuilding && waitForRebuild)
          ? first
          : entry.covered < entry.changes && !rebuilding
            ? READY_WAIT
            : null;
      if (wait !== null && entry.idle)
        yield* Deferred.await(entry.idle).pipe(Effect.timeoutOption(wait));
      return entry;
    });

  /** A damaged file found by a request is rebuilt by the queue, never closed under a refresh. */
  const requestRebuild = (projectId: ProjectId, entry: Entry, error: KnowledgeIndexFailure) =>
    isDamaged(error)
      ? Effect.suspend(() => {
          entry.rebuildRequested = true;
          entry.changes += 1;
          return enqueue(projectId);
        })
      : Effect.void;

  const statusOf = (projectId: ProjectId, entry: Entry): ProjectKnowledgeStatus => {
    const totals = entry.totals;
    return {
      projectId,
      mode: entry.mode ?? "empty",
      state:
        entry.rebuildRequested ||
        entry.rebuilding ||
        (entry.mode === null && (entry.queued || entry.running))
          ? "indexing"
          : entry.mode === null
            ? "unindexed"
            : totals?.problem
              ? "failed"
              : "ready",
      documents: totals?.documents ?? 0,
      characters: totals?.characters ?? 0,
      inlineCharacters: totals?.inlineCharacters ?? 0,
      inlineLimit: PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
      inlineReturnLimit: PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
      bytes: totals?.bytes ?? 0,
      capacityBytes: PROJECT_KNOWLEDGE_MAX_BYTES,
      capacityDocuments: PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
      sources: totals?.sources ?? [],
      skipped: totals?.skipped ?? EMPTY_SKIPPED,
      indexedAt: totals?.indexedAt ?? null,
      problem: totals?.problem ?? null,
    };
  };

  const view = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const entry = entryFor(projectId);
      yield* touch(entry);
      loadPersisted(projectId, entry);
      yield* refreshIfDue(projectId, entry);
      return entry.mode === "empty" ? null : entry.view;
    });

  const status = (input: ProjectKnowledgeStatusInput) =>
    requireProject(input.projectId).pipe(
      Effect.andThen(prepared(input.projectId, READY_WAIT, false)),
      Effect.map((entry) => statusOf(input.projectId, entry)),
    );

  const search = (input: ProjectKnowledgeSearchInput) =>
    Effect.gen(function* () {
      const project = yield* requireProject(input.projectId);
      const entry = yield* prepared(input.projectId, SEARCH_FIRST_BUILD_WAIT, true);
      const base = statusOf(input.projectId, entry);
      const empty = {
        projectId: input.projectId,
        mode: base.mode,
        state: base.state,
        results: [],
        truncated: false,
      };
      const match = knowledgeMatchExpression(input.query);
      if (match === null) return empty;
      const limit = clamp(
        input.limit,
        PROJECT_KNOWLEDGE_SEARCH_DEFAULT_RESULTS,
        PROJECT_KNOWLEDGE_SEARCH_MAX_RESULTS,
      );
      const pattern = withinPattern(input.within, project.workspaceRoot);
      // One synchronous step, so the queue cannot close the index between the search and its reads.
      const found = yield* timed(input.projectId, "search", () => {
        const index = openIndex(input.projectId, entry, false);
        if (index === null) return null;
        // One row past the limit says whether more passages matched.
        const picked = index.search(match, pattern, {
          candidates: pattern === "%" ? SEARCH_CANDIDATES : -1,
          perDocument: CHUNKS_PER_DOCUMENT,
          limit: limit + 1,
        });
        const documents = new Map<string, KnowledgeDocument | undefined>();
        for (const candidate of picked.slice(0, limit))
          if (!documents.has(candidate.documentId))
            documents.set(candidate.documentId, index.document(candidate.documentId));
        return { picked, documents };
      }).pipe(
        Effect.tapError((error) => requestRebuild(input.projectId, entry, error)),
        Effect.mapError(() => failed(input.projectId, "operation_failed")),
      );
      if (found === null) return empty;
      let remaining = RESULT_TEXT_CHARACTERS;
      const results: ProjectKnowledgeSearchHit[] = [];
      for (const candidate of found.picked.slice(0, limit)) {
        const document = found.documents.get(candidate.documentId);
        if (!document) continue;
        const passage = document.content.slice(
          candidate.start,
          boundedEnd(document.content, candidate.end),
        );
        // Past the text budget a hit keeps its place but not its passage; read fetches it.
        const excerpt = passage.length <= remaining ? passage : "";
        remaining -= excerpt.length;
        results.push({
          documentId: document.id,
          title: document.title,
          location: document.location,
          kind: document.kind,
          heading: candidate.heading,
          excerpt,
          offset: candidate.start,
          modifiedAt: document.modifiedAt,
          score: Math.round(-candidate.score * 10_000) / 10_000,
        });
      }
      return { ...empty, results, truncated: found.picked.length > limit };
    });

  const read = (input: ProjectKnowledgeReadInput) =>
    Effect.gen(function* () {
      yield* requireProject(input.projectId);
      const entry = entryFor(input.projectId);
      yield* touch(entry);
      const document = yield* timed(input.projectId, "read", () =>
        openIndex(input.projectId, entry, false)?.document(input.documentId),
      ).pipe(
        Effect.tapError((error) => requestRebuild(input.projectId, entry, error)),
        Effect.mapError(() => failed(input.projectId, "operation_failed")),
      );
      if (!document) return yield* failed(input.projectId, "not_found");
      const total = document.content.length;
      const offset = Math.min(Math.max(0, Math.trunc(input.offset ?? 0)), total);
      const cut = boundedEnd(
        document.content,
        offset +
          clamp(
            input.limit,
            PROJECT_KNOWLEDGE_READ_PAGE_CHARACTERS,
            PROJECT_KNOWLEDGE_READ_PAGE_CHARACTERS,
          ),
      );
      // A page too short for the surrogate pair it starts on takes the whole pair, so paging always moves on.
      const end = cut > offset || offset >= total ? cut : boundedEnd(document.content, offset + 2);
      return {
        projectId: input.projectId,
        documentId: document.id,
        title: document.title,
        location: document.location,
        kind: document.kind,
        content: document.content.slice(offset, end),
        offset,
        nextOffset: end < total ? end : null,
        totalCharacters: total,
      };
    });

  /** Rebuilds from an empty file; threads keep the last view until the new one is ready. */
  const reindex = (input: ProjectKnowledgeReindexInput) =>
    Effect.gen(function* () {
      yield* requireProject(input.projectId);
      const entry = entryFor(input.projectId);
      // A rebuild already waiting or running answers a second request too.
      if (!entry.rebuildRequested && !entry.rebuilding) {
        entry.rebuildRequested = true;
        entry.changes += 1;
        yield* enqueue(input.projectId);
      }
      return statusOf(input.projectId, entry);
    });

  const markDirty = (projectId: ProjectId) =>
    Effect.suspend(() => {
      entryFor(projectId).changes += 1;
      return enqueue(projectId);
    });

  // A deleted project loses its index once the deletion commits; a moved folder is rescanned.
  yield* forkParked(
    Effect.gen(function* () {
      const after = yield* events.latestApplicationSequence;
      yield* Stream.runForEach(
        events.streamApplicationEvents({ afterSequence: after }),
        (event) => {
          if (!("aggregateKind" in event)) return Effect.void;
          if (event.type === "project.deleted")
            return worker.enqueue({ kind: "purge", projectId: event.aggregateId });
          if (
            event.type === "project.meta-updated" &&
            event.payload.workspaceRoot !== undefined &&
            entries.has(event.aggregateId)
          )
            return markDirty(event.aggregateId);
          return Effect.void;
        },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Project knowledge event watch stopped", { cause }),
      ),
    ),
  );

  // At startup: index files of projects that no longer exist, and indexes two
  // or more schema versions old, are removed. The previous version is kept so
  // a downgrade does not rebuild.
  yield* forkParked(
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        const folders = NodeFS.existsSync(knowledgeRoot) ? NodeFS.readdirSync(knowledgeRoot) : [];
        for (const name of folders) {
          const version = /^v(\d+)$/.exec(name);
          if (version && Number(version[1]) < KNOWLEDGE_SCHEMA_VERSION - 1)
            NodeFS.rmSync(NodePath.join(knowledgeRoot, name), { recursive: true, force: true });
        }
      });
      const names = yield* Effect.sync(() =>
        NodeFS.existsSync(directory)
          ? NodeFS.readdirSync(directory).filter((name) => name.endsWith(".sqlite"))
          : [],
      );
      if (names.length === 0) return;
      const live = yield* projects.list({ includeDeleted: false });
      const known = new Set(live.map((project) => `${sha256([project.projectId], "hex")}.sqlite`));
      for (const name of names)
        if (!known.has(name)) yield* Effect.sync(() => removeFiles(NodePath.join(directory, name)));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Project knowledge cleanup failed", { cause }),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of entries.values()) closeIndex(entry);
    }),
  );

  return ProjectKnowledge.of({
    view,
    ready: (projectId) => prepared(projectId, READY_WAIT, false).pipe(Effect.ignoreCause),
    markDirty,
    status,
    search,
    read,
    reindex,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ProjectKnowledge, make);
