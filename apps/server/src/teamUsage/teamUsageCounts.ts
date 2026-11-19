/**
 * Per provider instance counts for one UTC day, read from this machine's
 * projection: runs stopped by a usage limit, `limit-fallback:` moves to
 * another model (provider switches) and machine handoffs that followed a
 * usage-limit stop. Counts only: no thread, run or message id leaves here.
 *
 * @module teamUsage/teamUsageCounts
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export interface TeamUsageInstanceCounts {
  readonly limitHits: number;
  readonly handoffs: number;
  readonly providerSwitches: number;
}

export const emptyCounts: TeamUsageInstanceCounts = {
  limitHits: 0,
  handoffs: 0,
  providerSwitches: 0,
};

/** `[start, end)` of the UTC day holding `nowMs`, as ISO strings. */
export function utcDayBounds(nowMs: number): { readonly start: string; readonly end: string } {
  const dayMs = 24 * 60 * 60_000;
  const startMs = Math.floor(nowMs / dayMs) * dayMs;
  return {
    start: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
    end: DateTime.formatIso(DateTime.makeUnsafe(startMs + dayMs)),
  };
}

interface CountRow {
  readonly instance_id: string | null;
  readonly count: number;
}

export const readTeamUsageCounts = (nowMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { start, end } = utcDayBounds(nowMs);
    // A run stopped by a usage limit: its newest root error says so.
    const limitHits = yield* sql<CountRow>`
      SELECT json_extract(r.payload_json, '$.modelSelection.instanceId') AS instance_id,
        COUNT(DISTINCT r.run_id) AS count
      FROM orchestration_v2_projection_runs r
      WHERE r.status = 'failed'
        AND julianday(r.completed_at) >= julianday(${start})
        AND julianday(r.completed_at) < julianday(${end})
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items item
          WHERE item.run_id = r.run_id AND item.type = 'error'
            AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
        )
      GROUP BY instance_id`;
    // `limit-fallback:<thread>:<run>` or `limit-fallback:<thread>:hop-N:<run>`,
    // counted against the instance of the run it moved off.
    const providerSwitches = yield* sql<CountRow>`
      SELECT json_extract(stopped.payload_json, '$.modelSelection.instanceId') AS instance_id,
        COUNT(DISTINCT m.message_id) AS count
      FROM orchestration_v2_projection_messages m
      JOIN orchestration_v2_projection_runs stopped
        ON stopped.thread_id = m.thread_id
        AND substr(m.message_id, -length(stopped.run_id) - 1) = ':' || stopped.run_id
      WHERE m.message_id LIKE 'limit-fallback:%'
        AND julianday(m.created_at) >= julianday(${start})
        AND julianday(m.created_at) < julianday(${end})
      GROUP BY instance_id`;
    // A thread handed to another machine whose last stop before the move was
    // a usage limit, counted against that stopped run's instance.
    const handoffs = yield* sql<CountRow>`
      SELECT instance_id, COUNT(*) AS count FROM (
        SELECT c.command_id,
          (
            SELECT json_extract(r.payload_json, '$.modelSelection.instanceId')
            FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = c.thread_id
              AND r.status = 'failed'
              AND julianday(r.completed_at) <= julianday(c.accepted_at)
              AND EXISTS (
                SELECT 1 FROM orchestration_v2_projection_turn_items item
                WHERE item.run_id = r.run_id AND item.type = 'error'
                  AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs later
                WHERE later.thread_id = r.thread_id AND later.ordinal > r.ordinal
                  AND julianday(later.requested_at) <= julianday(c.accepted_at)
                  AND later.status IN ('completed', 'running')
              )
            ORDER BY r.ordinal DESC LIMIT 1
          ) AS instance_id
        FROM orchestration_v2_command_receipts c
        WHERE c.command_id LIKE 'handoff-source:%'
          AND julianday(c.accepted_at) >= julianday(${start})
          AND julianday(c.accepted_at) < julianday(${end})
      )
      WHERE instance_id IS NOT NULL
      GROUP BY instance_id`;

    const counts = new Map<string, { limitHits: number; handoffs: number; providerSwitches: number }>();
    const add = (rows: readonly CountRow[], key: keyof TeamUsageInstanceCounts) => {
      for (const row of rows) {
        if (row.instance_id === null) continue;
        const entry = counts.get(row.instance_id) ?? { ...emptyCounts };
        entry[key] += Number(row.count);
        counts.set(row.instance_id, entry);
      }
    };
    add(limitHits, "limitHits");
    add(providerSwitches, "providerSwitches");
    add(handoffs, "handoffs");
    return counts as ReadonlyMap<string, TeamUsageInstanceCounts>;
  });
