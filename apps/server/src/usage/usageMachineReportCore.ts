/**
 * Folds one machine's usage into `(day, account, model, origin, project,
 * source)` cells and an hourly series per account.
 *
 * Two feeds: transcript records, each named by the folder it came from, and
 * turns SpecWithCode recorded for providers that keep no transcript. A record
 * whose session a thread owns is `app` and takes that thread's project; any
 * other is `native`.
 *
 * Pure, so the grouping rules are testable without files or a database.
 *
 * @module usage/usageMachineReportCore
 */
import type {
  UsageAccountIdentityRule,
  UsageMachineCell,
  UsageMachineHour,
  UsageMachineOrigin,
  UsageMachineSource,
  UsageTokenTotals,
} from "@specweave-studio/contracts";

import type { ResolvedAccount } from "./usageAccountSpans.ts";
import { makeDayFormatter } from "./usageAggregation.ts";
import { totalTokens } from "./usageTranscripts.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Strongest first; an account's identity is the weakest rule any of its cells used. */
const RULE_ORDER: readonly UsageAccountIdentityRule[] = [
  "recorded",
  "history",
  "current",
  "unknown",
];

export function weakerRule(
  a: UsageAccountIdentityRule,
  b: UsageAccountIdentityRule,
): UsageAccountIdentityRule {
  return RULE_ORDER.indexOf(a) >= RULE_ORDER.indexOf(b) ? a : b;
}

export interface MachineReportOptions {
  readonly timeZone: string;
  /** Cells are kept for days in this range; the hourly series has its own start. */
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly hourlySinceMs: number;
  /**
   * Native session id to the project of the thread that owns it; null for a
   * thread without a project. A session missing here is not SpecWithCode's.
   */
  readonly ownedSessions: ReadonlyMap<string, string | null>;
}

export interface MachineReportSource {
  /** Fingerprint key shared by every environment that reads this folder. */
  readonly key: string;
  readonly provider: string;
  /** Names the account of a record written at the given time. */
  readonly resolve: (atMs: number) => ResolvedAccount;
}

/** The fields of a transcript record the report reads. */
export interface MachineReportRecord {
  readonly timestampMs: number;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
}

export interface MachineReportTurn {
  readonly atMs: number;
  readonly account: ResolvedAccount;
  readonly model: string;
  readonly tokens: number;
  /** Null when the turn's tokens have no known price. */
  readonly costUsd: number | null;
  readonly projectId: string | null;
  /** Groups turns of one conversation, for the session count. */
  readonly sessionKey: string;
}

export interface MachineReportResult {
  readonly cells: readonly UsageMachineCell[];
  readonly hourly: readonly UsageMachineHour[];
  /** Only folders that contributed, re-indexed; cells and hours point into it. */
  readonly sources: readonly UsageMachineSource[];
  readonly identities: ReadonlyMap<string, UsageAccountIdentityRule>;
}

interface MutableCell {
  readonly day: string;
  readonly accountKey: string;
  readonly model: string;
  readonly origin: UsageMachineOrigin;
  readonly projectId: string | null;
  readonly source: number | null;
  tokens: number;
  costUsd: number;
  requests: number;
  unpricedRequests: number;
  readonly sessions: Set<string>;
}

interface MutableHour {
  readonly hourStartMs: number;
  readonly accountKey: string;
  readonly origin: UsageMachineOrigin;
  readonly source: number | null;
  tokens: number;
  costUsd: number;
  requests: number;
}

/** Micro-dollars are enough, and shorter numbers are cheaper on the wire. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export class MachineReportBuilder {
  readonly #options: MachineReportOptions;
  readonly #toDay: (timestampMs: number) => string;
  readonly #sources = new Map<number, MachineReportSource>();
  readonly #cells = new Map<string, MutableCell>();
  readonly #hours = new Map<string, MutableHour>();
  readonly #identities = new Map<string, UsageAccountIdentityRule>();
  #lastCell: { readonly key: string; readonly cell: MutableCell } | null = null;

  constructor(options: MachineReportOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
  }

  /** Describes a transcript folder before its records arrive. Folders never described are skipped. */
  setSource(index: number, source: MachineReportSource): void {
    this.#sources.set(index, source);
  }

  addRecord(
    record: MachineReportRecord,
    sourceIndex: number,
    model: string,
    costUsd: number,
    unpriced: boolean,
  ): void {
    const source = this.#sources.get(sourceIndex);
    if (source === undefined) return;
    const owner = this.#options.ownedSessions.get(record.sessionId);
    this.#add({
      atMs: record.timestampMs,
      account: source.resolve(record.timestampMs),
      model,
      origin: owner === undefined ? "native" : "app",
      projectId: owner ?? null,
      source: sourceIndex,
      tokens: totalTokens(record.totals),
      costUsd,
      unpriced,
      sessionKey: record.sessionId,
    });
  }

  addTurn(turn: MachineReportTurn): void {
    this.#add({
      atMs: turn.atMs,
      account: turn.account,
      model: turn.model,
      origin: "app",
      projectId: turn.projectId,
      source: null,
      tokens: turn.tokens,
      costUsd: turn.costUsd ?? 0,
      unpriced: turn.costUsd === null,
      sessionKey: turn.sessionKey,
    });
  }

  #add(input: {
    readonly atMs: number;
    readonly account: ResolvedAccount;
    readonly model: string;
    readonly origin: UsageMachineOrigin;
    readonly projectId: string | null;
    readonly source: number | null;
    readonly tokens: number;
    readonly costUsd: number;
    readonly unpriced: boolean;
    readonly sessionKey: string;
  }): void {
    const { accountKey, rule } = input.account;
    const day = this.#toDay(input.atMs);
    const inDays = day >= this.#options.sinceDay && day <= this.#options.untilDay;
    const inHours = input.atMs >= this.#options.hourlySinceMs;
    if (!inDays && !inHours) return;
    const known = this.#identities.get(accountKey);
    this.#identities.set(accountKey, known === undefined ? rule : weakerRule(known, rule));
    const tokens = Math.max(0, Math.round(input.tokens));

    if (inDays) {
      const key = [
        day,
        accountKey,
        input.model,
        input.origin,
        input.projectId ?? "",
        input.source ?? "",
      ].join("\u0000");
      let cell = this.#lastCell?.key === key ? this.#lastCell.cell : this.#cells.get(key);
      if (cell === undefined) {
        cell = {
          day,
          accountKey,
          model: input.model,
          origin: input.origin,
          projectId: input.projectId,
          source: input.source,
          tokens: 0,
          costUsd: 0,
          requests: 0,
          unpricedRequests: 0,
          sessions: new Set<string>(),
        };
        this.#cells.set(key, cell);
      }
      this.#lastCell = { key, cell };
      cell.tokens += tokens;
      cell.costUsd += input.costUsd;
      cell.requests += 1;
      if (input.unpriced) cell.unpricedRequests += 1;
      if (input.sessionKey.length > 0) cell.sessions.add(input.sessionKey);
    }

    if (inHours) {
      const hourStartMs = Math.floor(input.atMs / HOUR_MS) * HOUR_MS;
      const key = `${hourStartMs}\u0000${accountKey}\u0000${input.origin}\u0000${input.source ?? ""}`;
      let hour = this.#hours.get(key);
      if (hour === undefined) {
        hour = {
          hourStartMs,
          accountKey,
          origin: input.origin,
          source: input.source,
          tokens: 0,
          costUsd: 0,
          requests: 0,
        };
        this.#hours.set(key, hour);
      }
      hour.tokens += tokens;
      hour.costUsd += input.costUsd;
      hour.requests += 1;
    }
  }

  finish(): MachineReportResult {
    // Only folders something came from travel, so their indexes are remapped.
    const used = new Set<number>();
    for (const cell of this.#cells.values()) if (cell.source !== null) used.add(cell.source);
    for (const hour of this.#hours.values()) if (hour.source !== null) used.add(hour.source);
    const order = [...used].sort((a, b) => a - b);
    const remap = new Map(order.map((index, position) => [index, position]));
    const sources = order.map((index): UsageMachineSource => {
      const source = this.#sources.get(index)!;
      return { key: source.key, provider: source.provider };
    });

    const cells = [...this.#cells.values()]
      .map((cell): UsageMachineCell => ({
        day: cell.day as UsageMachineCell["day"],
        accountKey: cell.accountKey,
        model: cell.model,
        origin: cell.origin,
        ...(cell.projectId === null ? {} : { projectId: cell.projectId }),
        ...(cell.source === null ? {} : { source: remap.get(cell.source)! }),
        tokens: cell.tokens,
        costUsd: roundUsd(cell.costUsd),
        requests: cell.requests,
        unpricedRequests: cell.unpricedRequests,
        sessions: cell.sessions.size,
      }))
      // Stable ordering keeps payloads diffable and snapshot tests meaningful.
      .sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          a.accountKey.localeCompare(b.accountKey) ||
          a.model.localeCompare(b.model) ||
          a.origin.localeCompare(b.origin) ||
          (a.projectId ?? "").localeCompare(b.projectId ?? "") ||
          (a.source ?? -1) - (b.source ?? -1),
      );

    const hourly = [...this.#hours.values()]
      .map((hour): UsageMachineHour => ({
        hourStartMs: hour.hourStartMs,
        accountKey: hour.accountKey,
        origin: hour.origin,
        ...(hour.source === null ? {} : { source: remap.get(hour.source)! }),
        tokens: hour.tokens,
        costUsd: roundUsd(hour.costUsd),
        requests: hour.requests,
      }))
      .sort(
        (a, b) =>
          a.hourStartMs - b.hourStartMs ||
          a.accountKey.localeCompare(b.accountKey) ||
          (a.origin ?? "").localeCompare(b.origin ?? "") ||
          (a.source ?? -1) - (b.source ?? -1),
      );

    return { cells, hourly, sources, identities: this.#identities };
  }
}
