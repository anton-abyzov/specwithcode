// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over the thread's SpecWeave folder, like ThreadReports.
/**
 * The SpecWeave increment a thread works on, as its plan card shows it.
 *
 * Binding, strongest first:
 *   0. manual — linked by hand in Studio (or marked as having none); the
 *      service passes it in from the `thread_increment_links` table.
 *   1. claim — SpecWeave writes `~/.specweave/studio/threads/<thread>.json`
 *      whenever a process in the thread's turn appends to a ledger (`specweave
 *      task claim|done|…`, `pickup`, `note`). Its root must lie inside the
 *      thread's checkout or the project folder.
 *   2. branch — the thread's worktree branch is `inc/NNNN-*` and exactly one
 *      `NNNN-*` increment exists, or an event in a recent increment's ledger
 *      has a `by` that names the branch. Nothing is written for it.
 *   3. checkpoint / name — the report resolver: SpecWeave's session checkpoint
 *      pointer, then an increment number or folder in the title or branch.
 * Only folders that exist count. Without a claim the increment is read from
 * the thread's worktree when that checkout has its own `.specweave/increments`,
 * because the agent appends to the ledger there before anything is merged.
 *
 * Read-only and offline: no CLI, no Git, nothing written back. Task state is
 * SpecWeave's ledger fold (mods/SpecweaveProgress.ts mirrors `foldLedger`).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type {
  ProjectIncrementSummary,
  ThreadIncrementBinding,
  ThreadIncrementCriterion,
  ThreadIncrementCriterionState,
  ThreadIncrementProgress,
} from "@specweave-studio/contracts";

import {
  foldSpecweaveLedger,
  parseIncrementMetadata,
  parseSpecweaveSpec,
  parseVerifyReport,
} from "../mods/SpecweaveProgress.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import { specweaveStudioCheckpointPath } from "../orchestration-v2/SpecweaveCheckpoint.ts";
import { INCREMENTS_DIR, resolveReportIncrement } from "./ThreadReports.ts";

const SPEC_BYTES = 262_144;
const INCREMENT_FOLDER = /^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const LEDGER_BYTES = 1_048_576;
const SMALL_BYTES = 524_288;
const CLOSED_TASK_STATES = new Set(["done", "skipped"]);
const CARD_LINK_HOSTS = new Set(["github.com", "claude.ai"]);
const COMMIT_SHA = /^[0-9a-f]{7,40}$/u;

export interface ThreadIncrementSource {
  readonly threadId: string;
  readonly title: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** A link made by hand: an increment, or null for "none". Absent is automatic. */
  readonly link?: { readonly incrementId: string | null };
  /** Home holding SpecWeave's checkpoint pointers; tests override it. */
  readonly home?: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

async function isDirectory(path: string): Promise<boolean> {
  return (await NodeFSP.stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** A file inside `root` after resolving links, no bigger than `maximum`; null otherwise. */
async function readBounded(root: string, file: string, maximum: number): Promise<string | null> {
  try {
    const real = await NodeFSP.realpath(file);
    if (!inside(await NodeFSP.realpath(root), real)) return null;
    const stat = await NodeFSP.stat(real);
    if (!stat.isFile() || stat.size > maximum) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(await NodeFSP.readFile(real));
  } catch {
    return null;
  }
}

/**
 * What a card may link to: an https URL on github.com or claude.ai, or a
 * file or folder that resolves (after links) inside the increment folder,
 * returned as its real path. A bare commit sha comes back as `commit`.
 * Anything else is dropped.
 */
export async function sanitizeCardLink(
  raw: string | null,
  incrementFolder: string,
): Promise<{ readonly link?: string; readonly commit?: string }> {
  if (raw === null) return {};
  const value = raw.trim();
  if (COMMIT_SHA.test(value)) return { commit: value };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    if (!/^https:\/\//iu.test(value)) return {};
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        CARD_LINK_HOSTS.has(url.hostname.toLowerCase()) &&
        url.username === "" &&
        url.password === "" &&
        url.port === ""
        ? { link: url.href }
        : {};
    } catch {
      return {};
    }
  }
  try {
    const folder = await NodeFSP.realpath(incrementFolder);
    const real = await NodeFSP.realpath(NodePath.resolve(folder, value));
    return inside(folder, real) ? { link: real } : {};
  } catch {
    return {};
  }
}

/**
 * The SpecWeave workspace that plans `folder`'s increments: the nearest
 * folder at or above it with `.specweave/config.json`, as the CLI's
 * `findProjectRoot` walks up from a member repository of an umbrella. Null
 * when there is none, or when that nearest one has no increments yet.
 */
export async function planningRootAbove(folder: string): Promise<string | null> {
  let current = await NodeFSP.realpath(folder).catch(() => null);
  while (current !== null) {
    const config = await NodeFSP.stat(NodePath.join(current, ".specweave", "config.json")).catch(
      () => null,
    );
    if (config?.isFile()) {
      return (await isDirectory(NodePath.join(current, INCREMENTS_DIR))) ? current : null;
    }
    const parent = NodePath.dirname(current);
    current = parent === current ? null : parent;
  }
  return null;
}

/**
 * The checkout whose increments a thread reads: its worktree when that has
 * SpecWeave, else the project, else the umbrella workspace that plans for
 * either one (a member repository has no `.specweave` of its own).
 */
export async function incrementRootFor(
  workspaceRoot: string,
  worktreePath: string | null,
): Promise<string> {
  if (worktreePath !== null && (await isDirectory(NodePath.join(worktreePath, INCREMENTS_DIR)))) {
    return NodePath.resolve(worktreePath);
  }
  if (await isDirectory(NodePath.join(workspaceRoot, INCREMENTS_DIR))) {
    return NodePath.resolve(workspaceRoot);
  }
  const planning =
    (worktreePath === null ? null : await planningRootAbove(worktreePath)) ??
    (await planningRootAbove(workspaceRoot));
  return planning ?? NodePath.resolve(workspaceRoot);
}

/**
 * Each AC's traceability: the tasks that cite it, its story, the old `met`
 * flag, and how far it is proven (see ThreadIncrementCriterionState). A task
 * counts as evidence only when the ledger accepted its `done` (`doneAt`); a
 * verify run counts only when it passed after the last of those.
 */
export function criteriaWithState(
  criteria: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly checked?: boolean;
    readonly story?: string;
  }>,
  tasks: ReadonlyArray<{
    readonly id?: string;
    readonly status: string;
    readonly criteria: ReadonlyArray<string>;
    readonly doneAt?: string;
  }>,
  options: {
    readonly verify?: { readonly ok: boolean; readonly ranAt: string } | null;
    readonly readable?: boolean;
  } = {},
): ThreadIncrementCriterion[] {
  const verify = options.verify ?? null;
  const verifiedAt = verify?.ok === true ? Date.parse(verify.ranAt) : Number.NaN;
  return criteria.map((criterion) => {
    const citing = tasks.filter((task) => task.criteria.includes(criterion.id));
    const met = citing.length > 0 && citing.every((task) => CLOSED_TASK_STATES.has(task.status));
    const done = citing.filter((task) => task.status === "done");
    const state: ThreadIncrementCriterionState =
      options.readable === false
        ? criterion.checked === true
          ? "declared"
          : "unknown"
        : citing.length === 0
          ? criterion.checked === true
            ? "declared"
            : "uncovered"
          : !met
            ? "open"
            : done.length === 0
              ? "skipped"
              : done.some((task) => task.doneAt === undefined)
                ? "declared"
                : done.length === citing.length &&
                    Number.isFinite(verifiedAt) &&
                    done.every((task) => Date.parse(task.doneAt!) <= verifiedAt)
                  ? "verified"
                  : "evidenced";
    return {
      id: criterion.id,
      text: criterion.text,
      met,
      state,
      tasks: citing.flatMap((task) => (task.id === undefined ? [] : [task.id])),
      ...(criterion.story === undefined ? {} : { story: criterion.story }),
    };
  });
}

/** Where SpecWeave records the increment a Studio thread last wrote to (its `studio-thread-binding`). */
export function specweaveStudioThreadBindingPath(
  threadId: string,
  home = NodeOS.homedir(),
): string {
  return NodePath.join(
    home,
    ".specweave",
    "studio",
    "threads",
    `${threadId.replace(/[^\w.-]/g, "_")}.json`,
  );
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The increment SpecWeave bound this thread to by a ledger write, when its
 * root lies inside one of `allowedRoots` or is exactly the umbrella workspace
 * that plans for the thread's checkout, and the increment folder exists.
 */
async function claimedBinding(
  thread: ThreadIncrementSource,
  allowedRoots: ReadonlyArray<string>,
): Promise<{ root: string; incrementId: string; taskId: string | null } | null> {
  const binding = await readJson(specweaveStudioThreadBindingPath(thread.threadId, thread.home));
  if (
    binding === null ||
    binding.version !== 1 ||
    binding.threadId !== thread.threadId ||
    typeof binding.root !== "string" ||
    typeof binding.incrementId !== "string" ||
    !INCREMENT_FOLDER.test(binding.incrementId)
  ) {
    return null;
  }
  const root = await NodeFSP.realpath(binding.root).catch(() => null);
  if (root === null) return null;
  const allowed = await Promise.all(
    allowedRoots.map((candidate) => NodeFSP.realpath(candidate).catch(() => null)),
  );
  if (!allowed.some((candidate) => candidate !== null && inside(candidate, root))) {
    const planning = await Promise.all(allowedRoots.map(planningRootAbove));
    if (!planning.includes(root)) return null;
  }
  if (!(await isDirectory(NodePath.join(root, INCREMENTS_DIR, binding.incrementId)))) return null;
  return {
    root,
    incrementId: binding.incrementId,
    taskId: typeof binding.taskId === "string" ? binding.taskId : null,
  };
}

const INCREMENT_BRANCH = /^inc\/(\d{4,})-/u;
/** Newest increment ledgers searched for a `by` naming the branch. */
const BRANCH_LEDGERS_SCANNED = 40;

/** Whether a ledger `by` (`tool@host`, optionally with the branch) names `branch`. */
export function ledgerByNamesBranch(by: string, branch: string): boolean {
  return by === branch || by.split(/[@:#\s]+/u).includes(branch);
}

/**
 * The increment a thread's branch binds it to without a claim file: an
 * `inc/NNNN-*` branch maps onto the one `NNNN-*` folder, otherwise the newest
 * of the recent increments whose ledger names the branch in a `by`.
 */
export async function branchBoundIncrement(
  root: string,
  branch: string | null,
): Promise<string | null> {
  const name = branch?.trim() ?? "";
  if (name === "") return null;
  const dir = NodePath.join(root, INCREMENTS_DIR);
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries
    .filter((entry) => entry.isDirectory() && INCREMENT_FOLDER.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  const number = INCREMENT_BRANCH.exec(name)?.[1];
  if (number !== undefined) {
    const matches = folders.filter((folder) => folder.startsWith(`${number}-`));
    // A number shared by two folders is ambiguous; never guess between them.
    if (matches.length === 1) return matches[0]!;
  }
  for (const folder of folders.slice(0, BRANCH_LEDGERS_SCANNED)) {
    const ledger = await readBounded(
      root,
      NodePath.join(dir, folder, "ledger.jsonl"),
      LEDGER_BYTES,
    );
    if (ledger === null || !ledger.includes(name)) continue;
    for (const line of ledger.split("\n")) {
      if (!line.includes(name)) continue;
      try {
        const by = (JSON.parse(line) as { by?: unknown }).by;
        if (typeof by === "string" && ledgerByNamesBranch(by, name)) return folder;
      } catch {
        // An unreadable line binds nothing.
      }
    }
  }
  return null;
}

/** Whether SpecWeave's session checkpoint for the thread names `incrementId`. */
async function checkpointNames(thread: ThreadIncrementSource, incrementId: string) {
  const recorded = (await readJson(specweaveStudioCheckpointPath(thread.threadId, thread.home)))
    ?.incrementId;
  return (
    typeof recorded === "string" &&
    recorded.trim() !== "" &&
    (incrementId === recorded.trim() || incrementId.startsWith(`${recorded.trim()}-`))
  );
}

/** Reads one increment folder the way the plan card shows it. */
export async function readIncrementProgress(input: {
  readonly root: string;
  readonly incrementId: string;
  readonly threadId: string;
  readonly now: number;
}): Promise<Omit<ThreadIncrementProgress, "binding" | "boundTaskId"> | null> {
  const folder = NodePath.join(input.root, INCREMENTS_DIR, input.incrementId);
  if (!inside(input.root, folder) || !(await isDirectory(folder))) return null;
  const specPath = NodePath.join(folder, "spec.md");
  const [spec, tasksFile, metadataText, verifyText] = await Promise.all([
    readBounded(input.root, specPath, SPEC_BYTES),
    readBounded(input.root, NodePath.join(folder, "tasks.md"), SPEC_BYTES),
    readBounded(input.root, NodePath.join(folder, "metadata.json"), SMALL_BYTES),
    readBounded(input.root, NodePath.join(folder, "reports", "verify.json"), SMALL_BYTES),
  ]);
  // A ledger that exists but cannot be read must not fold as "nothing done".
  const ledgerPath = NodePath.join(folder, "ledger.jsonl");
  const ledgerExists = await NodeFSP.stat(ledgerPath).then(
    () => true,
    () => false,
  );
  const ledger = ledgerExists ? await readBounded(input.root, ledgerPath, LEDGER_BYTES) : "";
  const fromSpec = spec === null ? null : parseSpecweaveSpec(spec);
  // Like SpecWeave's tasksFileFor: a legacy tasks.md, when present, holds the tasks.
  const taskSource = tasksFile !== null ? parseSpecweaveSpec(tasksFile).tasks : fromSpec?.tasks;
  const folded =
    taskSource === undefined || taskSource.length === 0 || ledger === null
      ? null
      : foldSpecweaveLedger(taskSource, ledger, input.now, { incrementId: input.incrementId });
  const metadata = parseIncrementMetadata(metadataText);
  const verify = parseVerifyReport(verifyText);
  const cards = new Map((folded?.cards ?? []).map((card) => [card.id, card]));
  const tasks = await Promise.all(
    (folded?.tasks ?? []).map(async (task) => {
      const card = cards.get(task.id);
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        criteria: [...task.criteria],
        note: task.note,
        ...(task.status === "done" && task.changedAt !== null ? { doneAt: task.changedAt } : {}),
        ...(card === undefined ? {} : { line: card.line }),
        ...(await sanitizeCardLink(card?.link ?? null, folder)),
      };
    }),
  );
  return {
    threadId: input.threadId as ThreadIncrementProgress["threadId"],
    incrementId: input.incrementId,
    title: (typeof metadata.title === "string" && metadata.title.trim()) || fromSpec?.title || null,
    status:
      typeof metadata.status === "string" && metadata.status.trim()
        ? metadata.status.trim().toLowerCase()
        : "unknown",
    incrementPath: folder,
    specPath: spec === null ? null : specPath,
    readable: folded !== null,
    tasks,
    criteria: criteriaWithState(fromSpec?.criteria ?? [], tasks, {
      verify,
      readable: folded !== null || (taskSource?.length ?? 0) === 0,
    }),
    verify,
  };
}

/**
 * Each thread's increment progress, for the threads that are bound to one.
 * Increments shared by several threads in the same checkout are read once.
 */
export async function readThreadIncrementProgress(
  workspaceRoot: string,
  threads: ReadonlyArray<ThreadIncrementSource>,
  now = Date.now(),
): Promise<ThreadIncrementProgress[]> {
  const reads = new Map<
    string,
    Promise<Omit<ThreadIncrementProgress, "binding" | "boundTaskId"> | null>
  >();
  const results = await Promise.all(
    threads.map(async (thread): Promise<ThreadIncrementProgress | null> => {
      if (thread.link?.incrementId === null) return null;
      const allowedRoots = [workspaceRoot, ...(thread.worktreePath ? [thread.worktreePath] : [])];
      const claimed = await claimedBinding(thread, allowedRoots);
      let root: string;
      let incrementId: string;
      let binding: ThreadIncrementBinding;
      let boundTaskId = claimed?.taskId ?? null;
      if (thread.link !== undefined) {
        incrementId = thread.link.incrementId;
        binding = "manual";
        if (claimed !== null && claimed.incrementId === incrementId) {
          root = claimed.root;
        } else {
          root = await incrementRootFor(workspaceRoot, thread.worktreePath);
          boundTaskId = null;
        }
      } else if (claimed !== null) {
        ({ root, incrementId } = claimed);
        binding = "claim";
      } else {
        root = await incrementRootFor(workspaceRoot, thread.worktreePath);
        const byBranch = await branchBoundIncrement(root, thread.branch);
        const resolved =
          byBranch ??
          (await resolveReportIncrement(root, {
            threadId: thread.threadId,
            title: thread.title,
            branch: thread.branch,
            ...(thread.home === undefined ? {} : { home: thread.home }),
          }));
        if (resolved === null) return null;
        incrementId = resolved;
        binding =
          byBranch !== null
            ? "branch"
            : (await checkpointNames(thread, incrementId))
              ? "checkpoint"
              : "name";
      }
      const key = `${root}\u0000${incrementId}`;
      let read = reads.get(key);
      if (read === undefined) {
        read = readIncrementProgress({ root, incrementId, threadId: thread.threadId, now });
        reads.set(key, read);
      }
      const progress = await read;
      return progress === null
        ? null
        : {
            ...progress,
            threadId: thread.threadId as ThreadIncrementProgress["threadId"],
            binding,
            boundTaskId,
          };
    }),
  );
  return results.filter((entry): entry is ThreadIncrementProgress => entry !== null);
}

/** What an older client gets when it asks without a limit, as before paging. */
export const LISTED_INCREMENTS = 300;
const METADATA_CACHE_ENTRIES = 20_000;
const METADATA_READ_BATCH = 64;

type IncrementMeta = { readonly title: string | null; readonly status: string };
/** Parsed metadata.json by path, valid while its mtime and size are unchanged. */
const metadataCache = new Map<string, { mtimeMs: number; size: number; meta: IncrementMeta }>();

async function incrementMeta(root: string, file: string): Promise<IncrementMeta> {
  const stat = await NodeFSP.stat(file).catch(() => null);
  if (stat === null) return { title: null, status: "unknown" };
  const cached = metadataCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;
  const metadata = parseIncrementMetadata(await readBounded(root, file, SMALL_BYTES));
  const meta = {
    title:
      typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : null,
    status:
      typeof metadata.status === "string" && metadata.status.trim()
        ? metadata.status.trim().toLowerCase()
        : "unknown",
  };
  metadataCache.delete(file);
  metadataCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  if (metadataCache.size > METADATA_CACHE_ENTRIES) {
    metadataCache.delete(metadataCache.keys().next().value!);
  }
  return meta;
}

/** The increment folder names in the thread's checkout, newest first; no file is opened. */
async function incrementIds(root: string): Promise<string[]> {
  const names = await NodeFSP.readdir(NodePath.join(root, INCREMENTS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  return names
    .filter((entry) => entry.isDirectory() && INCREMENT_FOLDER.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}

export interface IncrementQuery {
  /** Words that must all appear in the folder name or title, case-insensitive. */
  readonly query?: string;
  /** Only increments with this metadata status (`unknown` when it has none). */
  readonly status?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/**
 * One page of the increments in the thread's checkout, newest first, with the
 * total that match and every status's count. On demand only: folder names come
 * from one readdir, and each metadata.json is parsed once until it changes.
 */
export async function queryProjectIncrements(
  workspaceRoot: string,
  worktreePath: string | null,
  input: IncrementQuery = {},
): Promise<{
  increments: ProjectIncrementSummary[];
  total: number;
  statusCounts: Record<string, number>;
}> {
  const root = await incrementRootFor(workspaceRoot, worktreePath);
  const folder = NodePath.join(root, INCREMENTS_DIR);
  const ids = await incrementIds(root);
  const metas: IncrementMeta[] = [];
  for (let start = 0; start < ids.length; start += METADATA_READ_BATCH) {
    metas.push(
      ...(await Promise.all(
        ids
          .slice(start, start + METADATA_READ_BATCH)
          .map((id) => incrementMeta(root, NodePath.join(folder, id, "metadata.json"))),
      )),
    );
  }
  const words = (input.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const statusCounts: Record<string, number> = {};
  const matched: ProjectIncrementSummary[] = [];
  ids.forEach((incrementId, index) => {
    const meta = metas[index]!;
    const haystack = `${incrementId} ${meta.title ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return;
    statusCounts[meta.status] = (statusCounts[meta.status] ?? 0) + 1;
    if (input.status !== undefined && input.status !== meta.status) return;
    matched.push({ incrementId, title: meta.title, status: meta.status });
  });
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.min(
    LISTED_INCREMENTS,
    Math.max(1, Math.floor(input.limit ?? LISTED_INCREMENTS)),
  );
  return { increments: matched.slice(offset, offset + limit), total: matched.length, statusCounts };
}

/** The first page of increments in the thread's checkout, newest first. */
export async function listProjectIncrements(
  workspaceRoot: string,
  worktreePath: string | null,
): Promise<ProjectIncrementSummary[]> {
  return (await queryProjectIncrements(workspaceRoot, worktreePath)).increments;
}

/** Whether `incrementId` names an increment folder in the thread's checkout, at any page. */
export async function incrementExists(
  workspaceRoot: string,
  worktreePath: string | null,
  incrementId: string,
): Promise<boolean> {
  if (!INCREMENT_FOLDER.test(incrementId)) return false;
  const root = await incrementRootFor(workspaceRoot, worktreePath);
  const folder = NodePath.join(root, INCREMENTS_DIR, incrementId);
  return inside(root, folder) && (await isDirectory(folder));
}
