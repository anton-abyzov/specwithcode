/**
 * Folds one machine's measured usage into what it delivered (1456): cost per
 * SpecWeave increment, the coordinators, other app threads and use outside the
 * app, with every record in exactly one of them so the parts add up to the
 * measured total.
 *
 * A thread counts toward one increment: its own binding (manual, claim,
 * branch, checkpoint, name, strongest first), else the nearest ancestor's
 * (`parent`). Coordinators, and subagents running inside them, are never
 * assigned, and an ancestor walk stops at a coordinator, so its workers do not
 * inherit through it.
 *
 * Pure, so the attribution rules are testable without files or a database.
 *
 * @module usage/usageDeliveredCore
 */
import {
  USAGE_DELIVERED_OTHER_THREADS_NAMED,
  USAGE_DELIVERED_THREADS_PER_INCREMENT,
  type UsageDeliveredBinding,
  type UsageDeliveredCost,
  type UsageDeliveredGroup,
  type UsageDeliveredIncrement,
  type UsageDeliveredModelCost,
  type UsageDeliveredState,
  type UsageDeliveredThread,
  type UsageProviderKind,
} from "@specweave-studio/contracts";

import * as DateTime from "effect/DateTime";

import { CLOSED_INCREMENT_STATES } from "../project/ThreadIncrementProgress.ts";
import { makeDayFormatter } from "./usageAggregation.ts";

/** How far the parent fallback climbs a thread's lineage. */
export const DELIVERED_PARENT_DEPTH = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const PULL_REQUESTS_PER_INCREMENT = 10;

/** Own bindings, strongest first. */
const BINDING_ORDER: readonly UsageDeliveredBinding[] = [
  "manual",
  "claim",
  "branch",
  "checkpoint",
  "name",
];

/** Measured usage of one thread (or one native session) on one model. */
export interface DeliveredCostRow {
  /** The app thread that owns it; null for a session no thread owns. */
  readonly threadId: string | null;
  /** The native session or thread, so sessions outside the app can be counted. */
  readonly sessionKey: string;
  readonly driver: string;
  readonly provider: UsageProviderKind | null;
  readonly model: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly records: number;
  readonly unpricedRecords: number;
}

export interface DeliveredThreadFacts {
  readonly title: string | null;
  readonly projectId: string | null;
  readonly parentThreadId: string | null;
  /** The project's coordinator or a subagent running inside it. */
  readonly isCoordinator: boolean;
  readonly pullRequests: readonly number[];
}

export interface DeliveredBindingCandidate {
  readonly projectId: string;
  readonly incrementId: string;
  readonly binding: Exclude<UsageDeliveredBinding, "parent">;
}

export interface DeliveredMerge {
  readonly at: string;
  readonly pullRequest: number | null;
}

export interface DeliveredTaskFact {
  readonly status: string;
  readonly doneAt?: string | undefined;
}

export interface DeliveredIncrementFacts {
  readonly projectId: string;
  readonly incrementId: string;
  readonly title: string | null;
  /** `metadata.json` status, lower case; `unknown` when it has none. */
  readonly status: string;
  readonly createdAt: string | null;
  /** When it closed: `completedAt`, else `updated`, when the status is closed. */
  readonly closedAt: string | null;
  readonly merges: readonly DeliveredMerge[];
  /** Newest first. */
  readonly pullRequests: readonly number[];
  readonly tasks: readonly DeliveredTaskFact[];
}

export interface DeliveredInput {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rows: readonly DeliveredCostRow[];
  readonly threads: ReadonlyMap<string, DeliveredThreadFacts>;
  /** Every binding a resolver found per thread; the strongest wins. */
  readonly bindings: ReadonlyMap<string, readonly DeliveredBindingCandidate[]>;
  /** By {@link incrementKey}. */
  readonly increments: ReadonlyMap<string, DeliveredIncrementFacts>;
}

export interface DeliveredBody {
  readonly increments: UsageDeliveredIncrement[];
  readonly coordinators: UsageDeliveredGroup;
  readonly otherThreads: UsageDeliveredGroup;
  readonly outsideApp: UsageDeliveredGroup;
  readonly measured: UsageDeliveredCost;
}

export function incrementKey(projectId: string, incrementId: string): string {
  return `${projectId}\u0000${incrementId}`;
}

/** Days between two `YYYY-MM-DD` days, inclusive of both. Null when either is not a date. */
export function deliveredDaySpan(sinceDay: string, untilDay: string): number | null {
  const since = Date.parse(`${sinceDay}T00:00:00Z`);
  const until = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(since) || Number.isNaN(until)) return null;
  return Math.round((until - since) / DAY_MS) + 1;
}

/** Whether an ISO time falls on a day of the range in `timeZone`. */
export function makeRangeTest(
  timeZone: string,
  sinceDay: string,
  untilDay: string,
): (iso: string | null | undefined) => boolean {
  const toDay = makeDayFormatter(timeZone);
  return (iso) => {
    if (typeof iso !== "string") return false;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return false;
    const day = toDay(ms);
    return day >= sinceDay && day <= untilDay;
  };
}

/** A valid time as canonical ISO; null otherwise. */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
}

const PULL_REFERENCE = /\/pull\/(\d+)|#(\d+)\b|\bPR\s*#?(\d+)\b/giu;
const MERGED_WORD = /\b(not\s+|un)?(?:squash[- ]?)?merged\b/giu;
const PULL_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/gu;
/** How far from "merged" a pull request reference may sit. */
const MERGE_WINDOW_BEFORE = 40;
const MERGE_WINDOW_AFTER = 60;

/**
 * The pull request a text says was merged, such as "Merged owner/repo#823",
 * "PR #814 merged as …" or "merged as #609". "not merged", "unmerged" and a
 * merge with no pull request near it ("Merged main into the branch") are not.
 */
export function mergedPullRequest(text: string): number | null | undefined {
  for (const match of text.matchAll(MERGED_WORD)) {
    if (match[1] !== undefined) continue;
    const at = match.index ?? 0;
    const start = Math.max(0, at - MERGE_WINDOW_BEFORE);
    const window = text.slice(start, at + match[0].length + MERGE_WINDOW_AFTER);
    let best: { distance: number; number: number } | null = null;
    for (const reference of window.matchAll(PULL_REFERENCE)) {
      const number = Number(reference[1] ?? reference[2] ?? reference[3]);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      const distance = Math.abs(start + (reference.index ?? 0) - at);
      if (best === null || distance < best.distance) best = { distance, number };
    }
    if (best !== null) return best.number;
  }
  return undefined;
}

/** Merges and pull requests a `ledger.jsonl` records; pull requests newest first. */
export function readLedgerMerges(ledger: string): {
  readonly merges: DeliveredMerge[];
  readonly pullRequests: number[];
} {
  const merges: DeliveredMerge[] = [];
  const pulls: number[] = [];
  for (const line of ledger.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const field of ["note", "line", "evidence", "link"] as const) {
      const text = event[field];
      if (typeof text !== "string") continue;
      for (const link of text.matchAll(PULL_LINK)) pulls.push(Number(link[1]));
    }
    const at = isoOrNull(event["at"]);
    if (at === null) continue;
    for (const field of ["note", "line", "evidence"] as const) {
      const text = event[field];
      if (typeof text !== "string") continue;
      const merged = mergedPullRequest(text);
      if (merged === undefined) continue;
      merges.push({ at, pullRequest: merged });
      if (merged !== null) pulls.push(merged);
      break;
    }
  }
  return { merges, pullRequests: newestFirstUnique(pulls) };
}

function newestFirstUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]!;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Micro-dollars are enough, and shorter numbers are cheaper on the wire. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

class CostAccumulator {
  costUsd = 0;
  tokens = 0;
  records = 0;
  unpricedRecords = 0;
  readonly #models = new Map<string, UsageDeliveredModelCost & { costUsd: number }>();

  add(row: DeliveredCostRow): void {
    const tokens = Math.max(0, Math.round(row.tokens));
    this.costUsd += row.costUsd;
    this.tokens += tokens;
    this.records += row.records;
    this.unpricedRecords += row.unpricedRecords;
    const key = `${row.driver}\u0000${row.provider ?? ""}\u0000${row.model}`;
    const existing = this.#models.get(key);
    if (existing === undefined) {
      this.#models.set(key, {
        driver: row.driver,
        provider: row.provider,
        model: row.model,
        costUsd: row.costUsd,
        tokens,
        records: row.records,
        unpricedRecords: row.unpricedRecords,
      });
    } else {
      this.#models.set(key, {
        ...existing,
        costUsd: existing.costUsd + row.costUsd,
        tokens: existing.tokens + tokens,
        records: existing.records + row.records,
        unpricedRecords: existing.unpricedRecords + row.unpricedRecords,
      });
    }
  }

  merge(other: CostAccumulator): void {
    for (const model of other.#models.values()) {
      this.add({ ...model, threadId: null, sessionKey: "" });
    }
  }

  cost(): UsageDeliveredCost {
    return {
      costUsd: roundUsd(this.costUsd),
      tokens: this.tokens,
      records: this.records,
      unpricedRecords: this.unpricedRecords,
    };
  }

  byModel(): UsageDeliveredModelCost[] {
    return [...this.#models.values()]
      .map((model) => ({ ...model, costUsd: roundUsd(model.costUsd) }))
      .sort(
        (a, b) =>
          b.costUsd - a.costUsd ||
          b.tokens - a.tokens ||
          a.driver.localeCompare(b.driver) ||
          a.model.localeCompare(b.model),
      );
  }
}

interface Attribution {
  readonly kind: "increment" | "coordinator" | "other";
  readonly key?: string;
  readonly binding?: UsageDeliveredBinding;
}

function strongest(
  candidates: readonly DeliveredBindingCandidate[] | undefined,
): DeliveredBindingCandidate | null {
  if (candidates === undefined || candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    BINDING_ORDER.indexOf(candidate.binding) < BINDING_ORDER.indexOf(best.binding)
      ? candidate
      : best,
  );
}

/** Where one thread's usage goes. */
export function attributeThread(
  threadId: string,
  threads: ReadonlyMap<string, DeliveredThreadFacts>,
  bindings: ReadonlyMap<string, readonly DeliveredBindingCandidate[]>,
): Attribution {
  const facts = threads.get(threadId);
  if (facts?.isCoordinator) return { kind: "coordinator" };
  const own = strongest(bindings.get(threadId));
  if (own !== null) {
    return {
      kind: "increment",
      key: incrementKey(own.projectId, own.incrementId),
      binding: own.binding,
    };
  }
  const seen = new Set([threadId]);
  let parentId = facts?.parentThreadId ?? null;
  for (let depth = 0; depth < DELIVERED_PARENT_DEPTH && parentId !== null; depth += 1) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = threads.get(parentId);
    // A coordinator's workers are first-class threads: they never inherit through it.
    if (parent?.isCoordinator) break;
    const inherited = strongest(bindings.get(parentId));
    if (inherited !== null) {
      return {
        kind: "increment",
        key: incrementKey(inherited.projectId, inherited.incrementId),
        binding: "parent",
      };
    }
    parentId = parent?.parentThreadId ?? null;
  }
  return { kind: "other" };
}

interface ThreadBucket {
  readonly threadId: string;
  readonly binding: UsageDeliveredBinding | null;
  readonly cost: CostAccumulator;
}

function threadEntries(
  buckets: Iterable<ThreadBucket>,
  threads: ReadonlyMap<string, DeliveredThreadFacts>,
  cap: number,
): UsageDeliveredThread[] {
  return [...buckets]
    .sort(
      (a, b) =>
        b.cost.costUsd - a.cost.costUsd ||
        b.cost.tokens - a.cost.tokens ||
        a.threadId.localeCompare(b.threadId),
    )
    .slice(0, cap)
    .map((bucket) => ({
      threadId: bucket.threadId,
      title: threads.get(bucket.threadId)?.title ?? null,
      binding: bucket.binding,
      cost: bucket.cost.cost(),
      byModel: bucket.cost.byModel(),
    }));
}

function group(
  buckets: ReadonlyMap<string, ThreadBucket>,
  threads: ReadonlyMap<string, DeliveredThreadFacts>,
  cap: number,
): UsageDeliveredGroup {
  const total = new CostAccumulator();
  for (const bucket of buckets.values()) total.merge(bucket.cost);
  return {
    cost: total.cost(),
    byModel: total.byModel(),
    threadCount: buckets.size,
    threads: threadEntries(buckets.values(), threads, cap),
  };
}

function bucketOf(
  map: Map<string, ThreadBucket>,
  threadId: string,
  binding: UsageDeliveredBinding | null,
): ThreadBucket {
  let bucket = map.get(threadId);
  if (bucket === undefined) {
    bucket = { threadId, binding, cost: new CostAccumulator() };
    map.set(threadId, bucket);
  }
  return bucket;
}

function stateOf(
  facts: DeliveredIncrementFacts,
  mergedAt: string | null,
): { state: UsageDeliveredState; closedAt: string | null } {
  if (CLOSED_INCREMENT_STATES.has(facts.status)) {
    return { state: "closed", closedAt: facts.closedAt };
  }
  return { state: mergedAt === null ? "in_progress" : "merged", closedAt: null };
}

/** Builds the report body. Every row lands in exactly one part. */
export function buildDeliveredReport(input: DeliveredInput): DeliveredBody {
  const inRange = makeRangeTest(input.timeZone, input.sinceDay, input.untilDay);
  const measured = new CostAccumulator();
  const coordinators = new Map<string, ThreadBucket>();
  const others = new Map<string, ThreadBucket>();
  const outside = new CostAccumulator();
  const outsideSessions = new Set<string>();
  const byIncrement = new Map<string, Map<string, ThreadBucket>>();
  const attributions = new Map<string, Attribution>();

  for (const row of input.rows) {
    measured.add(row);
    if (row.threadId === null) {
      outside.add(row);
      outsideSessions.add(row.sessionKey);
      continue;
    }
    let attribution = attributions.get(row.threadId);
    if (attribution === undefined) {
      attribution = attributeThread(row.threadId, input.threads, input.bindings);
      attributions.set(row.threadId, attribution);
    }
    if (attribution.kind === "coordinator") {
      bucketOf(coordinators, row.threadId, null).cost.add(row);
    } else if (attribution.kind === "other") {
      bucketOf(others, row.threadId, null).cost.add(row);
    } else {
      const key = attribution.key!;
      let threads = byIncrement.get(key);
      if (threads === undefined) {
        threads = new Map();
        byIncrement.set(key, threads);
      }
      bucketOf(threads, row.threadId, attribution.binding ?? null).cost.add(row);
    }
  }

  const keys = new Set(byIncrement.keys());
  for (const [key, facts] of input.increments) {
    if (keys.has(key)) continue;
    const delivered =
      facts.tasks.some((task) => task.status === "done" && inRange(task.doneAt)) ||
      (CLOSED_INCREMENT_STATES.has(facts.status) && inRange(facts.closedAt)) ||
      facts.merges.some((merge) => inRange(merge.at));
    if (delivered) keys.add(key);
  }

  const sinceMs = Date.parse(`${input.sinceDay}T12:00:00Z`);
  const toDay = makeDayFormatter(input.timeZone);
  const increments: UsageDeliveredIncrement[] = [];
  for (const key of keys) {
    const [projectId, incrementId] = key.split("\u0000") as [string, string];
    const facts: DeliveredIncrementFacts = input.increments.get(key) ?? {
      projectId,
      incrementId,
      title: null,
      status: "unknown",
      createdAt: null,
      closedAt: null,
      merges: [],
      pullRequests: [],
      tasks: [],
    };
    const threads = byIncrement.get(key) ?? new Map<string, ThreadBucket>();
    const total = new CostAccumulator();
    for (const bucket of threads.values()) total.merge(bucket.cost);
    const mergedAt =
      facts.merges
        .filter((merge) => inRange(merge.at))
        .map((merge) => merge.at)
        .sort()
        .at(-1) ?? null;
    const { state, closedAt } = stateOf(facts, mergedAt);
    const pulls: number[] = [...facts.pullRequests];
    for (const threadId of threads.keys()) {
      for (const number of input.threads.get(threadId)?.pullRequests ?? []) {
        if (!pulls.includes(number)) pulls.push(number);
      }
    }
    const created = facts.createdAt === null ? Number.NaN : Date.parse(facts.createdAt);
    const createdBefore =
      !Number.isNaN(created) && !Number.isNaN(sinceMs) && toDay(created) < input.sinceDay;
    increments.push({
      projectId,
      incrementId,
      title: facts.title,
      status: facts.status,
      state,
      closedAt,
      mergedAt,
      pullRequests: pulls.slice(0, PULL_REQUESTS_PER_INCREMENT),
      createdAt: createdBefore ? facts.createdAt : null,
      tasks: {
        total: facts.tasks.length,
        done: facts.tasks.filter((task) => task.status === "done" || task.status === "skipped")
          .length,
        doneInRange: facts.tasks.filter((task) => task.status === "done" && inRange(task.doneAt))
          .length,
      },
      cost: total.cost(),
      byModel: total.byModel(),
      threads: threadEntries(
        threads.values(),
        input.threads,
        USAGE_DELIVERED_THREADS_PER_INCREMENT,
      ),
      threadCount: threads.size,
    });
  }
  increments.sort(
    (a, b) =>
      b.cost.costUsd - a.cost.costUsd ||
      b.tasks.doneInRange - a.tasks.doneInRange ||
      a.projectId.localeCompare(b.projectId) ||
      a.incrementId.localeCompare(b.incrementId),
  );

  return {
    increments,
    coordinators: group(coordinators, input.threads, USAGE_DELIVERED_OTHER_THREADS_NAMED),
    otherThreads: group(others, input.threads, USAGE_DELIVERED_OTHER_THREADS_NAMED),
    outsideApp: {
      cost: outside.cost(),
      byModel: outside.byModel(),
      threadCount: outsideSessions.size,
      threads: [],
    },
    measured: measured.cost(),
  };
}
