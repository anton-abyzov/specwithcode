// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over an increment folder, like ThreadIncrementProgress.
/**
 * An increment's review policy (spec.md `## Review`) and its newest review
 * record (`reports/review*.md`, `reports/reviews/*.md`, as `specweave review`
 * and `specweave review --record` write them), read offline for the plan card
 * and for review delegations. No CLI, no Git; reads write nothing.
 *
 * @module incrementReview
 */
import * as NodeFSP from "node:fs/promises";

import type { ThreadIncrementReview } from "@specweave-studio/contracts";
import {
  type IncrementReviewPolicy,
  parseIncrementReviewPolicy,
  parseReviewRecordHeader,
  reviewPolicyAccepts,
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

/** An increment's `## Review` policy, or null when its spec is missing or has none. */
export async function readIncrementReviewPolicy(
  specPath: string,
): Promise<IncrementReviewPolicy | null> {
  const spec = await readSmall(specPath, SPEC_BYTES);
  return spec === null ? null : parseIncrementReviewPolicy(spec);
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

/** The ledger's finishing tool family, the way SpecWeave reads the author (`claude@mbp` is claude). */
function familyOfTool(tool: string): string {
  const t = tool.toLowerCase();
  if (/^(claude|anthropic|opus|sonnet|haiku|fable)/u.test(t)) return "claude";
  if (/^(codex|openai|gpt|chatgpt)/u.test(t)) return "openai";
  if (/^(grok|xai)/u.test(t)) return "xai";
  if (/^(gemini|google)/u.test(t)) return "google";
  if (/^(muse|meta)/u.test(t)) return "meta";
  return t;
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
        const family = familyOfTool(event.by.split("@")[0] ?? "");
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
}): Promise<ThreadIncrementReview | null> {
  const policy = input.spec === null ? null : parseIncrementReviewPolicy(input.spec);
  const files = await listReviewFiles(input.incrementPath);
  const author = ledgerAuthorFamily(input.ledger);
  const records = [];
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
    records.push({
      model: header?.model ?? header?.reviewer ?? null,
      family: header?.family ?? "unknown",
      author: header?.author ?? author,
      head: header?.head ?? null,
      verdict,
      at: header?.at ?? new Date(file.mtimeMs).toISOString(),
      path: file.path,
    });
  }
  const latest = records[0] ?? null;
  if (latest === null && policy === null) return null;
  const satisfied =
    policy === null
      ? null
      : records.some(
          (record) =>
            record.verdict === "ship" &&
            reviewPolicyAccepts(
              policy,
              { family: record.family, model: record.model },
              record.author,
            ),
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
