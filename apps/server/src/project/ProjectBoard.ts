// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over the project's SpecWeave folder, like ThreadIncrementProgress.
/**
 * The project's increments as a board (`projects.board`): one card per
 * increment, in the column its files put it in.
 *
 * Each increment is read from its newest copy: the project folder (the
 * planning root), a linked worktree of its repository, or the remote's
 * default branch as last fetched (IncrementCopies.ts holds the rule and the
 * cost). A card built from another copy than the project folder's says so in
 * `source`.
 *
 * No CLI and no network; Git runs only when the remote branch's commit
 * changes. Folder names come from one readdir per checkout.
 * Each `metadata.json` is parsed once until its mtime or size changes. The
 * spec and ledger are read only for increments that are still open and for
 * the Done cards actually returned, and folded once until one of them changes
 * or a running two-hour lease ends, so a board of a thousand closed increments costs one stat each.
 * A card lists the increment's recorded reviews (incrementReview): one stat for
 * an increment without `reports/`, two for one whose review folders hold none,
 * and the review files read again only when one of them changes.
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
  parseSpecweaveSpec,
  type SpecweaveTaskHolder,
} from "../mods/SpecweaveProgress.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import { ledgerAuthorFamily, readIncrementReviews } from "../review/incrementReview.ts";
import {
  boardStatus,
  chooseCopy,
  copyIds,
  copyRoot,
  inBatches,
  openBoardCopies,
  prepareRemoteCopies,
  readCopyMeta,
  type BoardCopies,
  type BoardCopyOptions,
  type CopyMeta,
  type IncrementCopy,
} from "./IncrementCopies.ts";
import { compareNumbered, incrementRootFor, readBounded } from "./ThreadIncrementProgress.ts";
import { INCREMENTS_DIR } from "./ThreadReports.ts";

const SPEC_BYTES = 262_144;
const LEDGER_BYTES = 1_048_576;
const CACHE_ENTRIES = 20_000;
const CLOSED_TASK_STATES = new Set(["done", "skipped"]);
/** The folder names incrementIds lists, so a single read answers for the same set. */
const INCREMENT_FOLDER = /^\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;

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
  /**
   * The ledger's last event, which is newer than metadata.json while work
   * runs. Not the file's time: a checkout stamps every file as new.
   */
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

/** The time of the last ledger line that carries one, as an ISO time. */
export function ledgerLastAt(ledger: string): string | null {
  let end = ledger.length;
  for (let scanned = 0; end > 0 && scanned < 20; scanned += 1) {
    const start = ledger.lastIndexOf("\n", end - 1);
    const line = ledger.slice(start + 1, end).trim();
    end = start;
    if (line === "") {
      scanned -= 1;
      continue;
    }
    try {
      const at = (JSON.parse(line) as { at?: unknown } | null)?.at;
      const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
      if (!Number.isNaN(time)) return new Date(time).toISOString();
    } catch {
      // A torn or foreign line: the one before it may still tell.
    }
  }
  return null;
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
    ledgerAt: ledgerText === null ? null : ledgerLastAt(ledgerText),
    authorFamily: ledgerAuthorFamily(ledgerText),
    leaseEndsAt,
  });
}

export { boardStatus, type BoardStatus } from "./IncrementCopies.ts";

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

/** A copy whose files cannot be read (a remote copy with no cache folder): its status alone. */
const NO_DETAIL: Detail = {
  total: 0,
  done: 0,
  finished: 0,
  active: 0,
  blockedTasks: 0,
  blockers: [],
  pullRequests: [],
  hasSpec: false,
  ledgerAt: null,
  authorFamily: null,
  leaseEndsAt: null,
};

/** A card and the root its copy was read from (null when its files could not be read). */
export interface BuiltCard {
  readonly card: ProjectBoardCard;
  readonly root: string | null;
}

/** The project folder's copy of an increment shown from another copy, or null. */
export function projectReviewFolder(
  copies: BoardCopies,
  id: string,
  copy: IncrementCopy,
): string | null {
  return copy.kind !== "project" && copies.projectIds.has(id)
    ? NodePath.join(copies.root, INCREMENTS_DIR, id)
    : null;
}

/**
 * One increment's card from its chosen copy. The board list and the increment
 * view both build cards here, so the same increment never shows two different
 * cards.
 */
async function buildCard(
  copies: BoardCopies,
  id: string,
  chosen: IncrementCopy,
  now: number,
): Promise<BuiltCard> {
  const detailOf = (root: string | null) =>
    root === null
      ? Promise.resolve(NO_DETAIL)
      : readDetail(root, NodePath.join(root, INCREMENTS_DIR, id), now);
  const copy = chosen;
  const root = await copyRoot(copies, id, copy);
  const detail = await detailOf(root);
  const meta = copy.meta;
  const folder = root === null ? null : NodePath.join(root, INCREMENTS_DIR, id);
  // Review records are often written to the project folder while the spec
  // lives elsewhere: both copies' records count, newest first.
  // The project folder's copy is always read as the other copy, links not
  // followed, also when the shown copy's files could not be read.
  const projectFolder = projectReviewFolder(copies, id, copy);
  // After the detail: its ledger author stands in for review records that name none.
  const reviews = await readIncrementReviews(
    folder,
    detail.authorFamily,
    projectFolder === null ? [] : [projectFolder],
  );
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
  const card: ProjectBoardCard = {
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
    specPath: detail.hasSpec && folder !== null ? NodePath.join(folder, "spec.md") : null,
    ...(reviews.length === 0 ? {} : { reviews: [...reviews] }),
    ...(copy.kind === "project" || copy.name === null
      ? {}
      : {
          source: {
            kind: copy.kind,
            name: copy.name.slice(0, 200),
            ...(copy.kind === "remote" ? { fetchedAt: copies.fetchedAt } : {}),
          },
        }),
  };
  return { card, root };
}

/** The planning root's copies: the project folder, its worktrees and the remote branch. */
export async function boardCopiesFor(
  workspaceRoot: string,
  options: BoardCopyOptions = {},
): Promise<BoardCopies> {
  return openBoardCopies(await incrementRootFor(workspaceRoot, null), options);
}

/**
 * One increment's card, exactly as the board shows it, for the increment
 * view, with the root its copy was read from. Unlike the board it also
 * answers for a dropped increment, in the Done column. Null when no copy
 * holds the increment.
 */
export async function readBoardCard(
  copies: BoardCopies,
  incrementId: string,
  now: number,
): Promise<BuiltCard | null> {
  // Only what the board lists: an increment folder name (never "", ".." or a
  // path). Each checkout lists real folders only, not a link that may lead
  // out of its root.
  if (!INCREMENT_FOLDER.test(incrementId)) return null;
  const copy = await chooseCopy(copies, incrementId);
  return copy === null ? null : buildCard(copies, incrementId, copy, now);
}

const newestFirst = (left: ProjectBoardCard, right: ProjectBoardCard) =>
  (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
  compareNumbered(right.incrementId, left.incrementId);

export async function readProjectBoard(
  workspaceRoot: string,
  input: {
    readonly query?: string;
    readonly doneLimit?: number;
    readonly now: number;
  } & BoardCopyOptions,
): Promise<Omit<ProjectBoardResult, "projectId">> {
  const copies = await boardCopiesFor(workspaceRoot, input);
  const root = copies.root;
  const projectIds = [...copies.projectIds];
  const projectMetas = new Map<string, CopyMeta>();
  (
    await inBatches(projectIds, (id) => readCopyMeta(root, NodePath.join(root, INCREMENTS_DIR, id)))
  ).forEach((meta, index) => projectMetas.set(projectIds[index]!, meta));
  const ids = copyIds(copies);
  const chosen = await inBatches(ids, (id) => chooseCopy(copies, id, projectMetas.get(id)));
  const words = (input.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const open: Array<{ id: string; copy: IncrementCopy }> = [];
  const closed: Array<{ id: string; copy: IncrementCopy }> = [];
  let notDone = 0;
  ids.forEach((id, index) => {
    const copy = chosen[index];
    if (copy === null || copy === undefined) return;
    const meaning = boardStatus(copy.meta.status);
    if (meaning === "dropped") return;
    if (meaning !== "completed") notDone += 1;
    const haystack = `${id} ${copy.meta.title ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return;
    (meaning === "completed" ? closed : open).push({ id, copy });
  });
  const doneLimit = Math.min(
    PROJECT_BOARD_DONE_MAX,
    Math.max(1, Math.floor(input.doneLimit ?? PROJECT_BOARD_DONE_DEFAULT)),
  );
  const shownClosed = closed
    .toSorted(
      (left, right) =>
        (right.copy.meta.updatedAt ?? "").localeCompare(left.copy.meta.updatedAt ?? "") ||
        compareNumbered(right.id, left.id),
    )
    .slice(0, doneLimit);
  const shown = [...open, ...shownClosed];
  // Every remote copy the board shows is written with one Git call.
  await prepareRemoteCopies(
    copies,
    shown.filter(({ copy }) => copy.kind === "remote").map(({ id }) => id),
  );
  const cards = (
    await inBatches(shown, ({ id, copy }) => buildCard(copies, id, copy, input.now))
  ).map((built) => built.card);
  const counts = { planned: 0, active: 0, review: 0, done: closed.length };
  for (const card of cards) if (card.column !== "done") counts[card.column] += 1;
  return {
    cards: cards.toSorted(newestFirst),
    counts,
    detail: true,
    notDone,
    ...(copies.behind === null ? {} : { behind: copies.behind }),
  };
}
