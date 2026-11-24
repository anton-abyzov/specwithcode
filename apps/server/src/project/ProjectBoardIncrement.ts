// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over one increment folder, like ProjectBoard.
/**
 * One increment of the project board in full (`projects.boardIncrement`):
 * the card the board shows, the spec's Problem, its open tasks, every
 * blocker, criteria, verify, review and the files of `reports/`.
 *
 * Read from the same copy the board's card comes from (IncrementCopies.ts):
 * the project folder, a linked worktree or the remote's default branch as
 * last fetched. No CLI and no network. The name the client sends must be a
 * plain increment folder name whose folder, after links, still lies inside
 * its checkout; anything else is refused before a single read.
 *
 * Answers are cached per folder while the mtime and size of every file they
 * read stay the same, and only until the earliest two-hour lease in them
 * ends, because a claim turns stale and a block loses its lease with no file
 * change at all.
 */
import * as NodeFSP from "node:fs/promises";

import {
  BOARD_REPORT_GROUPS,
  boardReportGroup,
  type BoardReportGroup,
} from "@specweave-studio/shared/boardReports";
import {
  PROJECT_BOARD_PROBLEM_CHARS,
  PROJECT_BOARD_REPORTS,
  type ProjectBoardBlocker,
  type ProjectBoardIncrement,
  type ProjectBoardReport,
} from "@specweave-studio/contracts";

import { parseIncrementMetadata } from "../mods/SpecweaveProgress.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import type { BoardCopyOptions } from "./IncrementCopies.ts";
import { boardCopiesFor, boardStatus, readBoardCard } from "./ProjectBoard.ts";
import { readBounded, readIncrementProgress } from "./ThreadIncrementProgress.ts";
import { INCREMENTS_DIR } from "./ThreadReports.ts";

/** The folder names ThreadIncrementProgress accepts: no slash, dot-dot, NUL or drive. */
const INCREMENT_FOLDER = /^\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const INCREMENT_ID_CHARS = 160;
const SPEC_BYTES = 262_144;
const SMALL_BYTES = 524_288;
const CACHE_ENTRIES = 200;
const LEASE_MS = 2 * 3_600_000;
const REASON_CHARS = 300;
const CLOSED_TASK_STATES = new Set(["done", "skipped"]);
/** The review records incrementReview.ts opens without a root bound of its own. */
const REVIEW_FILE = /^review(-[A-Za-z0-9._-]+)?\.md$/u;
/** Subfolders of `reports/` the panel lists (one level), beyond `reviews/`. */
const REPORT_SUBFOLDERS = 12;

function inside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/**
 * The increment folder for a client-sent name: "invalid" when the name is not
 * a folder name or the folder resolves outside the root, null when it is gone.
 */
async function guardedFolder(
  root: string,
  incrementId: string,
): Promise<string | null | "invalid"> {
  if (incrementId.length > INCREMENT_ID_CHARS || !INCREMENT_FOLDER.test(incrementId)) {
    return "invalid";
  }
  const folder = NodePath.join(root, INCREMENTS_DIR, incrementId);
  if (!inside(root, folder)) return "invalid";
  const realRoot = await NodeFSP.realpath(root).catch(() => null);
  if (realRoot === null) return null;
  const real = await NodeFSP.realpath(folder).catch(() => null);
  if (real === null) return null;
  // A linked increment folder must not hand out files from elsewhere.
  if (!inside(realRoot, real)) return "invalid";
  const stat = await NodeFSP.stat(real).catch(() => null);
  return stat?.isDirectory() ? folder : null;
}

interface Entry {
  readonly name: string;
  /** What a reader that follows links sees, so a relinked file changes the signature. */
  readonly stamp: string;
  readonly mtimeMs: number;
  /** A regular file itself, not a link to one. */
  readonly file: boolean;
  /** A folder itself, not a link to one. */
  readonly dir: boolean;
}

/**
 * A folder's entries, or "outside" when the folder or a review record in it
 * resolves outside `realFolder`: the review reader follows those links with
 * no root bound, so such an increment is refused rather than half read.
 */
async function listEntries(dir: string, realFolder: string): Promise<Entry[] | "outside"> {
  const exists = await NodeFSP.lstat(dir).catch(() => null);
  if (exists === null) return [];
  const real = await NodeFSP.realpath(dir).catch(() => null);
  if (real === null) return [];
  if (!inside(realFolder, real)) return "outside";
  const names = await NodeFSP.readdir(real).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = NodePath.join(real, name);
      const own = await NodeFSP.lstat(path).catch(() => null);
      if (own === null) return null;
      if (own.isSymbolicLink() && REVIEW_FILE.test(name)) {
        const target = await NodeFSP.realpath(path).catch(() => null);
        if (target !== null && !inside(realFolder, target)) return "outside" as const;
      }
      const seen = own.isSymbolicLink() ? await NodeFSP.stat(path).catch(() => null) : own;
      return {
        name,
        stamp: seen === null ? "-" : `${seen.mtimeMs}:${seen.size}`,
        mtimeMs: own.mtimeMs,
        file: own.isFile(),
        dir: own.isDirectory(),
      };
    }),
  );
  if (entries.includes("outside")) return "outside";
  return entries
    .filter((entry): entry is Entry => entry !== null && entry !== "outside")
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function stamp(file: string): Promise<string> {
  const stat = await NodeFSP.stat(file).catch(() => null);
  return stat === null ? "-" : `${stat.mtimeMs}:${stat.size}`;
}

const listingStamp = (entries: ReadonlyArray<Entry>) =>
  entries.map((entry) => `${entry.name}:${entry.file ? "f" : "o"}:${entry.stamp}`).join("/");

/** One file under `reports/`, by its path inside it (`parity.md`, `screens/a.png`). */
interface ReportFile {
  readonly relative: string;
  readonly mtimeMs: number;
}

/**
 * The files of `reports/` and of its plain subfolders, one level down. A
 * subfolder other than `reviews/` that leads out of the increment is skipped,
 * not refused: only the review reader follows links there.
 */
async function reportTree(
  reportsDir: string,
  realFolder: string,
  top: ReadonlyArray<Entry>,
  reviews: ReadonlyArray<Entry>,
): Promise<{ files: ReportFile[]; stamp: string }> {
  const plain = (entries: ReadonlyArray<Entry>, prefix: string) =>
    entries
      .filter((entry) => entry.file && !entry.name.startsWith("."))
      .map((entry) => ({ relative: `${prefix}${entry.name}`, mtimeMs: entry.mtimeMs }));
  const folders = top
    .filter((entry) => entry.dir && !entry.name.startsWith(".") && entry.name !== "reviews")
    .slice(0, REPORT_SUBFOLDERS);
  const listed = await Promise.all(
    folders.map(async (entry) => {
      const inner = await listEntries(NodePath.join(reportsDir, entry.name), realFolder);
      return { name: entry.name, entries: inner === "outside" ? [] : inner };
    }),
  );
  return {
    files: [
      ...plain(top, ""),
      ...plain(reviews, "reviews/"),
      ...listed.flatMap((folder) => plain(folder.entries, `${folder.name}/`)),
    ],
    stamp: listed.map((folder) => `${folder.name}=${listingStamp(folder.entries)}`).join(";"),
  };
}

/**
 * The mtime and size of every file an answer depends on: the increment's own
 * files, the `reports/` and `reports/reviews/` listings (so adding or
 * rewriting a review changes it) and the project config the review policy
 * reads (`.specweave/config.json`, two folders above the increment).
 */
async function signatureOf(
  folder: string,
  realFolder: string,
  realRoot: string,
): Promise<{ signature: string; reports: ReportFile[]; configOutside: boolean } | "outside"> {
  // The review reader opens the project config with no root bound of its own.
  // A config linked out of the planning root is a setup some projects have, so
  // the increment still answers, without the review that config would shape.
  const config = await NodeFSP.realpath(NodePath.join(folder, "..", "..", "config.json")).catch(
    () => null,
  );
  const configOutside = config !== null && !inside(realRoot, config);
  const reportsDir = NodePath.join(folder, "reports");
  const [stamps, reports, reviews] = await Promise.all([
    Promise.all(
      [
        NodePath.join(folder, "metadata.json"),
        NodePath.join(folder, "spec.md"),
        NodePath.join(folder, "tasks.md"),
        NodePath.join(folder, "ledger.jsonl"),
        NodePath.join(reportsDir, "verify.json"),
        NodePath.join(folder, "..", "..", "config.json"),
      ].map(stamp),
    ),
    listEntries(reportsDir, realFolder),
    listEntries(NodePath.join(reportsDir, "reviews"), realFolder),
  ]);
  if (reports === "outside" || reviews === "outside") return "outside";
  const tree = await reportTree(reportsDir, realFolder, reports, reviews);
  return {
    signature: [...stamps, listingStamp(reports), listingStamp(reviews), tree.stamp].join("|"),
    reports: tree.files,
    configOutside,
  };
}

const cache = new Map<
  string,
  { signature: string; expiresAt: number; value: ProjectBoardIncrement }
>();

function remember(key: string, signature: string, expiresAt: number, value: ProjectBoardIncrement) {
  cache.delete(key);
  cache.set(key, { signature, expiresAt, value });
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** Markdown markers dropped from one line of prose; link and image text is kept. */
function plainLine(line: string): string {
  return line
    .replaceAll(/<!--.*?-->/gu, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/^\s*#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, "")
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/\*\*|__|~~|`/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/**
 * The spec's `## Problem` section as plain text, paragraphs kept apart by one
 * blank line, cut at a word boundary with "…" when longer than the limit.
 */
export function problemText(spec: string | null): string | null {
  if (spec === null) return null;
  const lines = spec.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+problem\b/iu.test(line.trim()));
  if (start === -1) return null;
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const line of lines.slice(start + 1)) {
    const marker = /^\s*(```|~~~)/u.exec(line)?.[1] ?? null;
    if (fence !== null) {
      if (marker === fence) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker;
      flush();
      continue;
    }
    if (/^#{1,2}\s/u.test(line)) break;
    const text = plainLine(line);
    if (text === "") flush();
    else current.push(text);
  }
  flush();
  const whole = paragraphs.join("\n\n");
  if (whole === "") return null;
  if (whole.length <= PROJECT_BOARD_PROBLEM_CHARS) return whole;
  const room = whole.slice(0, PROJECT_BOARD_PROBLEM_CHARS - 1);
  const space = room.search(/\s\S*$/u);
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`;
}

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, REASON_CHARS) : null;

export async function readProjectBoardIncrement(
  workspaceRoot: string,
  input: {
    readonly incrementId: string;
    readonly includeDone?: boolean;
    readonly now: number;
  } & BoardCopyOptions,
): Promise<ProjectBoardIncrement | null | "invalid"> {
  const copies = await boardCopiesFor(workspaceRoot, input);
  // The project folder's own folder first: a bad name, or a folder linked out
  // of the planning root, is refused whatever other copies hold.
  const own = await guardedFolder(copies.root, input.incrementId);
  if (own === "invalid") return "invalid";
  const built = await readBoardCard(copies, input.incrementId, input.now);
  if (built === null) return null;
  const { card, root } = built;
  const includeDone = input.includeDone === true;
  const meaning = boardStatus(card.status);
  if (root === null) {
    // A remote copy that could not be written to the cache: what its status says.
    return {
      card,
      problem: null,
      readable: false,
      tasks: [],
      doneTasks: 0,
      blockers: [],
      criteria: [],
      verify: null,
      review: null,
      abandoned: meaning === "dropped",
      abandonedReason: null,
      closedAt: null,
      reports: [],
    };
  }
  const folder = root === copies.root ? own : await guardedFolder(root, input.incrementId);
  if (folder === null || folder === "invalid") return folder;
  const [realFolder, realRoot] = await Promise.all([
    NodeFSP.realpath(folder).catch(() => null),
    NodeFSP.realpath(root).catch(() => null),
  ]);
  if (realFolder === null || realRoot === null) return null;
  const key = `${folder}\u0000${includeDone ? "all" : "open"}`;
  const signed = await signatureOf(folder, realFolder, realRoot);
  if (signed === "outside") return "invalid";
  const { reports, configOutside } = signed;
  // Reports are often saved to the project folder while the spec lives in
  // another copy: they are listed after the copy's own.
  const ownReal =
    root === copies.root || own === null ? null : await NodeFSP.realpath(own).catch(() => null);
  const listed =
    own === null || ownReal === null
      ? []
      : await listEntries(NodePath.join(own, "reports"), ownReal);
  const projectReports = listed === "outside" ? [] : listed;
  const listedReviews =
    own === null || ownReal === null
      ? []
      : await listEntries(NodePath.join(own, "reports", "reviews"), ownReal);
  const projectReviews = listedReviews === "outside" ? [] : listedReviews;
  const projectContained = listed !== "outside" && listedReviews !== "outside";
  const projectTree =
    own === null || ownReal === null
      ? { files: [], stamp: "" }
      : await reportTree(NodePath.join(own, "reports"), ownReal, projectReports, projectReviews);
  // Whether the project folder's report folders are links: the review reader
  // skips linked ones in another copy, so a change here changes the answer.
  const linkedDirs =
    own === null
      ? ""
      : (
          await Promise.all(
            [NodePath.join(own, "reports"), NodePath.join(own, "reports", "reviews")].map(
              async (dir) =>
                (await NodeFSP.lstat(dir).catch(() => null))?.isSymbolicLink() ? "l" : "d",
            ),
          )
        ).join("");
  const signature = `${signed.signature}|${listingStamp(projectReports)}|${listingStamp(projectReviews)}|${projectTree.stamp}|${linkedDirs}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.signature === signature && input.now <= cached.expiresAt) {
    // The card is read on every call: its reviews and source have their own caches.
    return JSON.stringify(cached.value.card) === JSON.stringify(card)
      ? cached.value
      : { ...cached.value, card };
  }

  const [progress, spec, metadataText] = await Promise.all([
    readIncrementProgress({
      root,
      incrementId: input.incrementId,
      threadId: "",
      now: input.now,
      // The project folder's review records count with the copy's own,
      // unless its reports lead out of its folder.
      ...(root === copies.root || own === null || !projectContained
        ? {}
        : { reviewAlsoFrom: [own] }),
    }),
    readBounded(root, NodePath.join(folder, "spec.md"), SPEC_BYTES),
    readBounded(root, NodePath.join(folder, "metadata.json"), SMALL_BYTES),
  ]);
  if (progress === null) {
    cache.delete(key);
    return null;
  }
  const metadata = parseIncrementMetadata(metadataText);
  const abandoned = meaning === "dropped";
  const fallbackTime = isoOrNull(metadata.updated) ?? isoOrNull(metadata.lastActivity);
  const closedAt =
    meaning === "completed"
      ? (isoOrNull(metadata.approvedAt) ?? isoOrNull(metadata.completedAt) ?? fallbackTime)
      : abandoned
        ? (isoOrNull(metadata.abandonedAt) ?? fallbackTime)
        : null;
  const blockers = progress.tasks
    .filter((task) => task.status === "blocked")
    .map((task): ProjectBoardBlocker => ({
      taskId: task.id,
      title: task.title,
      note: task.note,
      by: task.owner ?? null,
      at: task.changedAt ?? null,
      ...(task.leased === undefined ? {} : { leased: task.leased }),
    }));
  // Real reports before reviews, screens and task evidence, newest first in
  // each group, the copy's own before the project folder's; evidence never
  // crowds a report out of the limit.
  const fromFolder = (files: ReadonlyArray<ReportFile>, from: string, own: boolean) =>
    files.map((file) => ({
      ...file,
      own,
      path: NodePath.join(from, "reports", ...file.relative.split("/")),
      group: boardReportGroup(file.relative) satisfies BoardReportGroup,
    }));
  const held = new Set(reports.map((file) => file.relative));
  const reportFiles = [
    ...fromFolder(reports, folder, true),
    ...(own === null
      ? []
      : fromFolder(
          projectTree.files.filter((file) => !held.has(file.relative)),
          own,
          false,
        )),
  ]
    .toSorted(
      (left, right) =>
        BOARD_REPORT_GROUPS.indexOf(left.group) - BOARD_REPORT_GROUPS.indexOf(right.group) ||
        Number(right.own) - Number(left.own) ||
        right.mtimeMs - left.mtimeMs ||
        left.relative.localeCompare(right.relative),
    )
    .slice(0, PROJECT_BOARD_REPORTS)
    .map((file): ProjectBoardReport => ({ path: file.path, name: file.relative }));
  const value: ProjectBoardIncrement = {
    card,
    problem: problemText(spec),
    readable: progress.readable,
    tasks: includeDone
      ? progress.tasks
      : progress.tasks.filter((task) => !CLOSED_TASK_STATES.has(task.status)),
    doneTasks: progress.tasks.filter((task) => CLOSED_TASK_STATES.has(task.status)).length,
    blockers,
    criteria: progress.criteria,
    verify: progress.verify,
    review: configOutside ? null : (progress.review ?? null),
    abandoned,
    abandonedReason: abandoned
      ? (textOrNull(metadata.abandonedReason) ?? textOrNull(metadata.closeReason))
      : null,
    closedAt,
    reports: reportFiles,
  };
  // The answer holds only until the first lease in it runs out.
  const leaseEnds = progress.tasks
    .filter((task) => task.leased === true && task.changedAt !== undefined)
    .map((task) => Date.parse(task.changedAt!) + LEASE_MS)
    .filter((time) => !Number.isNaN(time));
  remember(key, signature, Math.min(Number.POSITIVE_INFINITY, ...leaseEnds), value);
  return value;
}
