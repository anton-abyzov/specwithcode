import { ProjectWorkspaceError, type ProjectId, type ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  contextDigest,
  projectContextDelta,
  type ProjectContextSnapshot,
} from "./ProjectContextSnapshot.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

export type ProjectContextIdentity = {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly providerThreadId: string;
  readonly nativeThreadId: string | null;
  readonly runId: string;
};
type Prepared = {
  readonly text: string;
  readonly accepted: Effect.Effect<void, ProjectWorkspaceError>;
};
type Row = {
  accepted_json: string | null;
  accepted_epoch: string | null;
  pending_run_id: string | null;
  pending_json: string | null;
  pending_epoch: string | null;
  pending_text: string | null;
};
export class ProjectContextDelivery extends Context.Service<
  ProjectContextDelivery,
  {
    readonly prepare: (
      identity: ProjectContextIdentity,
    ) => Effect.Effect<Prepared, ProjectWorkspaceError>;
    readonly restore: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<string, ProjectWorkspaceError>;
  }
>()("studio/project/ProjectContextDelivery") {}

// A stale/corrupt receipt cannot justify omitting context. Recover conservatively.
function decodeSnapshot(value: string | null): ProjectContextSnapshot | null {
  if (value === null) return null;
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) &&
      decoded.every(
        (section) =>
          section !== null &&
          typeof section === "object" &&
          typeof section.name === "string" &&
          typeof section.value === "string" &&
          typeof section.revision === "string",
      )
      ? decoded
      : null;
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspace = yield* Workspace.ProjectWorkspaceService;
  const failure = (projectId: ProjectId) =>
    Effect.mapError((cause: unknown) =>
      cause instanceof ProjectWorkspaceError
        ? cause
        : new ProjectWorkspaceError({ projectId, code: "operation_failed" }),
    );
  const prepare = (identity: ProjectContextIdentity) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { projectId, threadId, nativeThreadId, providerThreadId, runId } = identity;
          // Runtime process/session IDs and model choice do not identify retained native history.
          // Unknown native identity is conservative: no cross-run receipt reuse.
          const key = contextDigest(
            JSON.stringify([
              projectId,
              threadId,
              identity.driver,
              identity.providerInstanceId,
              nativeThreadId ?? `unknown:${providerThreadId}:${runId}`,
            ]),
          );
          const next = yield* workspace.contextSnapshot(projectId, threadId);
          const compactions =
            nativeThreadId === null
              ? []
              : yield* sql<{ turn_item_id: string }>`
      SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
      JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
      WHERE item.thread_id = ${threadId}
        AND item.type = 'compaction' AND item.status = 'completed'
        AND EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts attempt
          WHERE attempt.run_id = item.run_id AND attempt.provider_thread_id = item.provider_thread_id
            AND attempt.provider = ${identity.driver} AND attempt.provider_instance_id = ${identity.providerInstanceId}
            AND json_extract(attempt.payload_json, '$.nativeThreadId') = ${nativeThreadId})
      ORDER BY run.ordinal DESC, item.ordinal DESC, item.turn_item_id DESC LIMIT 1`;
          const epoch = compactions[0]?.turn_item_id ?? "initial";
          const rows =
            yield* sql<Row>`SELECT * FROM project_context_deliveries WHERE scope_key=${key}`;
          const previous = rows[0];
          // A retry of the same run reuses its immutable snapshot even if memory was edited meanwhile.
          // A different real prompt after ambiguous acceptance restores the current full snapshot.
          const pendingSameRun =
            previous?.pending_run_id === runId &&
            previous.pending_epoch === epoch &&
            previous.pending_text !== null &&
            decodeSnapshot(previous.pending_json) !== null;
          const snapshotJson = pendingSameRun ? previous.pending_json! : JSON.stringify(next);
          const baseline =
            previous?.accepted_json &&
            previous.accepted_epoch === epoch &&
            previous.pending_run_id === null
              ? decodeSnapshot(previous.accepted_json)
              : null;
          const text = pendingSameRun
            ? previous.pending_text!
            : projectContextDelta(projectId, next, baseline);
          yield* sql`INSERT INTO project_context_deliveries (scope_key,project_id,thread_id,accepted_json,accepted_epoch,pending_run_id,pending_json,pending_epoch,pending_text,updated_at)
      VALUES (${key},${projectId},${threadId},${previous?.accepted_json ?? null},${previous?.accepted_epoch ?? null},${runId},${snapshotJson},${epoch},${text},${new Date().toISOString()})
      ON CONFLICT(scope_key) DO UPDATE SET pending_run_id=excluded.pending_run_id,pending_json=excluded.pending_json,pending_epoch=excluded.pending_epoch,pending_text=excluded.pending_text,updated_at=excluded.updated_at`;
          const accepted =
            sql`UPDATE project_context_deliveries SET accepted_json=pending_json,accepted_epoch=pending_epoch,pending_run_id=NULL,pending_json=NULL,pending_epoch=NULL,pending_text=NULL,updated_at=${new Date().toISOString()}
      WHERE scope_key=${key} AND pending_run_id=${runId} AND pending_json=${snapshotJson} AND pending_epoch=${epoch}`.pipe(
              Effect.asVoid,
              failure(projectId),
            );
          return { text, accepted };
        }),
      )
      .pipe(failure(identity.projectId));
  return ProjectContextDelivery.of({
    prepare,
    // Hook delivery is deliberately not an acceptance receipt. A crash/compaction race may
    // restore context once more on the next real prompt, but never replays user work.
    restore: (projectId, threadId) =>
      workspace
        .contextSnapshot(projectId, threadId, true)
        .pipe(Effect.map((snapshot) => projectContextDelta(projectId, snapshot, null))),
  });
});
export const layer = Layer.effect(ProjectContextDelivery, make);
