// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over an increment folder, like ThreadIncrementProgress.
/**
 * An increment's review policy (spec.md `## Review` over the project's
 * `.specweave/config.json` `review` layers) and its newest review
 * record (`reports/review*.md`, `reports/reviews/*.md`, as `specweave review`
 * and `specweave review --record` write them), read offline for the plan card
 * and for review delegations, and every recorded review for the Board's
 * cards. No CLI, no Git; reads write nothing.
 *
 * @module incrementReview
 */
import * as NodeFSP from "node:fs/promises";

import {
  PROJECT_BOARD_CARD_REVIEWS,
  type ProjectBoardCardReview,
  type ThreadIncrementReview,
} from "@specweave-studio/contracts";
import {
  canonicalReviewFamily,
  incrementReviewRepos,
  type IncrementReviewPolicy,
  parseReviewRecordHeader,
  registeredReviewRepos,
  type ReviewConfigLayer,
  type ReviewRecordForPolicy,
  resolveIncrementReviewPolicy,
  reviewPolicySatisfied,
} from "@specweave-studio/shared/reviewPolicy";

import { nodePath as NodePath } from "../nodePath.ts";

const SPEC_BYTES = 262_144;
const REPORT_BYTES = 524_288;
const MAX_REPORTS = 200;
const REVIEW_FILE = /^review(-[A-Za-z0-9._-]+)?\.md$/u;
const RUN_FILE = /^review-[A-Za-z0-9._-]+\.md$/u;
const VERDICT = /^[\s>*_#-]*verdict[*_]*\s*:[*_\s]*(ship|fix[ -]first)\b/imu;

async function readSmall(path: string, maximum: number): Promise<string | null> {
  try {
    const stat = await NodeFSP.stat(path);
    if (!stat.isFile() || stat.size > maximum) return null;
    return await NodeFSP.readFile(path, "utf8");
  } catch {
    return null;
  }
}

const CONFIG_BYTES = 262_144;

/** The project's `.specweave/config.json` for an increment folder (`<root>/.specweave/increments/<id>`). */
async function readProjectConfig(incrementPath: string): Promise<Record<string, unknown> | null> {
  const text = await readSmall(
    NodePath.join(incrementPath, "..", "..", "config.json"),
    CONFIG_BYTES,
  );
  if (text === null) return null;
  try {
    const config: unknown = JSON.parse(text);
    return config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The config's `review` section. */
function reviewLayer(config: Record<string, unknown> | null): ReviewConfigLayer | null {
  const review = config?.["review"];
  return review !== null && typeof review === "object" ? (review as ReviewConfigLayer) : null;
}

async function readReviewConfig(incrementPath: string): Promise<ReviewConfigLayer | null> {
  return reviewLayer(await readProjectConfig(incrementPath));
}

/** An increment's effective review policy, or null when neither its spec nor the project config sets one. */
export async function readIncrementReviewPolicy(
  specPath: string,
): Promise<IncrementReviewPolicy | null> {
  const incrementPath = NodePath.dirname(specPath);
  const [spec, config] = await Promise.all([
    readSmall(specPath, SPEC_BYTES),
    readReviewConfig(incrementPath),
  ]);
  return resolveIncrementReviewPolicy({ spec, config });
}

interface ReviewFile {
  readonly path: string;
  readonly numbered: boolean;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * The review files of one increment folder, newest first. With `noLinks`
 * (another copy's folder, read alongside the shown one) a linked `reports`
 * folder or file is skipped, so that copy cannot lead out of its folder.
 */
async function listReviewFiles(incrementPath: string, noLinks = false): Promise<ReviewFile[]> {
  const reports = NodePath.join(incrementPath, "reports");
  const linked = async (path: string) =>
    noLinks && (await NodeFSP.lstat(path).catch(() => null))?.isSymbolicLink() === true;
  if (await linked(reports)) return [];
  const list = async (dir: string, pattern: RegExp, numbered: boolean) => {
    if (await linked(dir)) return [];
    const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
    const files = await Promise.all(
      names
        .filter((name) => pattern.test(name))
        .slice(0, MAX_REPORTS)
        .map(async (name) => {
          const path = NodePath.join(dir, name);
          const stat = await (noLinks ? NodeFSP.lstat(path) : NodeFSP.stat(path)).catch(() => null);
          return stat?.isFile() ? { path, numbered, mtimeMs: stat.mtimeMs, size: stat.size } : null;
        }),
    );
    return files.filter((file): file is ReviewFile => file !== null);
  };
  const [top, runs] = await Promise.all([
    list(reports, REVIEW_FILE, false),
    list(NodePath.join(reports, "reviews"), RUN_FILE, true),
  ]);
  return [...top, ...runs].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || Number(b.numbered) - Number(a.numbered),
  );
}

/** The family that finished the most tasks in a ledger, or null. */
export function ledgerAuthorFamily(ledger: string | null): string | null {
  if (ledger === null) return null;
  const tally = (type: string) => {
    const counts = new Map<string, number>();
    for (const line of ledger.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { e?: unknown; by?: unknown };
        if (event.e !== type || typeof event.by !== "string" || !event.by.includes("@")) continue;
        const tool = event.by.split("@")[0] ?? "";
        const family = canonicalReviewFamily(tool) ?? tool.toLowerCase();
        counts.set(family, (counts.get(family) ?? 0) + 1);
      } catch {
        // a malformed line counts for nothing
      }
    }
    return counts;
  };
  let counts = tally("done");
  if (counts.size === 0) counts = tally("claim");
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted[0]?.[0] ?? null;
}

type ReviewRecord = ReviewRecordForPolicy & {
  readonly head: string | null;
  readonly at: string;
  readonly path: string;
  readonly atMs: number;
  readonly numbered: boolean;
};

/** Every review record of an increment, newest first; `author` stands in for records that name none. */
async function readReviewRecords(
  files: ReadonlyArray<ReviewFile>,
  author: string | null,
): Promise<ReviewRecord[]> {
  const records: ReviewRecord[] = [];
  for (const file of files) {
    const text = await readSmall(file.path, REPORT_BYTES);
    if (text === null) continue;
    const header = parseReviewRecordHeader(text);
    const verdictMatch = VERDICT.exec(text.replace(/^<!--[^\n]*-->\s*\n/u, ""));
    const verdict =
      verdictMatch === null
        ? null
        : (verdictMatch[1] ?? "").toLowerCase() === "ship"
          ? ("ship" as const)
          : ("fix first" as const);
    // A record's own time orders it; a checkout's file time says nothing about
    // when a review ran, so it orders only reports without a record line.
    const atMs = header?.at ? Date.parse(header.at) : file.mtimeMs;
    records.push({
      model: header?.model ?? header?.reviewer ?? null,
      family: header?.family ?? "unknown",
      depth: header?.depth ?? null,
      author: header?.author ?? author,
      repo: header?.repo ?? null,
      head: header?.head ?? null,
      verdict,
      at: header?.at ?? new Date(file.mtimeMs).toISOString(),
      atMs,
      numbered: file.numbered,
      path: file.path,
    });
  }
  records.sort(
    (a, b) =>
      b.atMs - a.atMs ||
      Number(b.numbered) - Number(a.numbered) ||
      b.path.localeCompare(a.path, undefined, { numeric: true }),
  );
  // The same record kept in two copies of the increment counts once: same
  // file name and every field the policy reads. Names are unique within one
  // folder, so records of one copy are never merged.
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [
      NodePath.basename(record.path),
      record.numbered,
      record.model,
      record.family,
      record.depth,
      record.author,
      record.repo,
      record.head,
      record.verdict,
      record.at,
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Review files of an increment folder and of other copies of it, newest first. */
async function listReviewFilesOf(
  incrementPath: string | null,
  alsoFrom: ReadonlyArray<string>,
): Promise<ReviewFile[]> {
  const lists = await Promise.all([
    incrementPath === null ? [] : listReviewFiles(incrementPath),
    ...alsoFrom.map((path) => listReviewFiles(path, true)),
  ]);
  return lists
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || Number(b.numbered) - Number(a.numbered));
}

/**
 * What the plan card says about review: the newest review record and, when
 * the policy requires one, whether a record satisfies it. Null when the
 * increment has no review and no policy.
 */
export async function readIncrementReview(input: {
  readonly incrementPath: string;
  readonly spec: string | null;
  readonly ledger: string | null;
  /** A legacy tasks.md; when present it holds the tasks, as in SpecWeave. */
  readonly tasks?: string | null;
  /**
   * Other copies of the same increment whose review records count too, such
   * as the project folder's while the spec is read from a worktree.
   */
  readonly alsoFrom?: ReadonlyArray<string>;
}): Promise<ThreadIncrementReview | null> {
  const config = await readProjectConfig(input.incrementPath);
  const policy = resolveIncrementReviewPolicy({ spec: input.spec, config: reviewLayer(config) });
  const projectRoot = NodePath.resolve(input.incrementPath, "..", "..", "..");
  const author = ledgerAuthorFamily(input.ledger);
  const records = await readReviewRecords(
    await listReviewFilesOf(input.incrementPath, input.alsoFrom ?? []),
    author,
  );
  const latest = records[0] ?? null;
  if (latest === null && policy === null) return null;
  const satisfied =
    policy === null
      ? null
      : reviewPolicySatisfied(
          policy,
          records,
          incrementReviewRepos(
            input.tasks ?? input.spec,
            registeredReviewRepos(config, projectRoot),
          ),
          author,
        );
  return {
    policy:
      policy === null
        ? null
        : {
            family: policy.family,
            model: policy.model ?? null,
            depth: policy.depth ?? "standard",
            required: policy.required ?? false,
          },
    latest:
      latest === null
        ? null
        : {
            model: latest.model,
            family: latest.family,
            head: latest.head,
            verdict: latest.verdict,
            at: latest.at,
            reportPath: latest.path,
          },
    authorFamily: author,
    policySatisfied: satisfied,
  };
}

const REVIEW_LIST_CACHE_ENTRIES = 2_000;
/** Board review lists by increment folder, valid while its review files and ledger author hold. */
const reviewListCache = new Map<
  string,
  { readonly signature: string; readonly value: ReadonlyArray<ProjectBoardCardReview> }
>();

const canonicalOr = (family: string) => canonicalReviewFamily(family) ?? family;

/**
 * Every recorded review of an increment for its Board card (1398 AC-22),
 * newest first and at most PROJECT_BOARD_CARD_REVIEWS, with the reviewer's
 * and the author's families canonical so a client can compare them.
 * `ledgerAuthor` is the ledger's author family (ledgerAuthorFamily), used for
 * records that name none. An increment without a `reports/` folder costs one
 * stat. One whose review folders held no review costs two stats until a file
 * is added or removed there (which changes the folder's time). One with
 * reviews is listed again on each read and its files read again only when
 * one of them changes.
 */
export async function readIncrementReviews(
  /** The shown copy's folder; null when only other copies can be read. */
  incrementPath: string | null,
  ledgerAuthor: string | null,
  /**
   * Other copies of the same increment whose records count too
   * (readIncrementReview's `alsoFrom`); their links are never followed.
   */
  alsoFrom: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<ProjectBoardCardReview>> {
  const paths = [...(incrementPath === null ? [] : [incrementPath]), ...alsoFrom];
  if (paths.length === 0) return [];
  const primaries = incrementPath === null ? 0 : 1;
  const stamps = await Promise.all(
    paths.map(async (path, index) => {
      // Another copy's folders are signed as its reader admits them: a
      // linked folder is not read, so it signs as a link, not its target.
      const look = index < primaries ? NodeFSP.stat : NodeFSP.lstat;
      const reportsPath = NodePath.join(path, "reports");
      const reports = await look(reportsPath).catch(() => null);
      if (reports?.isSymbolicLink() === true) return "link";
      if (reports === null || !reports.isDirectory()) return null;
      const runs = await look(NodePath.join(reportsPath, "reviews")).catch(() => null);
      if (runs?.isSymbolicLink() === true) return `${reports.mtimeMs}:link`;
      return `${reports.mtimeMs}:${runs?.isDirectory() === true ? runs.mtimeMs : "-"}`;
    }),
  );
  if (stamps.every((stamp) => stamp === null)) return [];
  const key = `${incrementPath === null ? "-" : "+"}\u0000${paths.join("\u0000")}`;
  const folders = stamps.map((stamp) => stamp ?? "-").join("|");
  const cached = reviewListCache.get(key);
  if (cached !== undefined && cached.value.length === 0 && cached.signature === folders) return [];
  const files = await listReviewFilesOf(incrementPath, alsoFrom);
  if (files.length === 0) {
    rememberReviews(key, folders, []);
    return [];
  }
  const signature = [
    ledgerAuthor ?? "",
    ...files.map((file) => `${file.path}:${file.mtimeMs}:${file.size}`),
  ].join("|");
  if (cached?.signature === signature) return cached.value;
  const records = await readReviewRecords(files, ledgerAuthor);
  const value = records
    .slice(0, PROJECT_BOARD_CARD_REVIEWS)
    .map((record): ProjectBoardCardReview => ({
      model: record.model ?? null,
      family: canonicalOr(record.family),
      author: record.author === null ? null : canonicalOr(record.author),
      verdict: record.verdict ?? null,
      at: record.at,
    }));
  rememberReviews(key, signature, value);
  return value;
}

function rememberReviews(
  incrementPath: string,
  signature: string,
  value: ReadonlyArray<ProjectBoardCardReview>,
) {
  reviewListCache.delete(incrementPath);
  reviewListCache.set(incrementPath, { signature, value });
  if (reviewListCache.size > REVIEW_LIST_CACHE_ENTRIES) {
    reviewListCache.delete(reviewListCache.keys().next().value!);
  }
}
