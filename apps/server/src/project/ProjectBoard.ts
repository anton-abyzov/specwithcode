// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over the project's SpecWeave folder, like ThreadIncrementProgress.
/**
 * The project's increments as a board (`projects.board`): one card per
 * increment folder in the planning root, in the column its files put it in.
 *
 * Files only: no CLI, no Git, no network. Folder names come from one readdir.
 * Each `metadata.json` is parsed once until its mtime or size changes. The
 * spec and ledger are read only for increments that are still open and for
 * the Done cards actually returned, and folded once until one of them changes,
 * so a board of a thousand closed increments costs one stat each.
 */
import * as NodeFSP from "node:fs/promises";

import {
  PROJECT_BOARD_DONE_DEFAULT,
  PROJECT_BOARD_DONE_MAX,
  PROJECT_BOARD_PULL_REQUESTS,
  type ProjectBoardCard,
  type ProjectBoardColumn,
  type ProjectBoardResult,
} from "@specweave-studio/contracts";

import {
  foldSpecweaveLedger,
  parseIncrementMetadata,
  parseSpecweaveSpec,
} from "../mods/SpecweaveProgress.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import { incrementIds, incrementRootFor, readBounded } from "./ThreadIncrementProgress.ts";
import { INCREMENTS_DIR } from "./ThreadReports.ts";

const SPEC_BYTES = 262_144;
const LEDGER_BYTES = 1_048_576;
const SMALL_BYTES = 524_288;
const READ_BATCH = 64;
const CACHE_ENTRIES = 20_000;
const CLOSED_TASK_STATES = new Set(["done", "skipped"]);
const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;

interface Meta {
  readonly title: string | null;
  readonly status: string;
  readonly updatedAt: string | null;
}
interface Detail {
  readonly total: number;
  readonly done: number;
  readonly blocked: boolean;
  readonly pullRequests: ReadonlyArray<string>;
  readonly hasSpec: boolean;
  /** The ledger's last write, which is newer than metadata.json while work runs. */
  readonly ledgerAt: string | null;
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
  if (cached?.signature === signature) return cached.value;
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
  const folded =
    ledgerText === null || source.length === 0
      ? []
      : foldSpecweaveLedger(source, ledgerText, now).tasks.filter((task) =>
          source.some((planned) => planned.id === task.id),
        );
  return remember(detailCache, folder, signature, {
    total: source.length,
    done: folded.filter((task) => CLOSED_TASK_STATES.has(task.status)).length,
    blocked: folded.some((task) => task.status === "blocked"),
    pullRequests: ledgerText === null ? [] : ledgerPullRequests(ledgerText),
    hasSpec: specText !== null,
    ledgerAt: ledger.mtimeMs === null ? null : new Date(ledger.mtimeMs).toISOString(),
  });
}

async function inBatches<A, B>(items: ReadonlyArray<A>, read: (item: A) => Promise<B>) {
  const results: B[] = [];
  for (let start = 0; start < items.length; start += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(start, start + READ_BATCH).map(read))));
  }
  return results;
}

/** The column an increment sits in, from its metadata status and its task counts. */
export function boardColumn(
  status: string,
  tasks: { readonly total: number; readonly done: number },
): ProjectBoardColumn {
  if (status === "completed") return "done";
  if (status === "ready_for_review" || (tasks.total > 0 && tasks.done === tasks.total)) {
    return "review";
  }
  return status === "active" || status === "in-progress" || status === "paused"
    ? "active"
    : "planned";
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
    if (meta.status === "abandoned") return;
    const haystack = `${id} ${meta.title ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return;
    (meta.status === "completed" ? closed : open).push({ id, meta });
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
  const cards = await inBatches([...open, ...shownClosed], async ({ id, meta }) => {
    const folder = folderOf(id);
    const detail = await readDetail(root, folder, input.now);
    const tasks = { total: detail.total, done: detail.done };
    const completed = meta.status === "completed";
    const updatedAt =
      !completed && detail.ledgerAt !== null && detail.ledgerAt > (meta.updatedAt ?? "")
        ? detail.ledgerAt
        : meta.updatedAt;
    return {
      incrementId: id,
      title: meta.title,
      status: meta.status,
      column: boardColumn(meta.status, tasks),
      tasks,
      blocked: !completed && (detail.blocked || meta.status === "paused"),
      updatedAt,
      pullRequests: [...detail.pullRequests],
      specPath: detail.hasSpec ? NodePath.join(folder, "spec.md") : null,
    } satisfies ProjectBoardCard;
  });
  const counts = { planned: 0, active: 0, review: 0, done: closed.length };
  for (const card of cards) if (card.column !== "done") counts[card.column] += 1;
  return { cards: cards.toSorted(newestFirst), counts };
}
