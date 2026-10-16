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
 *   2. checkpoint / name — the report resolver: SpecWeave's session checkpoint
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

/** The checkout whose increments a thread reads: its worktree when that has SpecWeave, else the project. */
export async function incrementRootFor(
  workspaceRoot: string,
  worktreePath: string | null,
): Promise<string> {
  if (worktreePath !== null && (await isDirectory(NodePath.join(worktreePath, INCREMENTS_DIR)))) {
    return NodePath.resolve(worktreePath);
  }
  return NodePath.resolve(workspaceRoot);
}

/** An AC is met once every task citing it is finished; one no task cites stays open. */
export function criteriaWithState(
  criteria: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  tasks: ReadonlyArray<{ readonly status: string; readonly criteria: ReadonlyArray<string> }>,
): ThreadIncrementCriterion[] {
  return criteria.map((criterion) => {
    const citing = tasks.filter((task) => task.criteria.includes(criterion.id));
    return {
      id: criterion.id,
      text: criterion.text,
      met: citing.length > 0 && citing.every((task) => CLOSED_TASK_STATES.has(task.status)),
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
 * root lies inside one of `allowedRoots` and the increment folder exists.
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
  if (!allowed.some((candidate) => candidate !== null && inside(candidate, root))) return null;
  if (!(await isDirectory(NodePath.join(root, INCREMENTS_DIR, binding.incrementId)))) return null;
  return {
    root,
    incrementId: binding.incrementId,
    taskId: typeof binding.taskId === "string" ? binding.taskId : null,
  };
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
      : foldSpecweaveLedger(taskSource, ledger, input.now);
  const metadata = parseIncrementMetadata(metadataText);
  const tasks = (folded?.tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    criteria: [...task.criteria],
    note: task.note,
  }));
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
    criteria: criteriaWithState(fromSpec?.criteria ?? [], tasks),
    verify: parseVerifyReport(verifyText),
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
        const resolved = await resolveReportIncrement(root, {
          threadId: thread.threadId,
          title: thread.title,
          branch: thread.branch,
          ...(thread.home === undefined ? {} : { home: thread.home }),
        });
        if (resolved === null) return null;
        incrementId = resolved;
        binding = (await checkpointNames(thread, incrementId)) ? "checkpoint" : "name";
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

const LISTED_INCREMENTS = 300;

/** The increments in the thread's checkout that it can be linked to, newest first. */
export async function listProjectIncrements(
  workspaceRoot: string,
  worktreePath: string | null,
): Promise<ProjectIncrementSummary[]> {
  const root = await incrementRootFor(workspaceRoot, worktreePath);
  const folder = NodePath.join(root, INCREMENTS_DIR);
  const names = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
  const ids = names
    .filter((entry) => entry.isDirectory() && INCREMENT_FOLDER.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .slice(0, LISTED_INCREMENTS);
  return Promise.all(
    ids.map(async (incrementId) => {
      const metadata = parseIncrementMetadata(
        await readBounded(root, NodePath.join(folder, incrementId, "metadata.json"), SMALL_BYTES),
      );
      return {
        incrementId,
        title:
          typeof metadata.title === "string" && metadata.title.trim()
            ? metadata.title.trim()
            : null,
        status:
          typeof metadata.status === "string" && metadata.status.trim()
            ? metadata.status.trim().toLowerCase()
            : "unknown",
      };
    }),
  );
}
