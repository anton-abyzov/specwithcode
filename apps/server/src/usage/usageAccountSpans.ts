/**
 * Which account each provider instance was signed in to, over time.
 *
 * A transcript folder belongs to a provider instance, and an instance changes
 * accounts: one `~/.claude` read four accounts in two weeks on one machine. A
 * usage record carries no account, so the machine report needs to know who was
 * signed in when the record was written. Each sighting of an authenticated
 * instance extends that account's span or opens a new one.
 *
 * Pure: the service in `UsageMachineReport` feeds it and keeps the file.
 *
 * @module usage/usageAccountSpans
 */
import type { UsageAccountIdentityRule } from "@specweave-studio/contracts";

const HOUR = 60 * 60_000;

export const USAGE_ACCOUNT_SPANS_FILE = "usage-account-spans.json";

/** As long as the scan cache keeps records, plus slack. */
export const SPAN_RETENTION_MS = 100 * 24 * HOUR;

/** Most spans kept per instance; the oldest go first. */
export const MAX_SPANS_PER_INSTANCE = 500;

/** `from` and `to` are the first and last time the account was seen signed in. */
export interface AccountSpan {
  readonly accountKey: string;
  readonly from: number;
  to: number;
}

/** Spans per provider instance, each list in time order. */
export type AccountSpanState = Map<string, AccountSpan[]>;

/** Records that `instanceId` was signed in to `accountKey` at `at`. Returns whether anything changed. */
export function recordSighting(
  state: AccountSpanState,
  instanceId: string,
  accountKey: string,
  at: number,
): boolean {
  let spans = state.get(instanceId);
  if (spans === undefined) {
    spans = [];
    state.set(instanceId, spans);
  }
  const last = spans.at(-1);
  if (last === undefined) {
    spans.push({ accountKey, from: at, to: at });
    return true;
  }
  // A late or repeated sighting says nothing the newer one did not.
  if (at <= last.to) return false;
  if (last.accountKey === accountKey) {
    last.to = at;
    return true;
  }
  spans.push({ accountKey, from: at, to: at });
  if (spans.length > MAX_SPANS_PER_INSTANCE) {
    spans.splice(0, spans.length - MAX_SPANS_PER_INSTANCE);
  }
  return true;
}

/** Drops spans that ended before the retention window. Returns whether anything went. */
export function pruneSpans(state: AccountSpanState, now: number): boolean {
  const cutoff = now - SPAN_RETENTION_MS;
  let changed = false;
  for (const [instanceId, spans] of state) {
    const kept = spans.filter((span) => span.to >= cutoff);
    if (kept.length === spans.length) continue;
    changed = true;
    if (kept.length === 0) state.delete(instanceId);
    else state.set(instanceId, kept);
  }
  return changed;
}

export interface ResolvedAccount {
  readonly accountKey: string;
  readonly rule: UsageAccountIdentityRule;
}

/**
 * The span that names `at`: the one holding it, else, in a gap between two
 * sightings, the nearer side (the switch happened somewhere in the gap), else
 * the last span for a later time. Null before the first span: what was signed
 * in before anyone looked is not known from spans.
 */
export function spanAt(spans: readonly AccountSpan[], at: number): AccountSpan | null {
  const first = spans[0];
  if (first === undefined || at < first.from) return null;
  let previous = first;
  for (const span of spans) {
    if (at < span.from) {
      return at - previous.to <= span.from - at ? previous : span;
    }
    if (at <= span.to) return span;
    previous = span;
  }
  return previous;
}

/** A limit reading stands in for the account this long before and after it. */
export const MAX_READING_DISTANCE_MS = 12 * HOUR;

const singleAccount = new WeakMap<readonly AccountReading[], boolean>();

function oneAccount(readings: readonly AccountReading[]): boolean {
  let single = singleAccount.get(readings);
  if (single === undefined) {
    single = readings.every((reading) => reading.accountKey === readings[0]!.accountKey);
    singleAccount.set(readings, single);
  }
  return single;
}

/** One limit reading of one account, from the limit history. */
export interface AccountReading {
  readonly at: number;
  readonly accountKey: string;
}

/** The reading nearest in time, from a list sorted by `at`. Null when the list is empty. */
export function nearestReading(
  readings: readonly AccountReading[],
  at: number,
): AccountReading | null {
  if (readings.length === 0) return null;
  let low = 0;
  let high = readings.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (readings[middle]!.at < at) low = middle + 1;
    else high = middle;
  }
  const after = readings[low]!;
  const before = low > 0 ? readings[low - 1]! : null;
  if (before === null) return after;
  return at - before.at <= after.at - at ? before : after;
}

export interface AccountResolverInput {
  /** Spans of every instance whose home is the record's folder. */
  readonly spans: readonly (readonly AccountSpan[])[];
  /**
   * Limit readings of the folder's driver, sorted by time, or null when they
   * cannot stand in: the driver has several instances on this machine, so a
   * reading does not say which one made it.
   */
  readonly readings: readonly AccountReading[] | null;
  /** The account signed in on the folder's instance now, when exactly one is. */
  readonly currentAccountKey: string | null;
  /** What to charge when nothing names an account. */
  readonly unknownAccountKey: string;
}

/**
 * Names the account a record written at `at` belongs to, by the strongest rule
 * that applies: a recorded span, then the limit history, then the account
 * signed in now.
 */
export function makeAccountResolver(input: AccountResolverInput): (at: number) => ResolvedAccount {
  // Records arrive in time order per file, so the last answer usually holds.
  let memo: { readonly from: number; readonly to: number; readonly value: ResolvedAccount } | null =
    null;
  return (at) => {
    if (memo !== null && at >= memo.from && at <= memo.to) return memo.value;
    const holding: AccountSpan[] = [];
    const near: AccountSpan[] = [];
    for (const spans of input.spans) {
      const span = spanAt(spans, at);
      if (span === null) continue;
      if (at >= span.from && at <= span.to) holding.push(span);
      else near.push(span);
    }
    if (holding.length === 1) {
      const span = holding[0]!;
      const value: ResolvedAccount = { accountKey: span.accountKey, rule: "recorded" };
      memo = { from: span.from, to: span.to, value };
      return value;
    }
    if (holding.length > 1) {
      // Instances that share a folder (Codex shadow homes) were both signed in:
      // the folder cannot say which wrote the record, so take the newest sign-in.
      const newest = holding.reduce((a, b) => (b.from > a.from ? b : a));
      return { accountKey: newest.accountKey, rule: "current" };
    }
    if (near.length === 1 && input.spans.length === 1) {
      return { accountKey: near[0]!.accountKey, rule: "recorded" };
    }
    if (near.length > 0) {
      const closest = near.reduce((a, b) =>
        Math.min(Math.abs(at - b.from), Math.abs(at - b.to)) <
        Math.min(Math.abs(at - a.from), Math.abs(at - a.to))
          ? b
          : a,
      );
      return { accountKey: closest.accountKey, rule: "current" };
    }
    const reading = input.readings === null ? null : nearestReading(input.readings, at);
    if (reading !== null) {
      // A reading names the time around it. Further away, it still does when
      // the driver only ever read one account; otherwise nothing is known.
      if (Math.abs(at - reading.at) <= MAX_READING_DISTANCE_MS || oneAccount(input.readings!)) {
        return { accountKey: reading.accountKey, rule: "history" };
      }
      return { accountKey: input.unknownAccountKey, rule: "unknown" };
    }
    if (input.currentAccountKey !== null) {
      return { accountKey: input.currentAccountKey, rule: "current" };
    }
    return { accountKey: input.unknownAccountKey, rule: "unknown" };
  };
}

const FILE_VERSION = 1;

/** Compact on disk: each span is `[accountKey, from, to]`. */
export function encodeSpansFile(state: AccountSpanState): string {
  return `${JSON.stringify({
    version: FILE_VERSION,
    instances: Object.fromEntries(
      [...state].map(([instanceId, spans]) => [
        instanceId,
        spans.map((span) => [span.accountKey, span.from, span.to]),
      ]),
    ),
  })}\n`;
}

/** A missing, damaged or newer file reads as no spans: they are rebuilt by use. */
export function decodeSpansFile(raw: string): AccountSpanState {
  const state: AccountSpanState = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null) return state;
  const file = parsed as { readonly version?: unknown; readonly instances?: unknown };
  if (file.version !== FILE_VERSION || typeof file.instances !== "object" || !file.instances) {
    return state;
  }
  for (const [instanceId, entries] of Object.entries(file.instances)) {
    if (!Array.isArray(entries)) continue;
    const spans: AccountSpan[] = [];
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [accountKey, from, to] = entry as readonly unknown[];
      if (
        typeof accountKey !== "string" ||
        accountKey.trim() === "" ||
        typeof from !== "number" ||
        typeof to !== "number" ||
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        to < from
      ) {
        continue;
      }
      spans.push({ accountKey, from, to });
    }
    spans.sort((a, b) => a.from - b.from);
    if (spans.length > 0) state.set(instanceId, spans);
  }
  return state;
}
