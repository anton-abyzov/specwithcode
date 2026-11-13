// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over an increment folder, like ThreadIncrementProgress.
/**
 * An increment's review policy (spec.md `## Review` over the project's
 * `.specweave/config.json` `review` layers) and its newest review
 * record (`reports/review*.md`, `reports/reviews/*.md`, as `specweave review`
 * and `specweave review --record` write them), read offline for the plan card
 * and for review delegations. No CLI, no Git; reads write nothing.
 *
 * @module incrementReview
 */
import * as NodeFSP from "node:fs/promises";

import type { ThreadIncrementReview } from "@specweave-studio/contracts";
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
}

async function listReviewFiles(incrementPath: string): Promise<ReviewFile[]> {
  const reports = NodePath.join(incrementPath, "reports");
  const list = async (dir: string, pattern: RegExp, numbered: boolean) => {
    const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
    const files = await Promise.all(
      names
        .filter((name) => pattern.test(name))
        .slice(0, MAX_REPORTS)
        .map(async (name) => {
          const path = NodePath.join(dir, name);
          const stat = await NodeFSP.stat(path).catch(() => null);
          return stat?.isFile() ? { path, numbered, mtimeMs: stat.mtimeMs } : null;
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
}): Promise<ThreadIncrementReview | null> {
  const config = await readProjectConfig(input.incrementPath);
  const policy = resolveIncrementReviewPolicy({ spec: input.spec, config: reviewLayer(config) });
  const projectRoot = NodePath.resolve(input.incrementPath, "..", "..", "..");
  const files = await listReviewFiles(input.incrementPath);
  const author = ledgerAuthorFamily(input.ledger);
  const records: Array<
    ReviewRecordForPolicy & {
      readonly head: string | null;
      readonly at: string;
      readonly path: string;
      readonly atMs: number;
      readonly numbered: boolean;
    }
  > = [];
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
