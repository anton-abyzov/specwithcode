/**
 * The two statements as they were before migration 074, kept word for word so
 * ProjectionStore.slowQueries.test.ts can check that the current reads return
 * the same rows. Not used by the server.
 */

/** `selectShellThreadRows` before paging and index pinning. `filter` is appended to its WHERE. */
export const previousShellThreadRowsSql = (filter: string) => `
SELECT
  t.thread_id,
  t.payload_json,
  (
    SELECT json_set(json_extract(r.payload_json, '$.modelSelection'), '$.instanceId', r.provider_instance_id)
    FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = t.thread_id AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      AND COALESCE(json_extract(r.payload_json, '$.queueHeld'), 0) = 0
    ORDER BY CASE WHEN r.status = 'queued' THEN 1 ELSE 0 END, r.ordinal DESC LIMIT 1
  ) AS running_model_json,
  COALESCE(
    -- Mirrors limitFallbackPairing's pre-switch origin, which comes first: the model
    -- the usage pre-switch moved the idle thread off, until it goes back or a pick
    -- clears it. A pick clears it at write time, so it is newer than any continuation.
    (
      SELECT json_object('original', json_extract(t.payload_json, '$.limitPreswitchFrom.modelSelection'), 'source', 'preswitch')
      WHERE json_type(t.payload_json, '$.limitPreswitchFrom.modelSelection') = 'object'
        AND NOT (
          json_extract(t.payload_json, '$.limitPreswitchFrom.modelSelection.instanceId') = json_extract(t.payload_json, '$.modelSelection.instanceId')
          AND (CASE WHEN instr(json_extract(t.payload_json, '$.limitPreswitchFrom.modelSelection.model'), '[') > 1 THEN substr(json_extract(t.payload_json, '$.limitPreswitchFrom.modelSelection.model'), 1, instr(json_extract(t.payload_json, '$.limitPreswitchFrom.modelSelection.model'), '[') - 1) ELSE json_extract(t.payload_json, '$.limitPreswitchFrom.modelSelection.model') END) = (CASE WHEN instr(json_extract(t.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(t.payload_json, '$.modelSelection.model'), 1, instr(json_extract(t.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(t.payload_json, '$.modelSelection.model') END)
        )
    ),
    (
      SELECT json_object('original', json_extract(stopped.payload_json, '$.modelSelection'))
      FROM orchestration_v2_projection_messages continuation
      JOIN orchestration_v2_projection_runs stopped
        ON stopped.thread_id = t.thread_id
        AND substr(continuation.message_id, -length(stopped.run_id) - 1) = ':' || stopped.run_id
      LEFT JOIN orchestration_v2_projection_runs resumed
        ON resumed.run_id = continuation.run_id
      WHERE continuation.thread_id = t.thread_id
        AND continuation.message_id = (
          SELECT m.message_id FROM orchestration_v2_projection_messages m
          WHERE m.thread_id = t.thread_id
            AND (m.message_id LIKE 'limit-fallback:%' OR m.message_id LIKE 'provider-fallback:%')
          ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1
        )
        AND continuation.message_id LIKE 'limit-fallback:%'
        -- Mirrors limitFallbackPairing: another provider, or another model on the
        -- same one; a bracketed variant ([1m]) is the same model.
        AND NOT (
          json_extract(stopped.payload_json, '$.modelSelection.instanceId') = json_extract(t.payload_json, '$.modelSelection.instanceId')
          AND (CASE WHEN instr(json_extract(stopped.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(stopped.payload_json, '$.modelSelection.model'), 1, instr(json_extract(stopped.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(stopped.payload_json, '$.modelSelection.model') END) = (CASE WHEN instr(json_extract(t.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(t.payload_json, '$.modelSelection.model'), 1, instr(json_extract(t.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(t.payload_json, '$.modelSelection.model') END)
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs returned
          WHERE returned.thread_id = t.thread_id AND returned.ordinal > resumed.ordinal
            AND json_extract(returned.payload_json, '$.modelSelection.instanceId') = json_extract(stopped.payload_json, '$.modelSelection.instanceId')
            AND (CASE WHEN instr(json_extract(returned.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(returned.payload_json, '$.modelSelection.model'), 1, instr(json_extract(returned.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(returned.payload_json, '$.modelSelection.model') END) = (CASE WHEN instr(json_extract(stopped.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(stopped.payload_json, '$.modelSelection.model'), 1, instr(json_extract(stopped.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(stopped.payload_json, '$.modelSelection.model') END)
        )
      ORDER BY length(stopped.run_id) DESC LIMIT 1
    ),
    -- Mirrors launchFallbackPairing: a thread whose launch moved off a model with
    -- no room stands in for it while it is not set on the original and no run has
    -- gone there. A pick by hand clears launchFallbackFrom at write time.
    (
      SELECT json_object('original', json_extract(t.payload_json, '$.launchFallbackFrom'), 'source', 'launch')
      WHERE json_type(t.payload_json, '$.launchFallbackFrom') = 'object'
        AND NOT (
          json_extract(t.payload_json, '$.launchFallbackFrom.instanceId') = json_extract(t.payload_json, '$.modelSelection.instanceId')
          AND (CASE WHEN instr(json_extract(t.payload_json, '$.launchFallbackFrom.model'), '[') > 1 THEN substr(json_extract(t.payload_json, '$.launchFallbackFrom.model'), 1, instr(json_extract(t.payload_json, '$.launchFallbackFrom.model'), '[') - 1) ELSE json_extract(t.payload_json, '$.launchFallbackFrom.model') END) = (CASE WHEN instr(json_extract(t.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(t.payload_json, '$.modelSelection.model'), 1, instr(json_extract(t.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(t.payload_json, '$.modelSelection.model') END)
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs launched
          WHERE launched.thread_id = t.thread_id
            AND json_extract(launched.payload_json, '$.modelSelection.instanceId') = json_extract(t.payload_json, '$.launchFallbackFrom.instanceId')
            AND (CASE WHEN instr(json_extract(launched.payload_json, '$.modelSelection.model'), '[') > 1 THEN substr(json_extract(launched.payload_json, '$.modelSelection.model'), 1, instr(json_extract(launched.payload_json, '$.modelSelection.model'), '[') - 1) ELSE json_extract(launched.payload_json, '$.modelSelection.model') END) = (CASE WHEN instr(json_extract(t.payload_json, '$.launchFallbackFrom.model'), '[') > 1 THEN substr(json_extract(t.payload_json, '$.launchFallbackFrom.model'), 1, instr(json_extract(t.payload_json, '$.launchFallbackFrom.model'), '[') - 1) ELSE json_extract(t.payload_json, '$.launchFallbackFrom.model') END)
        )
    )
  ) AS fallback_pairing_json,
  CASE
    WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
      THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
    ELSE NULL
  END AS forked_from_run_source_thread_id,
  presented.run_id AS latest_run_id,
  presented.status AS latest_run_status,
  presented.requested_at AS latest_run_requested_at,
  json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
  presented.completed_at AS latest_run_completed_at,
  (
    SELECT r.run_id
    FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = t.thread_id
      AND r.status IN ('preparing', 'starting', 'running')
    ORDER BY r.ordinal DESC, r.run_id DESC
    LIMIT 1
  ) AS active_run_id,
  (
    -- Mirrors activeRunActivityAt: the newer of the run's start and its newest item.
    SELECT max(
      COALESCE(json_extract(r.payload_json, '$.startedAt'), r.requested_at),
      COALESCE(
        (
          SELECT MAX(item.updated_at)
          FROM orchestration_v2_projection_turn_items item
            INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
          WHERE item.thread_id = t.thread_id AND item.run_id = r.run_id
        ),
        ''
      )
    )
    FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = t.thread_id
      AND r.status IN ('preparing', 'starting', 'running')
    ORDER BY r.ordinal DESC, r.run_id DESC
    LIMIT 1
  ) AS active_run_activity_at,
  COALESCE(
    (
      SELECT r.status
      FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = t.thread_id
        AND r.status IN ('preparing', 'starting', 'running', 'waiting')
      ORDER BY r.ordinal DESC, r.run_id DESC
      LIMIT 1
    ),
    -- Mirrors runlessSubagentActivity: a provider-native subagent's live runless root turn.
    CASE
      WHEN json_extract(t.payload_json, '$.creationSource') = 'provider'
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      THEN (
        SELECT CASE
          WHEN n.status = 'pending' THEN 'starting'
          WHEN n.status IN ('running', 'waiting') THEN n.status
        END
        FROM orchestration_v2_projection_nodes n
        WHERE n.thread_id = t.thread_id
          AND n.kind = 'root_turn'
          AND n.run_id IS NULL
        ORDER BY n.started_at DESC, n.node_id DESC
        LIMIT 1
      )
    END
  ) AS activity_run_status,
  COALESCE(
    (
      -- Mirrors orchestrationV2RunWorkStartedAt.
      SELECT COALESCE(
        json_extract(r.payload_json, '$.workStartedAt'),
        json_extract(r.payload_json, '$.startedAt'),
        r.requested_at
      )
      FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = t.thread_id
        AND r.status IN ('preparing', 'starting', 'running', 'waiting')
      ORDER BY r.ordinal DESC, r.run_id DESC
      LIMIT 1
    ),
    -- The same root turn as activity_run_status, so status and start agree.
    CASE
      WHEN json_extract(t.payload_json, '$.creationSource') = 'provider'
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      THEN (
        SELECT CASE
          WHEN n.status IN ('pending', 'running', 'waiting') THEN n.started_at
        END
        FROM orchestration_v2_projection_nodes n
        WHERE n.thread_id = t.thread_id
          AND n.kind = 'root_turn'
          AND n.run_id IS NULL
        ORDER BY n.started_at DESC, n.node_id DESC
        LIMIT 1
      )
    END
  ) AS activity_run_started_at,
  (
    SELECT json_extract(session.payload_json, '$.lastError')
    -- Bindings first (CROSS JOIN pins the order): about one binding per thread.
    -- Sessions first walked every session of the provider instance per thread.
    FROM orchestration_v2_projection_provider_session_bindings binding
    CROSS JOIN orchestration_v2_projection_provider_sessions session
      ON session.provider_session_id = binding.provider_session_id
    WHERE binding.thread_id = t.thread_id
      AND session.provider_instance_id = t.provider_instance_id
    ORDER BY session.updated_at DESC, session.provider_session_id DESC
    LIMIT 1
  ) AS last_error,
  (
    SELECT item.payload_json
    FROM orchestration_v2_projection_turn_items item
      INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
    INNER JOIN orchestration_v2_projection_runs r ON r.run_id = item.run_id
    WHERE r.run_id = presented.run_id
      AND r.status = 'failed'
      AND item.thread_id = t.thread_id
      AND item.type = 'error' AND item.status = 'failed'
      AND item.node_id IS json_extract(r.payload_json, '$.rootNodeId')
    ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
    LIMIT 1
  ) AS terminal_failure_payload_json,
  blocked.run_id AS blocking_run_id,
  blocked.requested_at AS blocking_run_requested_at,
  json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
  blocked.completed_at AS blocking_run_completed_at,
  (
    SELECT item.payload_json
    FROM orchestration_v2_projection_turn_items item
      INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
    WHERE item.thread_id = t.thread_id
      AND item.run_id = blocked.run_id
      AND item.type = 'error' AND item.status = 'failed'
      AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
    ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
    LIMIT 1
  ) AS blocking_failure_payload_json,
  (
    SELECT child.status FROM orchestration_v2_projection_subagents child
    WHERE child.child_thread_id = t.thread_id AND child.origin = 'provider_native'
    ORDER BY child.updated_at DESC, child.subagent_id DESC LIMIT 1
  ) AS native_subagent_status,
  (
    SELECT child.completed_at FROM orchestration_v2_projection_subagents child
    WHERE child.child_thread_id = t.thread_id AND child.origin = 'provider_native'
    ORDER BY child.updated_at DESC, child.subagent_id DESC LIMIT 1
  ) AS native_subagent_completed_at,
  (
    SELECT request.payload_json
    FROM orchestration_v2_projection_runtime_requests request
    WHERE request.thread_id = t.thread_id
      AND request.status = 'pending'
      AND (request.runtime_request_id NOT LIKE 'update-reopen%' OR NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runtime_requests answered
        WHERE answered.thread_id = request.thread_id AND answered.status = 'resolved'
          AND REPLACE(REPLACE(answered.runtime_request_id, 'update-reopen:', ''), 'update-reopen-approval:', '') = REPLACE(REPLACE(request.runtime_request_id, 'update-reopen:', ''), 'update-reopen-approval:', '')
          AND (json_extract(answered.payload_json, '$.decision') IS NOT NULL AND json_extract(answered.payload_json, '$.decision') <> 'cancel'
            OR json_extract(answered.payload_json, '$.answers') NOT IN ('{}', 'null') AND json_extract(answered.payload_json, '$.answers') IS NOT NULL)
      ))
    ORDER BY request.created_at DESC, request.runtime_request_id DESC
    LIMIT 1
  ) AS pending_request_payload_json,
  (
    SELECT secret.payload_json
    -- Keep runs outermost so completed history is never scanned for a pending secret.
    FROM orchestration_v2_projection_runs r
    CROSS JOIN orchestration_v2_projection_turn_items secret
      INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
    WHERE r.thread_id = t.thread_id
      AND r.status IN ('preparing', 'starting', 'running', 'waiting')
      AND secret.thread_id = t.thread_id AND secret.run_id = r.run_id
      AND secret.type IN ('secret_request', 'access_request')
      AND secret.status = 'waiting'
    ORDER BY secret.updated_at DESC, secret.turn_item_id DESC
    LIMIT 1
  ) AS pending_secret_request_payload_json,
  (
    SELECT message.updated_at
    FROM orchestration_v2_projection_messages message
    WHERE message.thread_id = t.thread_id
      AND message.role = 'user'
    ORDER BY message.updated_at DESC, message.message_id DESC
    LIMIT 1
  ) AS latest_user_message_at,
  (
    SELECT message.updated_at
    FROM orchestration_v2_projection_messages message
    WHERE message.thread_id = t.thread_id
      AND message.role = 'user'
      AND json_extract(message.payload_json, '$.createdBy') = 'user'
    ORDER BY message.updated_at DESC, message.message_id DESC
    LIMIT 1
  ) AS latest_user_authored_message_at,
  (
    SELECT message.updated_at
    FROM orchestration_v2_projection_messages message
    WHERE message.thread_id = t.thread_id
      AND message.role = 'assistant' AND message.streaming = 0
    ORDER BY message.created_at DESC, message.message_id DESC
    LIMIT 1
  ) AS latest_assistant_message_at,
  (
    SELECT json_extract(message.payload_json, '$.text')
    FROM orchestration_v2_projection_messages message
    WHERE message.thread_id = t.thread_id
      AND message.role = 'assistant' AND message.streaming = 0
    ORDER BY message.created_at DESC, message.message_id DESC
    LIMIT 1
  ) AS latest_assistant_text,
  EXISTS (
    SELECT 1
    FROM orchestration_v2_projection_plans plan
    WHERE plan.thread_id = t.thread_id
      AND plan.kind = 'proposed_plan'
      AND plan.status = 'active'
  ) AS has_actionable_proposed_plan,
  -- The newest run's todo list, matching latestTodoPlan; within a run the
  -- first-inserted row order (kept across updates) breaks the tie.
  (
    SELECT plan.payload_json
    FROM orchestration_v2_projection_plans plan
    LEFT JOIN orchestration_v2_projection_runs plan_run
      ON plan_run.run_id = plan.run_id
    WHERE plan.thread_id = t.thread_id
      AND plan.kind = 'todo_list'
    ORDER BY COALESCE(plan_run.ordinal, -1) DESC, plan.rowid DESC
    LIMIT 1
  ) AS latest_todo_plan_json,
  -- Count per run on the covering (thread_id, run_id) index, then
  -- look up each run once, instead of one run lookup per item.
  (
    SELECT COALESCE(SUM(per_run.item_count), 0)
    FROM (
      SELECT i.run_id, COUNT(*) AS item_count
      FROM orchestration_v2_projection_turn_items i
      WHERE i.thread_id = t.thread_id
      GROUP BY i.run_id
    ) per_run
    LEFT JOIN orchestration_v2_projection_runs r
      ON r.run_id = per_run.run_id
    WHERE per_run.run_id IS NULL OR r.status <> 'rolled_back'
  ) AS item_count,
  (
    SELECT COUNT(*)
    FROM orchestration_v2_projection_turn_items i
    WHERE i.thread_id = t.thread_id
      AND i.run_id IS NULL
  ) AS runless_item_count,
  -- Queued messages in a held queue, matching heldQueuedRunCount.
  (
    SELECT COUNT(*)
    FROM orchestration_v2_projection_runs held
    WHERE held.thread_id = t.thread_id
      AND held.status = 'queued'
      AND json_extract(held.payload_json, '$.queueHeld') IS 1
  ) AS held_queued_count
FROM orchestration_v2_projection_threads t
-- The newest run not waiting in a held queue, matching latestUnheldRun.
LEFT JOIN orchestration_v2_projection_runs presented ON presented.run_id = (
  SELECT candidate.run_id
  FROM orchestration_v2_projection_runs candidate
  WHERE candidate.thread_id = t.thread_id
    AND NOT (
      candidate.status = 'queued'
      AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
    )
  ORDER BY candidate.ordinal DESC, candidate.run_id DESC
  LIMIT 1
)
LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
  SELECT candidate.run_id
  FROM orchestration_v2_projection_runs candidate
  WHERE candidate.thread_id = t.thread_id
    AND candidate.status <> 'queued'
    AND NOT (
      candidate.status = 'cancelled'
      AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
    )
  -- latestExecutedRun: the run that ended last (runRanAfter).
  ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
    candidate.ordinal DESC, candidate.run_id DESC
  LIMIT 1
) AND blocked.status = 'failed'

WHERE t.deleted_at IS NULL${filter}
ORDER BY t.updated_at ASC, t.thread_id ASC
`;

export const PREVIOUS_ACTIVE_LOCATION_FILTER =
  " AND json_extract(t.payload_json, '$.archivedAt') IS NULL";
export const PREVIOUS_ARCHIVE_LOCATION_FILTER =
  " AND json_extract(t.payload_json, '$.archivedAt') IS NOT NULL";
export const PREVIOUS_UNSETTLED_FILTER =
  " AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'";

/** `readBackgroundBusy` in ServiceUpdatePreparation.ts; its text did not change, only its plan. */
export const PREVIOUS_BACKGROUND_BUSY_SQL = `
SELECT n.thread_id AS thread_id FROM orchestration_v2_projection_nodes n
  JOIN orchestration_v2_projection_runs r ON r.run_id = n.run_id
 WHERE n.kind = 'subagent' AND n.status IN ('pending', 'running', 'waiting')
   AND r.status IN ('preparing', 'starting', 'running', 'waiting')
UNION
SELECT thread_id FROM orchestration_v2_projection_provider_threads
 WHERE thread_id IS NOT NULL
   AND json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
`;
