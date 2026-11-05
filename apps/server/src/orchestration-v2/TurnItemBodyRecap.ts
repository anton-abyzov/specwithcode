/**
 * Caps tool bodies saved before the write-time cap existed.
 *
 * EventSink caps every new turn item (TurnItemBodyCap.ts), but rows saved
 * before that hold their tool output whole: on one machine 8,881 command and
 * tool items over 64 KB held 2.7 GB, and only 48 of them were cut. This pass
 * applies the same cap, with the same function and policy as the write path,
 * to old rows of `orchestration_v2_projection_turn_items`, so a capped item
 * comes out as it would have been saved today and a row capped already is
 * left alone.
 *
 * Which rows: command and tool items in a final status (never one still
 * running) whose `payload_json` is over the cap, that carry no `bodyCut` yet,
 * and that were last updated before the thread-history horizon
 * (`threadHistoryDays`); with no horizon nothing is capped, and archiving a
 * thread (which can be undone) never cuts it sooner. Threads another
 * machine owns or that moved by handoff are skipped, as retention skips them.
 * File changes, images, HTML render tools and every other item stay whole,
 * because the cap function never cuts them; an item it leaves unchanged is
 * not written.
 *
 * Only the fields the cap changed are replaced in the stored JSON, so a field
 * this build does not know survives. Only `payload_json` of the projection row
 * changes. The event log is never
 * updated: the update helper refuses in-place edits of log rows
 * (`scripts/studio-fleet/after_proof.py`, `old-log-row-changed`), while
 * projection tables (`update_read.py` `is_projection_table`) may change.
 * A rebuild that replays a thread's older events writes the uncapped item
 * again, and a later cycle caps it again.
 *
 * Each update is one row in its own transaction, behind the same checks as
 * retention (`shouldContinue` before it, `mayDelete` inside it), so nothing is
 * written while an update helper holds a snapshot or the install gate. Rows
 * are read in rowid windows, so each read statement walks a bounded slice of
 * the table; the caller keeps the cursor between passes and starts over once
 * a cycle reached the end.
 *
 * @module TurnItemBodyRecap
 */
import {
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  capTurnItemBody,
  DEFAULT_TURN_ITEM_BODY_CAP,
  type TurnItemBodyCapPolicy,
} from "./TurnItemBodyCap.ts";

export interface TurnItemBodyRecapOptions {
  /** Items last updated more than this many days ago are capped; null caps nothing. */
  readonly historyDays: number | null;
  readonly nowMs: number;
  /** Rowid the last pass stopped after; 0 starts a cycle. */
  readonly afterRowid?: number;
  /** The cap; the write path's by default, so a capped item caps to itself. */
  readonly policy?: TurnItemBodyCapPolicy;
  /** Checked before every update; false stops the pass (`interrupted`). */
  readonly shouldContinue?: Effect.Effect<boolean>;
  /** Checked synchronously inside each update's transaction, right before it. */
  readonly mayDelete?: () => boolean;
  /** Pacing between updates and windows, outside transactions. */
  readonly betweenBatches?: Effect.Effect<void>;
  /** Rows one read statement walks at most. */
  readonly scanWindow?: number;
  /** Candidate rows one read statement returns at most. */
  readonly batchSize?: number;
  /** Wall-clock milliseconds one pass may take, pauses included. */
  readonly timeBudgetMs?: number;
}

export interface TurnItemBodyRecapResult {
  readonly interrupted: boolean;
  /** The pass stopped at its time budget, not at a gate; the next pass goes on. */
  readonly budgetExhausted: boolean;
  /** The pass walked to the table's last row: the cycle is complete. */
  readonly reachedEnd: boolean;
  /** Rowid the pass stopped after: the next pass's `afterRowid`. */
  readonly throughRowid: number;
  /** Rows whose payload was capped and written. */
  readonly cappedItemCount: number;
  /** Candidates the cap left unchanged (exempt tools, many short strings). */
  readonly unchangedItemCount: number;
  /** Candidates this build cannot decode, or that changed between read and write. */
  readonly skippedItemCount: number;
  /** UTF-8 bytes of payload the capped rows no longer hold. */
  readonly savedBytes: number;
}

export const RECAP_SCAN_WINDOW = 2_000;
export const RECAP_BATCH_SIZE = 8;
const DAY_MS = 24 * 60 * 60_000;
const FINAL_STATUSES = ["completed", "failed", "cancelled", "interrupted"];
const CAPPED_TYPES = ["command_execution", "dynamic_tool"];

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

/**
 * The stored JSON with only the top-level fields the cap changed (and the
 * `bodyCut` it added) taken from the capped item's encoding: everything else
 * stays as stored, fields this build's schema does not know included.
 */
export const mergeCapped = (
  stored: string,
  item: OrchestrationV2TurnItem,
  capped: OrchestrationV2TurnItem,
  encodedCapped: string,
): string | null => {
  const raw: unknown = JSON.parse(stored);
  const next: unknown = JSON.parse(encodedCapped);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (next === null || typeof next !== "object" || Array.isArray(next)) return null;
  const before = item as unknown as Record<string, unknown>;
  const after = capped as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    const value = (next as Record<string, unknown>)[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return JSON.stringify(merged);
};

type Candidate = {
  readonly row_id: number;
  readonly turn_item_id: string;
  readonly updated_at: string;
  readonly bytes: number;
};

export const runTurnItemBodyRecap = (
  options: TurnItemBodyRecapOptions,
): Effect.Effect<TurnItemBodyRecapResult, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const policy = options.policy ?? DEFAULT_TURN_ITEM_BODY_CAP;
    const scanWindow = Math.max(1, options.scanWindow ?? RECAP_SCAN_WINDOW);
    const batchSize = Math.max(1, options.batchSize ?? RECAP_BATCH_SIZE);
    const deadline =
      options.timeBudgetMs === undefined
        ? Number.POSITIVE_INFINITY
        : (yield* Clock.currentTimeMillis) + options.timeBudgetMs;
    // Rows dated before this are old enough; with no horizon nothing qualifies.
    const cutoff =
      options.historyDays === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(options.nowMs - options.historyDays * DAY_MS));
    let interrupted = false;
    let budgetExhausted = false;
    let cappedItemCount = 0;
    let unchangedItemCount = 0;
    let skippedItemCount = 0;
    let savedBytes = 0;
    let cursor = Math.max(0, options.afterRowid ?? 0);

    const lastRowid = yield* Effect.map(
      sql<{ readonly last: number | null }>`
        SELECT MAX(rowid) AS last FROM orchestration_v2_projection_turn_items
      `,
      (rows) => rows[0]?.last ?? 0,
    );

    /** Whether the next statement may run; sets `interrupted` when not. */
    const mayGoOn = Effect.gen(function* () {
      if (interrupted) return false;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        budgetExhausted = true;
        interrupted = true;
        return false;
      }
      if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) {
        interrupted = true;
        return false;
      }
      return true;
    });
    const pause = options.betweenBatches ?? Effect.void;

    /** Caps one row; written only when it is still the row that was read. */
    const recap = (candidate: Candidate) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE rowid = ${candidate.row_id}
        `;
        const payload = rows[0]?.payload_json;
        if (payload === undefined) {
          skippedItemCount += 1;
          return;
        }
        const decoded = yield* Effect.exit(decodeItem(payload));
        if (Exit.isFailure(decoded)) {
          skippedItemCount += 1;
          return;
        }
        const item: OrchestrationV2TurnItem = decoded.value;
        const capped = capTurnItemBody(item, policy);
        if (capped === item) {
          unchangedItemCount += 1;
          return;
        }
        const encoded = yield* Effect.exit(encodeItem(capped));
        if (Exit.isFailure(encoded)) {
          skippedItemCount += 1;
          return;
        }
        const next = (() => {
          try {
            return mergeCapped(payload, item, capped, encoded.value);
          } catch {
            return null;
          }
        })();
        if (next === null) {
          skippedItemCount += 1;
          return;
        }
        if (!(yield* mayGoOn)) return;
        const written = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (options.mayDelete?.() === false) return null;
            // A newer write of the item since the read (status, time or size) wins.
            const changed = yield* sql<{ readonly turn_item_id: string }>`
              UPDATE orchestration_v2_projection_turn_items
              SET payload_json = ${next}
              WHERE rowid = ${candidate.row_id}
                AND turn_item_id = ${candidate.turn_item_id}
                AND updated_at = ${candidate.updated_at}
                AND status IN ${sql.in(FINAL_STATUSES)}
                AND octet_length(payload_json) = ${candidate.bytes}
              RETURNING turn_item_id
            `;
            return changed.length > 0;
          }),
        );
        if (written === null) {
          interrupted = true;
          return;
        }
        if (written) {
          cappedItemCount += 1;
          savedBytes += candidate.bytes - Buffer.byteLength(next, "utf8");
        } else {
          skippedItemCount += 1;
        }
        yield* Effect.yieldNow;
        yield* pause;
      });

    while (cutoff !== null && cursor < lastRowid) {
      if (!(yield* mayGoOn)) break;
      const upper = Math.min(lastRowid, cursor + scanWindow);
      // `octet_length` reads no overflow pages; only rows over it are searched for `bodyCut`.
      const candidates = yield* sql<Candidate>`
        SELECT
          item.rowid AS row_id,
          item.turn_item_id,
          item.updated_at,
          octet_length(item.payload_json) AS bytes
        FROM orchestration_v2_projection_turn_items AS item
        LEFT JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = item.thread_id
        WHERE item.rowid > ${cursor}
          AND item.rowid <= ${upper}
          AND item.type IN ${sql.in(CAPPED_TYPES)}
          AND item.status IN ${sql.in(FINAL_STATUSES)}
          AND octet_length(item.payload_json) > CASE item.type
            WHEN 'command_execution' THEN ${policy.defaultChars}
            ELSE ${Math.min(policy.defaultChars, policy.readChars)}
          END
          AND item.updated_at < ${cutoff}
          AND (
            thread.thread_id IS NULL
            OR CASE
              WHEN json_valid(thread.payload_json) THEN (
                json_type(thread.payload_json, '$.execution') = 'object'
                OR json_extract(thread.payload_json, '$.movedTo.kind') = 'handoff'
                OR json_extract(thread.payload_json, '$.movedFrom.kind') = 'handoff'
              ) IS NOT 1
              ELSE 0
            END
          )
          -- CASE keeps a malformed row from failing the whole window.
          AND CASE
            WHEN json_valid(item.payload_json) THEN json_type(item.payload_json, '$.bodyCut') IS NULL
            ELSE 0
          END
        ORDER BY item.rowid
        LIMIT ${batchSize}
      `;
      for (const candidate of candidates) {
        if (interrupted) break;
        yield* recap(candidate);
        if (!interrupted) cursor = candidate.row_id;
      }
      if (interrupted) break;
      // A full batch may leave matches in the window: go on from its last row.
      cursor = candidates.length === batchSize ? (candidates.at(-1)?.row_id ?? upper) : upper;
      yield* pause;
    }

    return {
      interrupted,
      budgetExhausted,
      reachedEnd: !interrupted && (cutoff === null || cursor >= lastRowid),
      throughRowid: cursor,
      cappedItemCount,
      unchangedItemCount,
      skippedItemCount,
      savedBytes,
    } satisfies TurnItemBodyRecapResult;
  });
