// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over the project's SpecWeave folder, like ThreadIncrementProgress.
/**
 * The project's increments as a board (`projects.board`): one card per
 * increment folder in the planning root, in the column its files put it in.
 *
 * Files only: no CLI, no Git, no network. Folder names come from one readdir.
 * Each `metadata.json` is parsed once until its mtime or size changes. The
 * spec and ledger are read only for increments that are still open and for
 * the Done cards actually returned, and folded once until one of them changes
 * or a running two-hour lease ends, so a board of a thousand closed increments costs one stat each.
 * A card lists the increment's recorded reviews (incrementReview), read again
 * only when a review file changes.
 */
import * as NodeFSP from "node:fs/promises";

import {
  PROJECT_BOARD_CARD_BLOCKERS,
  PROJECT_BOARD_DONE_DEFAULT,
  PROJECT_BOARD_DONE_MAX,
  PROJECT_BOARD_PULL_REQUESTS,
  type ProjectBoardBlocker,
  type ProjectBoardCard,
  type ProjectBoardColumn,
  type ProjectBoardColumnReason,
  type ProjectBoardResult,
} from "@specweave-studio/contracts";

import {
  foldSpecweaveLedger,
  parseIncrementMetadata,
  parseSpecweaveSpec,
  type SpecweaveTaskHolder,
} from "../mods/SpecweaveProgress.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import { ledgerAuthorFamily, readIncrementReviews } from "../review/incrementReview.ts";
import { incrementIds, incrementRootFor, readBounded } from "./ThreadIncrementProgress.ts";
import { INCREMENTS_DIR } from "./ThreadReports.ts";

const SPEC_BYTES = 262_144;
const LEDGER_BYTES = 1_048_576;
const SMALL_BYTES = 524_288;
const PAUSED_REASON_CHARS = 300;
const READ_BATCH = 64;
const CACHE_ENTRIES = 20_000;
const CLOSED_TASK_STATES = new Set(["done", "skipped"]);
/** The folder names incrementIds lists, so a single read answers for the same set. */
const INCREMENT_FOLDER = /^\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;

interface Meta {
  readonly title: string | null;
  readonly status: string;
  readonly updatedAt: string | null;
  readonly pausedReason: string | null;
}
interface Detail {
  readonly total: number;
  /** Done or skipped. */
  readonly done: number;
  /** Done only: a skip is not evidence that work started. */
  readonly finished: number;
  /** Claimed inside the two-hour lease. */
  readonly active: number;
  readonly blockedTasks: number;
  /** The first blocked tasks in spec order. */
  readonly blockers: ReadonlyArray<ProjectBoardBlocker>;
  readonly pullRequests: ReadonlyArray<string>;
  readonly hasSpec: boolean;
  /** The ledger's last write, which is newer than metadata.json while work runs. */
  readonly ledgerAt: string | null;
  /** The family that did most of the work by the ledger, for reviews that name no author. */
  readonly authorFamily: string | null;
  /**
   * When the first running lease ends, in epoch milliseconds. A claim turns
   * stale and a block loses its owner then without any file changing, so the
   * cached fold is only good until that moment.
   */
  readonly leaseEndsAt: number | null;
}

/** Parsed files by path, valid while the signature (mtime and size of what they read) holds. */
const metaCache = new Map<string, { signature: string; value: Meta }>();
const detailCache = new Map<string, { signature: string; value: Detail }>();

function remember<V>(
  cache: Map<string, { signature: string; value: V }>,
  key: string,
  signature: string,
  value: V,
): V {
  cache.delete(key);
  cache.set(key, { signature, value });
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

async function signatureOf(file: string): Promise<{ signature: string; mtimeMs: number | null }> {
  const stat = await NodeFSP.stat(file).catch(() => null);
  return stat === null
    ? { signature: "-", mtimeMs: null }
    : { signature: `${stat.mtimeMs}:${stat.size}`, mtimeMs: stat.mtimeMs };
}

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

async function readMeta(root: string, folder: string): Promise<Meta> {
  const file = NodePath.join(folder, "metadata.json");
  const { signature } = await signatureOf(file);
  const cached = metaCache.get(file);
  if (cached?.signature === signature) return cached.value;
  const metadata =
    signature === "-" ? {} : parseIncrementMetadata(await readBounded(root, file, SMALL_BYTES));
  return remember(metaCache, file, signature, {
    title:
      typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : null,
    status:
      typeof metadata.status === "string" && metadata.status.trim()
        ? metadata.status.trim().toLowerCase()
        : "unknown",
    updatedAt:
      isoOrNull(metadata.lastActivity) ??
      isoOrNull(metadata.updated) ??
      isoOrNull(metadata.created),
    pausedReason:
      typeof metadata.pausedReason === "string" && metadata.pausedReason.trim()
        ? metadata.pausedReason.trim().slice(0, PAUSED_REASON_CHARS)
        : null,
  });
}

/** GitHub pull requests a ledger names, the last mentioned first, each once. */
export function ledgerPullRequests(ledger: string): string[] {
  const seen = new Set<string>();
  for (const match of ledger.match(PULL_REQUEST) ?? []) {
    seen.delete(match);
    seen.add(match);
  }
  return [...seen].toReversed().slice(0, PROJECT_BOARD_PULL_REQUESTS);
}

async function readDetail(root: string, folder: string, now: number): Promise<Detail> {
  const specPath = NodePath.join(folder, "spec.md");
  const tasksPath = NodePath.join(folder, "tasks.md");
  const ledgerPath = NodePath.join(folder, "ledger.jsonl");
  const [spec, tasks, ledger] = await Promise.all([
    signatureOf(specPath),
    signatureOf(tasksPath),
    signatureOf(ledgerPath),
  ]);
  const signature = `${spec.signature}|${tasks.signature}|${ledger.signature}`;
  const cached = detailCache.get(folder);
  // The fold calls a lease running up to and including its end, so the entry holds until then.
  if (
    cached?.signature === signature &&
    (cached.value.leaseEndsAt === null || now <= cached.value.leaseEndsAt)
  ) {
    return cached.value;
  }
  const [specText, tasksText, ledgerText] = await Promise.all([
    spec.mtimeMs === null ? null : readBounded(root, specPath, SPEC_BYTES),
    tasks.mtimeMs === null ? null : readBounded(root, tasksPath, SPEC_BYTES),
    ledger.mtimeMs === null ? "" : readBounded(root, ledgerPath, LEDGER_BYTES),
  ]);
  // Like SpecWeave's tasksFileFor: a legacy tasks.md, when present, holds the tasks.
  const source =
    tasksText !== null
      ? parseSpecweaveSpec(tasksText).tasks
      : specText !== null
        ? parseSpecweaveSpec(specText).tasks
        : [];
  // A ledger that exists but cannot be read must not fold as "nothing done".
  const fold =
    ledgerText === null || source.length === 0
      ? null
      : foldSpecweaveLedger(source, ledgerText, now);
  const folded = (fold?.tasks ?? []).filter((task) =>
    source.some((planned) => planned.id === task.id),
  );
  const holders: ReadonlyMap<string, SpecweaveTaskHolder> = fold?.holders ?? new Map();
  const blocked = folded.filter((task) => task.status === "blocked");
  let leaseEndsAt: number | null = null;
  for (const holder of holders.values()) {
    if (holder.leased && (leaseEndsAt === null || holder.leaseEndsAt < leaseEndsAt)) {
      leaseEndsAt = holder.leaseEndsAt;
    }
  }
  return remember(detailCache, folder, signature, {
    total: source.length,
    done: folded.filter((task) => CLOSED_TASK_STATES.has(task.status)).length,
    finished: folded.filter((task) => task.status === "done").length,
    active: folded.filter((task) => task.status === "claimed").length,
    blockedTasks: blocked.length,
    blockers: blocked.slice(0, PROJECT_BOARD_CARD_BLOCKERS).map((task) => {
      const holder = holders.get(task.id);
      return {
        taskId: task.id,
        title: task.title,
        note: task.note,
        by: holder?.owner ?? null,
        at: holder?.at ?? task.changedAt ?? null,
        leased: holder?.leased ?? false,
      } satisfies ProjectBoardBlocker;
    }),
    pullRequests: ledgerText === null ? [] : ledgerPullRequests(ledgerText),
    hasSpec: specText !== null,
    ledgerAt: ledger.mtimeMs === null ? null : new Date(ledger.mtimeMs).toISOString(),
    authorFamily: ledgerAuthorFamily(ledgerText),
    leaseEndsAt,
  });
}

async function inBatches<A, B>(items: ReadonlyArray<A>, read: (item: A) => Promise<B>) {
  const results: B[] = [];
  for (let start = 0; start < items.length; start += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(start, start + READ_BATCH).map(read))));
  }
  return results;
}

/**
 * What a `metadata.json` status means for the board, across the spellings
 * older increments and other tools wrote (`in_progress`, `done`, `cancelled`).
 * `dropped` increments are left off the board.
 */
export type BoardStatus = "planned" | "active" | "paused" | "review" | "completed" | "dropped";
const STATUS_MEANINGS: Readonly<Record<string, BoardStatus>> = {
  active: "active",
  "in-progress": "active",
  started: "active",
  paused: "paused",
  "ready-for-review": "review",
  "in-review": "review",
  review: "review",
  completed: "completed",
  complete: "completed",
  done: "completed",
  closed: "completed",
  abandoned: "dropped",
  cancelled: "dropped",
  canceled: "dropped",
  superseded: "dropped",
  archived: "dropped",
};
export function boardStatus(status: string): BoardStatus {
  return (
    STATUS_MEANINGS[
      status
        .trim()
        .toLowerCase()
        .replaceAll(/[_\s]+/gu, "-")
    ] ?? "planned"
  );
}

/** What the ledger shows for an increment: tasks done (not skipped), blocked, and claimed inside the lease. */
export interface BoardEvidence {
  readonly finished: number;
  readonly blocked: number;
  readonly active: number;
}

/**
 * The column an increment sits in and why. The status file wins when it says
 * where the work is; when it still says planned, the ledger does, because
 * agents often start tasks without moving the status. A paused increment stays
 * in Active even with every task closed: it was stopped, not handed to review.
 */
export function boardPlacement(
  status: string,
  tasks: { readonly total: number; readonly done: number },
  evidence?: BoardEvidence,
): { column: ProjectBoardColumn; reason: ProjectBoardColumnReason } {
  const meaning = boardStatus(status);
  // A dropped increment is off the board; read alone it shows as closed.
  if (meaning === "completed" || meaning === "dropped") return { column: "done", reason: "status" };
  if (meaning === "paused") return { column: "active", reason: "status" };
  if (meaning === "review") return { column: "review", reason: "status" };
  if (tasks.total > 0 && tasks.done === tasks.total) return { column: "review", reason: "tasks" };
  if (meaning === "active") return { column: "active", reason: "status" };
  if (
    evidence !== undefined &&
    (evidence.finished > 0 || evidence.blocked > 0 || evidence.active > 0)
  ) {
    return { column: "active", reason: "ledger" };
  }
  return { column: "planned", reason: "status" };
}

/** The column an increment sits in, from its metadata status, task counts and ledger evidence. */
export function boardColumn(
  status: string,
  tasks: { readonly total: number; readonly done: number },
  evidence?: BoardEvidence,
): ProjectBoardColumn {
  return boardPlacement(status, tasks, evidence).column;
}

/**
 * One increment's card. The board list and the increment view both build
 * cards here, so the same increment never shows two different cards.
 */
async function buildCard(
  root: string,
  id: string,
  meta: Meta,
  now: number,
): Promise<ProjectBoardCard> {
  const folder = NodePath.join(root, INCREMENTS_DIR, id);
  const detail = await readDetail(root, folder, now);
  // After the detail: its ledger author stands in for review records that name none.
  const reviews = await readIncrementReviews(folder, detail.authorFamily);
  const meaning = boardStatus(meta.status);
  const closed = meaning === "completed" || meaning === "dropped";
  const paused = !closed && meaning === "paused";
  const { column, reason } = boardPlacement(
    meta.status,
    { total: detail.total, done: detail.done },
    { finished: detail.finished, blocked: detail.blockedTasks, active: detail.active },
  );
  const blockedTasks = closed ? 0 : detail.blockedTasks;
  const updatedAt =
    !closed && detail.ledgerAt !== null && detail.ledgerAt > (meta.updatedAt ?? "")
      ? detail.ledgerAt
      : meta.updatedAt;
  return {
    incrementId: id,
    title: meta.title,
    status: meta.status,
    column,
    tasks: {
      total: detail.total,
      done: detail.done,
      active: closed ? 0 : detail.active,
      finished: detail.finished,
    },
    blocked: blockedTasks > 0 || paused,
    paused,
    pausedReason: paused ? meta.pausedReason : null,
    blockedTasks,
    blockers: closed ? [] : [...detail.blockers],
    columnReason: reason,
    updatedAt,
    pullRequests: [...detail.pullRequests],
    specPath: detail.hasSpec ? NodePath.join(folder, "spec.md") : null,
    ...(reviews.length === 0 ? {} : { reviews: [...reviews] }),
  };
}

/**
 * One increment's card, exactly as the board shows it, for the increment
 * view. `root` is the resolved planning root. Unlike the board it also
 * answers for a dropped increment, in the Done column. Null when the folder
 * is not there.
 */
export async function readBoardCard(
  root: string,
  incrementId: string,
  now: number,
): Promise<ProjectBoardCard | null> {
  // Only what the board lists: an increment folder name (never "", ".." or a
  // path) naming a real folder, not a link that may lead out of the root.
  if (!INCREMENT_FOLDER.test(incrementId)) return null;
  const folder = NodePath.join(root, INCREMENTS_DIR, incrementId);
  const stat = await NodeFSP.lstat(folder).catch(() => null);
  if (stat === null || !stat.isDirectory()) return null;
  return buildCard(root, incrementId, await readMeta(root, folder), now);
}

const newestFirst = (left: ProjectBoardCard, right: ProjectBoardCard) =>
  (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
  right.incrementId.localeCompare(left.incrementId, undefined, { numeric: true });

export async function readProjectBoard(
  workspaceRoot: string,
  input: { readonly query?: string; readonly doneLimit?: number; readonly now: number },
): Promise<Omit<ProjectBoardResult, "projectId">> {
  const root = await incrementRootFor(workspaceRoot, null);
  const folderOf = (id: string) => NodePath.join(root, INCREMENTS_DIR, id);
  const ids = await incrementIds(root);
  const metas = await inBatches(ids, (id) => readMeta(root, folderOf(id)));
  const words = (input.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const open: Array<{ id: string; meta: Meta }> = [];
  const closed: Array<{ id: string; meta: Meta }> = [];
  ids.forEach((id, index) => {
    const meta = metas[index]!;
    const meaning = boardStatus(meta.status);
    if (meaning === "dropped") return;
    const haystack = `${id} ${meta.title ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return;
    (meaning === "completed" ? closed : open).push({ id, meta });
  });
  const doneLimit = Math.min(
    PROJECT_BOARD_DONE_MAX,
    Math.max(1, Math.floor(input.doneLimit ?? PROJECT_BOARD_DONE_DEFAULT)),
  );
  const shownClosed = closed
    .toSorted(
      (left, right) =>
        (right.meta.updatedAt ?? "").localeCompare(left.meta.updatedAt ?? "") ||
        right.id.localeCompare(left.id, undefined, { numeric: true }),
    )
    .slice(0, doneLimit);
  const cards = await inBatches([...open, ...shownClosed], ({ id, meta }) =>
    buildCard(root, id, meta, input.now),
  );
  const counts = { planned: 0, active: 0, review: 0, done: closed.length };
  for (const card of cards) if (card.column !== "done") counts[card.column] += 1;
  return { cards: cards.toSorted(newestFirst), counts, detail: true };
}
