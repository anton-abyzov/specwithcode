/**
 * Which machine used which subscription: the reports of every machine a client
 * reaches, merged per account.
 *
 * Grouping is subscription first, then machine, then origin (a SpecWithCode
 * thread, or a session on the machine that no thread owns). A transcript
 * folder two environments both read is counted for one of them. A machine that
 * is out of reach keeps its last report; one too old to send a report falls
 * back to its usage summary, which names no account and no origin.
 *
 * @module usageMachineShare
 */
import type {
  UsageAccountIdentityRule,
  UsageMachineCell,
  UsageMachineOrigin,
  UsageMachineReport,
  UsageSummary,
} from "@specweave-studio/contracts";

import {
  isUnknownUsageAccountKey,
  unknownUsageAccountKey,
  usageAccountKeyDriver,
  usageAccountKeyName,
} from "./usageAccountKey.ts";
import { enumerateDays } from "./usageFormat.ts";
import { fingerprintKey } from "./usageMerge.ts";
import type { OutsideResult, RecordedHour } from "./usageOutsideEstimate.ts";

const HOUR_MS = 60 * 60 * 1000;

/** `unsplit`: from a usage summary, which cannot tell the app's sessions from others. */
export type ShareOrigin = UsageMachineOrigin | "unsplit";
export type ShareMeasure = "cost" | "tokens" | "requests";

/**
 * - `live`: the machine answered now;
 * - `cached`: out of reach, so this is the last report this device kept;
 * - `summary`: too old to send a report, so its usage summary stands in;
 * - `missing`: nothing is known of it.
 */
export type ShareMachineState = "live" | "cached" | "summary" | "missing";

export type ShareCell = Omit<UsageMachineCell, "origin"> & { readonly origin: ShareOrigin };
export type ShareReport = Omit<UsageMachineReport, "cells"> & {
  readonly cells: readonly ShareCell[];
};

export interface ShareMachineInput {
  readonly machineId: string;
  readonly name: string;
  readonly state: ShareMachineState;
  readonly report: ShareReport | null;
  /** Accounts signed in on the machine as this device last knew, reachable or not. */
  readonly heldAccountKeys: readonly string[];
  /** Why there is no live report, in plain words. */
  readonly note?: string;
}

export interface ShareTotals {
  readonly costUsd: number;
  readonly tokens: number;
  readonly requests: number;
  readonly unpricedRequests: number;
}

const ZERO: ShareTotals = { costUsd: 0, tokens: 0, requests: 0, unpricedRequests: 0 };

function plus(a: ShareTotals, b: ShareTotals): ShareTotals {
  return {
    costUsd: a.costUsd + b.costUsd,
    tokens: a.tokens + b.tokens,
    requests: a.requests + b.requests,
    unpricedRequests: a.unpricedRequests + b.unpricedRequests,
  };
}

export function measureOf(totals: ShareTotals, measure: ShareMeasure): number {
  if (measure === "cost") return totals.costUsd;
  return measure === "tokens" ? totals.tokens : totals.requests;
}

/** One merged cell, after duplicate folders were dropped. */
export interface ShareRow extends ShareTotals {
  readonly machineId: string;
  readonly accountKey: string;
  readonly day: string;
  readonly model: string;
  readonly origin: ShareOrigin;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
}

export interface ShareMachine {
  readonly machineId: string;
  readonly name: string;
  readonly state: ShareMachineState;
  /** When the machine built the report shown; null when there is none. */
  readonly readAt: string | null;
  readonly note: string | null;
}

export interface SubscriptionMachine {
  readonly machineId: string;
  readonly app: ShareTotals;
  readonly native: ShareTotals;
  readonly unsplit: ShareTotals;
  readonly total: ShareTotals;
  /** The account is signed in on the machine. */
  readonly holds: boolean;
}

export interface SubscriptionHour {
  readonly hourStartMs: number;
  readonly costUsd: number;
  readonly tokens: number;
}

export interface SubscriptionShare {
  readonly accountKey: string;
  readonly driver: string;
  /** The email or login in the key, when it holds one. */
  readonly name: string | null;
  /** A provider instance's name for the account, when a machine sent one. */
  readonly label: string | null;
  /** No machine could name the account these sessions ran on. */
  readonly unknown: boolean;
  /** The weakest rule that named any of the account's cells, on any machine. */
  readonly identity: UsageAccountIdentityRule;
  readonly total: ShareTotals;
  /** Machines with use in the period or signed in to the account, most used first. */
  readonly machines: readonly SubscriptionMachine[];
  /** Names of machines that hold the account and did not report up to the period's end. */
  readonly silentHolders: readonly string[];
  /** Recorded use per hour on every reporting machine, for the outside estimate. */
  readonly hours: readonly SubscriptionHour[];
  /** First instant every contributing machine's hours cover; null without hours. */
  readonly hoursSinceMs: number | null;
  /**
   * The period starts inside its first day and some of that day's use could
   * not be cut there (its hours are no longer kept, or an older machine sent
   * totals only), so that use counts for the whole day.
   */
  readonly firstDayWhole: boolean;
}

export interface MachineShare {
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly days: readonly string[];
  readonly machines: readonly ShareMachine[];
  /** Most used first, by API-equivalent cost and then tokens. */
  readonly subscriptions: readonly SubscriptionShare[];
  readonly rows: readonly ShareRow[];
}

const RULES: readonly UsageAccountIdentityRule[] = ["recorded", "history", "current", "unknown"];
const STATE_ORDER: Record<ShareMachineState, number> = {
  live: 0,
  cached: 1,
  summary: 2,
  missing: 3,
};

/** The driver behind a transcript provider kind. */
function driverOfProvider(provider: string): string {
  return provider === "claude" ? "claudeAgent" : provider;
}

/**
 * A stand-in report from a usage summary, for a machine too old to send one.
 * A provider's use goes to the account signed in for it when there is exactly
 * one, else to an unknown account. Cursor is left out: its summary is the
 * account's history from the vendor, the same on every machine.
 */
export function reportFromSummary(
  summary: UsageSummary,
  heldAccountKeys: readonly string[],
): ShareReport {
  const heldByDriver = new Map<string, string[]>();
  for (const accountKey of heldAccountKeys) {
    const driver = usageAccountKeyDriver(accountKey);
    heldByDriver.set(driver, [...(heldByDriver.get(driver) ?? []), accountKey]);
  }
  const sources: Array<{ key: string; provider: string }> = [];
  const sourceIndex = new Map<string, number>();
  const sourcesOfProvider = (provider: string) =>
    summary.sources.filter((source) => source.fingerprint.provider === provider);
  const accounts = new Map<string, UsageAccountIdentityRule>();
  const cells: ShareCell[] = [];
  for (const bucket of summary.buckets) {
    if (bucket.provider === "cursor" || bucket.hourStart !== undefined) continue;
    const driver = driverOfProvider(bucket.provider);
    const held = heldByDriver.get(driver) ?? [];
    const accountKey = held.length === 1 ? held[0]! : unknownUsageAccountKey(driver);
    accounts.set(accountKey, held.length === 1 ? "current" : "unknown");
    const candidates = sourcesOfProvider(bucket.provider);
    const source =
      candidates.find((entry) => entry.fingerprint.resolvedHomePath === bucket.sourcePath) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    let index: number | undefined;
    if (source !== undefined) {
      const key = fingerprintKey(source.fingerprint);
      index = sourceIndex.get(key);
      if (index === undefined) {
        index = sources.length;
        sources.push({ key, provider: bucket.provider });
        sourceIndex.set(key, index);
      }
    }
    const totals = bucket.totals;
    cells.push({
      day: bucket.day,
      accountKey,
      model: bucket.model,
      origin: "unsplit",
      ...(index === undefined ? {} : { source: index }),
      tokens:
        totals.uncachedInputTokens +
        totals.cachedInputTokens +
        totals.cacheCreationTokens +
        totals.outputTokens +
        totals.reasoningTokens,
      costUsd: bucket.costUsd,
      requests: bucket.records,
      unpricedRequests: bucket.unpricedRecords,
      sessions: bucket.sessions,
    });
  }
  return {
    version: 0,
    readAt: summary.readAt,
    timeZone: summary.timeZone,
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    accounts: [...accounts].flatMap(([accountKey, identity]) => [
      {
        accountKey,
        // The schema's brand is not needed to group by it.
        driver: usageAccountKeyDriver(
          accountKey,
        ) as UsageMachineReport["accounts"][number]["driver"],
        identity,
        signedIn: !isUnknownUsageAccountKey(accountKey),
      },
    ]),
    sources,
    projects: [],
    cells,
    hourly: [],
    hourlySinceMs: 0,
  };
}

/** What a client knows of one machine when it builds the view. */
export interface ShareMachineSource {
  readonly machineId: string;
  readonly name: string;
  readonly connected: boolean;
  /** The machine's version can send a report. */
  readonly canReport: boolean;
  /** This device may read the machine's usage. */
  readonly permitted: boolean;
  readonly heldAccountKeys: readonly string[];
  /** The machine's answer to this read: a report, a failure, or nothing yet. */
  readonly answer: ShareReport | "failed" | null;
  /** The last report this device kept from the machine. */
  readonly kept: ShareReport | null;
  /** The machine's usage summary, which stands in when it cannot send a report. */
  readonly summary: UsageSummary | null;
}

/** Which of a machine's reports to show, and what to say when there is none. */
export function shareMachineInput(source: ShareMachineSource): ShareMachineInput {
  const base = {
    machineId: source.machineId,
    name: source.name,
    heldAccountKeys: source.heldAccountKeys,
  };
  const asked = source.connected && source.canReport && source.permitted;
  if (asked && source.answer !== null && source.answer !== "failed") {
    return { ...base, state: "live", report: source.answer };
  }
  // A machine that answered before and cannot now keeps its last answer.
  if (source.kept !== null && (!source.connected || asked)) {
    return { ...base, state: "cached", report: source.kept };
  }
  if (!source.connected) return { ...base, state: "missing", report: null, note: "out of reach" };
  if (asked) {
    return {
      ...base,
      state: "missing",
      report: null,
      note: source.answer === null ? "reading" : "could not report",
    };
  }
  if (!source.permitted) {
    return { ...base, state: "missing", report: null, note: "this device may not read its usage" };
  }
  if (source.summary === null) {
    return { ...base, state: "missing", report: null, note: "needs an update to report" };
  }
  return {
    ...base,
    state: "summary",
    report: reportFromSummary(source.summary, source.heldAccountKeys),
    note: "older version, totals only",
  };
}

export interface MergeMachineShareOptions {
  readonly sinceDay: string;
  readonly untilDay: string;
  /**
   * The end of the period as an instant. A machine whose report was built
   * more than two hours before it has not reported the whole period.
   */
  readonly periodEndMs: number;
  /**
   * Set when the period starts inside its first day (a limit reset at 6 PM):
   * the day's bounds and the instant the period starts. That day's cells then
   * count in the proportion of the machine's hourly use from that instant on.
   */
  readonly firstDay?: {
    readonly startMs: number;
    readonly endMs: number;
    readonly fromMs: number;
  };
}

/**
 * The share of one machine's use on the first day that falls in the period,
 * per account and origin (per account alone for hours kept from before they
 * were split). Cells are per day, so the hourly series decides. Null when the
 * hours do not reach back to that day: nothing can cut it then.
 */
function firstDayShares(
  report: ShareReport,
  usable: readonly boolean[],
  cut: NonNullable<MergeMachineShareOptions["firstDay"]>,
): ((accountKey: string, origin: ShareOrigin) => number | null) | null {
  if (report.hourlySinceMs > cut.startMs) return null;
  const sums = new Map<
    string,
    { cost: number; costIn: number; tokens: number; tokensIn: number }
  >();
  const add = (key: string, costUsd: number, tokens: number, inside: number) => {
    const sum = sums.get(key) ?? { cost: 0, costIn: 0, tokens: 0, tokensIn: 0 };
    sum.cost += costUsd;
    sum.costIn += costUsd * inside;
    sum.tokens += tokens;
    sum.tokensIn += tokens * inside;
    sums.set(key, sum);
  };
  const split = new Set<string>();
  for (const hour of report.hourly) {
    if (hour.source !== undefined && usable[hour.source] === false) continue;
    if (hour.hourStartMs < cut.startMs || hour.hourStartMs >= cut.endMs) continue;
    const inside = Math.min(1, Math.max(0, (hour.hourStartMs + HOUR_MS - cut.fromMs) / HOUR_MS));
    add(hour.accountKey, hour.costUsd, hour.tokens, inside);
    if (hour.origin === undefined) continue;
    split.add(hour.accountKey);
    add(`${hour.accountKey}\u0000${hour.origin}`, hour.costUsd, hour.tokens, inside);
  }
  return (accountKey, origin) => {
    const sum = sums.get(split.has(accountKey) ? `${accountKey}\u0000${origin}` : accountKey);
    if (sum === undefined) return null;
    if (sum.cost > 0) return sum.costIn / sum.cost;
    return sum.tokens > 0 ? sum.tokensIn / sum.tokens : 1;
  };
}

interface MutableSubscription {
  readonly accountKey: string;
  label: string | null;
  identity: UsageAccountIdentityRule;
  readonly machines: Map<string, { app: ShareTotals; native: ShareTotals; unsplit: ShareTotals }>;
  readonly holders: Set<string>;
  readonly hours: Map<number, { costUsd: number; tokens: number }>;
  hoursSinceMs: number | null;
  firstDayWhole: boolean;
}

export function mergeMachineShare(
  inputs: readonly ShareMachineInput[],
  options: MergeMachineShareOptions,
): MachineShare {
  // A folder two machines both read goes to the better-informed one.
  const ordered = [...inputs].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const claimed = new Map<string, string>();
  const subscriptions = new Map<string, MutableSubscription>();
  const rows: ShareRow[] = [];
  const names = new Map(inputs.map((input) => [input.machineId, input.name]));

  const subscription = (accountKey: string): MutableSubscription => {
    let entry = subscriptions.get(accountKey);
    if (entry === undefined) {
      entry = {
        accountKey,
        label: null,
        identity: "recorded",
        machines: new Map(),
        holders: new Set(),
        hours: new Map(),
        hoursSinceMs: null,
        firstDayWhole: false,
      };
      subscriptions.set(accountKey, entry);
    }
    return entry;
  };
  const weaker = (a: UsageAccountIdentityRule, b: UsageAccountIdentityRule) =>
    RULES.indexOf(a) >= RULES.indexOf(b) ? a : b;

  for (const input of ordered) {
    for (const accountKey of input.heldAccountKeys)
      subscription(accountKey).holders.add(input.machineId);
    const report = input.report;
    if (report === null) continue;
    const usable = report.sources.map((source) => {
      const owner = claimed.get(source.key);
      if (owner === undefined) claimed.set(source.key, input.machineId);
      return owner === undefined || owner === input.machineId;
    });
    const projectTitles = new Map(
      report.projects.map((project) => [project.projectId, project.title]),
    );
    const withUse = new Set<string>();
    const cut =
      options.firstDay !== undefined && options.firstDay.fromMs > options.firstDay.startMs
        ? options.firstDay
        : null;
    const firstDay = cut === null ? null : firstDayShares(report, usable, cut);
    for (const cell of report.cells) {
      if (cell.source !== undefined && usable[cell.source] === false) continue;
      if (cell.day < options.sinceDay || cell.day > options.untilDay) continue;
      let kept = 1;
      if (cut !== null && cell.day === options.sinceDay) {
        const share = firstDay === null ? null : firstDay(cell.accountKey, cell.origin);
        // Nothing says when in the day this was used, so the day stays whole and says so.
        if (share === null) subscription(cell.accountKey).firstDayWhole = true;
        else kept = share;
      }
      if (kept <= 0) continue;
      withUse.add(cell.accountKey);
      const totals: ShareTotals = {
        costUsd: cell.costUsd * kept,
        tokens: cell.tokens * kept,
        requests: cell.requests * kept,
        unpricedRequests: cell.unpricedRequests * kept,
      };
      const entry = subscription(cell.accountKey);
      const machine = entry.machines.get(input.machineId) ?? {
        app: ZERO,
        native: ZERO,
        unsplit: ZERO,
      };
      machine[cell.origin] = plus(machine[cell.origin], totals);
      entry.machines.set(input.machineId, machine);
      rows.push({
        machineId: input.machineId,
        accountKey: cell.accountKey,
        day: cell.day,
        model: cell.model,
        origin: cell.origin,
        projectId: cell.projectId ?? null,
        projectTitle:
          cell.projectId === undefined ? null : (projectTitles.get(cell.projectId) ?? null),
        ...totals,
      });
    }
    for (const account of report.accounts) {
      const entry = subscriptions.get(account.accountKey);
      if (account.signedIn) subscription(account.accountKey).holders.add(input.machineId);
      if (entry === undefined && !account.signedIn) continue;
      const target = subscription(account.accountKey);
      if (account.label !== undefined && target.label === null) target.label = account.label;
      if (withUse.has(account.accountKey))
        target.identity = weaker(target.identity, account.identity);
    }
    const withHours = new Set<string>();
    for (const hour of report.hourly) {
      if (hour.source !== undefined && usable[hour.source] === false) continue;
      const entry = subscription(hour.accountKey);
      const known = entry.hours.get(hour.hourStartMs) ?? { costUsd: 0, tokens: 0 };
      entry.hours.set(hour.hourStartMs, {
        costUsd: known.costUsd + hour.costUsd,
        tokens: known.tokens + hour.tokens,
      });
      withHours.add(hour.accountKey);
    }
    // Hours are comparable to the limit only from where every contributor's start.
    if (input.state !== "summary") {
      for (const entry of subscriptions.values()) {
        if (!withHours.has(entry.accountKey) && !entry.holders.has(input.machineId)) continue;
        entry.hoursSinceMs = Math.max(entry.hoursSinceMs ?? 0, report.hourlySinceMs);
      }
    }
  }

  const reported = (input: ShareMachineInput): boolean => {
    if (input.report === null || input.state === "missing" || input.state === "summary")
      return false;
    if (input.state === "live") return true;
    const readAt = Date.parse(input.report.readAt);
    return Number.isFinite(readAt) && readAt >= options.periodEndMs - 2 * HOUR_MS;
  };
  const silent = new Set(
    inputs.filter((input) => !reported(input)).map((input) => input.machineId),
  );

  const result: SubscriptionShare[] = [];
  for (const entry of subscriptions.values()) {
    const machineIds = new Set([...entry.machines.keys(), ...entry.holders]);
    const machines: SubscriptionMachine[] = [...machineIds].map((machineId) => {
      const parts = entry.machines.get(machineId) ?? { app: ZERO, native: ZERO, unsplit: ZERO };
      return {
        machineId,
        ...parts,
        total: plus(plus(parts.app, parts.native), parts.unsplit),
        holds: entry.holders.has(machineId),
      };
    });
    machines.sort(
      (a, b) =>
        b.total.costUsd - a.total.costUsd ||
        b.total.tokens - a.total.tokens ||
        (names.get(a.machineId) ?? "").localeCompare(names.get(b.machineId) ?? ""),
    );
    const total = machines.reduce((sum, machine) => plus(sum, machine.total), ZERO);
    // An account nobody holds any more and nobody used in the period is not shown.
    if (total.requests === 0 && total.tokens === 0 && entry.holders.size === 0) continue;
    const hours = [...entry.hours]
      .map(([hourStartMs, hour]) => ({ hourStartMs, ...hour }))
      .sort((a, b) => a.hourStartMs - b.hourStartMs);
    result.push({
      accountKey: entry.accountKey,
      driver: usageAccountKeyDriver(entry.accountKey),
      name: usageAccountKeyName(entry.accountKey),
      label: entry.label,
      unknown: isUnknownUsageAccountKey(entry.accountKey),
      identity: entry.identity,
      total,
      machines,
      silentHolders: [...entry.holders]
        .filter((machineId) => silent.has(machineId))
        .map((machineId) => names.get(machineId) ?? machineId)
        .sort((a, b) => a.localeCompare(b)),
      hours,
      hoursSinceMs: hours.length === 0 ? null : entry.hoursSinceMs,
      firstDayWhole: entry.firstDayWhole,
    });
  }
  result.sort(
    (a, b) =>
      b.total.costUsd - a.total.costUsd ||
      b.total.tokens - a.total.tokens ||
      a.accountKey.localeCompare(b.accountKey),
  );

  return {
    sinceDay: options.sinceDay,
    untilDay: options.untilDay,
    days: enumerateDays(options.sinceDay, options.untilDay),
    machines: inputs.map((input) => ({
      machineId: input.machineId,
      name: input.name,
      state: input.state,
      readAt: input.report?.readAt ?? null,
      note: input.note ?? null,
    })),
    subscriptions: result,
    rows,
  };
}

/**
 * The hours the outside estimate weighs, in one unit for the whole account:
 * API-equivalent cost, or tokens when none of the account's use has a price.
 */
export function recordedHours(subscription: SubscriptionShare): readonly RecordedHour[] {
  const priced = subscription.hours.some((hour) => hour.costUsd > 0);
  return subscription.hours.map((hour) => ({
    hourStartMs: hour.hourStartMs,
    weight: priced ? hour.costUsd : hour.tokens,
  }));
}

/** One part of a subscription's bar. */
export interface ShareSegment {
  readonly key: string;
  readonly kind: ShareOrigin | "outside";
  /** Null for the outside estimate. */
  readonly machineId: string | null;
  /** In the measure asked for; null when the outside part has no rate to convert with. */
  readonly value: number | null;
  /** Of the whole bar, 0 to 1. */
  readonly share: number;
}

/** What one limit point is worth in `measure`, by what the machines recorded. Null without a rate. */
function measurePerPoint(
  subscription: SubscriptionShare,
  measure: ShareMeasure,
  estimate: OutsideResult | null,
): number | null {
  if (estimate === null || estimate.kind !== "estimate" || !estimate.detected) return null;
  if (estimate.explainedPoints <= 0) return null;
  const recorded = measureOf(subscription.total, measure);
  return recorded > 0 ? recorded / estimate.explainedPoints : null;
}

/**
 * The parts of a subscription's bar: each machine's in-app and outside-the-app
 * use, then the estimate of use on no reporting machine. Parts with nothing in
 * them are left out.
 */
export function shareSegments(
  subscription: SubscriptionShare,
  measure: ShareMeasure,
  estimate: OutsideResult | null,
): readonly ShareSegment[] {
  const parts: Array<Omit<ShareSegment, "share">> = [];
  for (const machine of subscription.machines) {
    for (const kind of ["app", "native", "unsplit"] as const) {
      const value = measureOf(machine[kind], measure);
      if (value > 0) {
        parts.push({
          key: `${machine.machineId}:${kind}`,
          kind,
          machineId: machine.machineId,
          value,
        });
      }
    }
  }
  const recorded = parts.reduce((sum, part) => sum + (part.value ?? 0), 0);
  const perPoint = measurePerPoint(subscription, measure, estimate);
  let outside: number | null = null;
  if (estimate !== null && estimate.kind === "estimate" && estimate.detected) {
    if (perPoint !== null) outside = estimate.outsidePoints * perPoint;
    else if (recorded === 0) {
      // Nothing recorded and the limit moved: the bar is all outside.
      return [{ key: "outside", kind: "outside", machineId: null, value: null, share: 1 }];
    }
  }
  if (outside !== null && outside > 0) {
    parts.push({ key: "outside", kind: "outside", machineId: null, value: outside });
  }
  const whole = parts.reduce((sum, part) => sum + (part.value ?? 0), 0);
  return parts.map((part) => ({ ...part, share: whole > 0 ? (part.value ?? 0) / whole : 0 }));
}

export interface ShareTrendDay {
  readonly day: string;
  /** One entry per machine and origin with use on the day, in the bar's machine order. */
  readonly parts: ReadonlyArray<{
    readonly key: string;
    readonly kind: ShareOrigin;
    readonly machineId: string;
    readonly value: number;
  }>;
  /** The outside estimate for the day in the same measure; null when there is none. */
  readonly outside: number | null;
  readonly total: number;
}

/** A subscription's use per day, stacked by machine, for the trend chart. */
export function shareTrend(
  share: MachineShare,
  subscription: SubscriptionShare,
  measure: ShareMeasure,
  estimate: OutsideResult | null,
): readonly ShareTrendDay[] {
  const byDay = new Map<string, Map<string, ShareTotals>>();
  for (const row of share.rows) {
    if (row.accountKey !== subscription.accountKey) continue;
    const day = byDay.get(row.day) ?? new Map<string, ShareTotals>();
    const key = `${row.machineId}:${row.origin}`;
    day.set(key, plus(day.get(key) ?? ZERO, row));
    byDay.set(row.day, day);
  }
  const perPoint = measurePerPoint(subscription, measure, estimate);
  const outsideByDay = new Map<string, number>();
  if (perPoint !== null && estimate !== null && estimate.kind === "estimate") {
    for (const day of estimate.days) outsideByDay.set(day.day, day.points * perPoint);
  }
  return share.days.map((day) => {
    const totals = byDay.get(day);
    const parts: Array<ShareTrendDay["parts"][number]> = [];
    for (const machine of subscription.machines) {
      for (const kind of ["app", "native", "unsplit"] as const) {
        const key = `${machine.machineId}:${kind}`;
        const value = measureOf(totals?.get(key) ?? ZERO, measure);
        if (value > 0) parts.push({ key, kind, machineId: machine.machineId, value });
      }
    }
    const outside = outsideByDay.get(day) ?? null;
    return {
      day,
      parts,
      outside: outside !== null && outside > 0 ? outside : null,
      total: parts.reduce((sum, part) => sum + part.value, 0) + (outside ?? 0),
    };
  });
}

export interface ShareBreakdownEntry extends ShareTotals {
  readonly key: string;
  readonly label: string;
}

export interface ShareBreakdown {
  readonly total: ShareTotals;
  readonly models: readonly ShareBreakdownEntry[];
  readonly projects: readonly ShareBreakdownEntry[];
  readonly days: readonly ShareBreakdownEntry[];
  readonly origins: readonly ShareBreakdownEntry[];
}

const ORIGIN_LABELS: Record<ShareOrigin, string> = {
  app: "In SpecWithCode",
  native: "Outside the app on this machine",
  unsplit: "Not split (older version)",
};

/** Where a subscription's use went, for all machines or one: by model, project, day and origin. */
export function shareBreakdown(
  share: MachineShare,
  accountKey: string,
  machineId: string | null,
  measure: ShareMeasure,
): ShareBreakdown {
  const groups = {
    models: new Map<string, ShareBreakdownEntry>(),
    projects: new Map<string, ShareBreakdownEntry>(),
    days: new Map<string, ShareBreakdownEntry>(),
    origins: new Map<string, ShareBreakdownEntry>(),
  };
  const add = (
    group: Map<string, ShareBreakdownEntry>,
    key: string,
    label: string,
    row: ShareRow,
  ) => {
    const known = group.get(key);
    group.set(key, { key, label, ...plus(known ?? ZERO, row) });
  };
  let total = ZERO;
  for (const row of share.rows) {
    if (row.accountKey !== accountKey) continue;
    if (machineId !== null && row.machineId !== machineId) continue;
    total = plus(total, row);
    add(groups.models, row.model, row.model, row);
    add(groups.days, row.day, row.day, row);
    add(groups.origins, row.origin, ORIGIN_LABELS[row.origin], row);
    if (row.origin === "app") {
      add(
        groups.projects,
        row.projectId ?? "",
        row.projectId === null ? "No project" : (row.projectTitle ?? "Removed project"),
        row,
      );
    } else {
      add(groups.projects, `\u0000${row.origin}`, ORIGIN_LABELS[row.origin], row);
    }
  }
  const ranked = (group: Map<string, ShareBreakdownEntry>) =>
    [...group.values()].sort(
      (a, b) =>
        measureOf(b, measure) - measureOf(a, measure) ||
        b.tokens - a.tokens ||
        a.label.localeCompare(b.label),
    );
  return {
    total,
    models: ranked(groups.models),
    projects: ranked(groups.projects),
    days: [...groups.days.values()].sort((a, b) => a.key.localeCompare(b.key)),
    origins: ranked(groups.origins),
  };
}
