import {
  FolderCopyError,
  MachineHandoffError,
  type MachineHandoffBusyReason,
  type FolderCopyDriftInput,
  type FolderCopyDriftResult,
  type FolderCopyReleaseInput,
  type MachineHandoffManifest,
  type MachineHandoffPrepareResult,
  type ProjectCoordinatorBinding,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  copiedProjectFolder,
  resolveCopyScope,
  verifyCopiedProjectFolder,
  validProjectRelativePath,
} from "./folderCopyScope.ts";
import { attempt, folderCopyManifestRepositories } from "./FolderCopyHandoff.ts";
import { busyHandoffError, busyReasonOf, type BusyThreadInput } from "./handoffBusyThreads.ts";
import type { DestinationCopies } from "./folderTransfer/destinationService.ts";
import { driftRowKey, type SourceDrift } from "./folderTransfer/sourceDrift.ts";
import type { SourceOperationRecord, SourceTransfers } from "./folderTransfer/sourceService.ts";

const isHandoffError = Schema.is(MachineHandoffError);

export const ACTIVE_COPY_WARNING =
  "Work is still running here. Files that change during the copy won't be included, and the project moves once that work stops.";

const WAITS_FOR_PERSON: ReadonlySet<MachineHandoffBusyReason> = new Set([
  "waiting_for_answer",
  "waiting_for_sign_in",
  "pending_approval",
]);
const MAX_WARNING_NAMES = 5;
const quoted = (title: string) => `"${title.length > 120 ? `${title.slice(0, 119)}…` : title}"`;

/**
 * What the copy step says about a busy refusal. Running work stops on its own, so the
 * running-work notice fits it; a question, sign-in or approval waiting for the person never
 * does, so those threads are named, and the move waits until they are answered or closed.
 */
export function busyCopyWarnings(cause: MachineHandoffError): ReadonlyArray<string> {
  const threads = cause.busy?.threads ?? [];
  const waiting = threads.filter((thread) => WAITS_FOR_PERSON.has(thread.reason));
  if (waiting.length === 0) return [ACTIVE_COPY_WARNING];
  const unlisted = Math.max(0, (cause.busy?.total ?? threads.length) - threads.length);
  const names = waiting.slice(0, MAX_WARNING_NAMES).map((thread) => quoted(thread.title));
  const more = waiting.length - names.length;
  const one = waiting.length === 1;
  const lead = one
    ? "A thread here is waiting for you"
    : `${waiting.length} threads here are waiting for you`;
  const rest =
    unlisted > 0
      ? ` ${unlisted.toLocaleString("en-US")} more ${unlisted === 1 ? "thread is" : "threads are"} busy too.`
      : "";
  const warning = `${lead}: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. ${one ? "It doesn't" : "They don't"} stop on ${one ? "its" : "their"} own: answer or close what ${one ? "it asks" : "each one asks"} before the coordinator moves.${rest}`;
  return threads.length > waiting.length ? [ACTIVE_COPY_WARNING, warning] : [warning];
}

/**
 * Refuses with every thread that keeps this folder busy: running work, a question, sign-in
 * or approval waiting for the person, a tool call the app is still answering, a provider
 * session still running, or an effect still pending. A waiting question blocks too:
 * moving would drop it.
 */
export const makeProjectIdleCheck =
  (sql: SqlClient.SqlClient, fs: FileSystem.FileSystem, path: Path.Path) =>
  (id: ProjectId, root: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        threadId: string;
        title: string | null;
        projectId: string;
        projectTitle: string | null;
        workspaceRoot: string;
        worktreePath: string | null;
        running: number;
        waitingForAnswer: number;
        waitingForSignIn: number;
        pendingApproval: number;
        toolCall: number;
        pendingEffect: number;
        providerSession: number;
      }>`
      SELECT * FROM (
        SELECT t.thread_id AS "threadId", t.title AS "title", t.project_id AS "projectId",
          p.title AS "projectTitle", p.workspace_root AS "workspaceRoot",
          json_extract(t.payload_json, '$.worktreePath') AS "worktreePath", t.updated_at AS "updatedAt",
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id AND r.status NOT IN ('completed','interrupted','failed','cancelled','rolled_back')) AS "running",
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id=t.thread_id AND r.status='pending' AND r.kind='user_input') AS "waitingForAnswer",
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id=t.thread_id AND r.status='pending' AND r.kind='auth_refresh') AS "waitingForSignIn",
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id=t.thread_id AND r.status='pending' AND r.kind NOT IN ('user_input','auth_refresh','dynamic_tool_call')) AS "pendingApproval",
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id=t.thread_id AND r.status='pending' AND r.kind='dynamic_tool_call') AS "toolCall",
          EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id=t.thread_id AND (e.status IS NULL OR e.status NOT IN ('succeeded','failed','cancelled'))) AS "pendingEffect",
          EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_sessions s WHERE s.thread_id=t.thread_id AND s.status IN ('running','working','connecting','starting')) AS "providerSession"
        FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
      )
      WHERE "running" OR "waitingForAnswer" OR "waitingForSignIn" OR "pendingApproval" OR "toolCall" OR "pendingEffect" OR "providerSession"
      ORDER BY "updatedAt" DESC, "threadId"
    `;
      // Busy threads of one project share its root: resolve each path once.
      const resolved = new Map<string, string>();
      const normalized = (value: string) =>
        resolved.has(value)
          ? Effect.succeed(resolved.get(value)!)
          : fs.realPath(value).pipe(
              Effect.orElseSucceed(() => path.resolve(value)),
              Effect.tap((real) => Effect.sync(() => resolved.set(value, real))),
            );
      const left = yield* normalized(root);
      const overlaps = (right: string) =>
        left === right ||
        left.startsWith(`${right}${path.sep}`) ||
        right.startsWith(`${left}${path.sep}`);
      const blocking: Array<BusyThreadInput> = [];
      for (const row of rows) {
        if (
          row.projectId === id ||
          overlaps(yield* normalized(row.workspaceRoot)) ||
          (row.worktreePath && overlaps(yield* normalized(row.worktreePath)))
        )
          blocking.push({ ...row, reason: busyReasonOf(row) });
      }
      if (blocking.length > 0) return yield* busyHandoffError(blocking);
    }).pipe(
      Effect.mapError((cause) =>
        isHandoffError(cause) ? cause : new MachineHandoffError({ code: "storage_failed" }),
      ),
    );

/** The wire form of a drift: the reviewed rows, and whether moving without them is offered. */
const sourceChanges = (drift: SourceDrift, record: SourceOperationRecord) => ({
  digest: drift.digest,
  total: drift.total,
  truncated: drift.truncated,
  acceptable: Boolean(record.capturedSource),
  rows: drift.rows,
});

/** What a move goes ahead with: the accepted list and what stays here, or null for nothing. */
export type FolderCopyDriftDecision = Parameters<SourceTransfers["recordDriftDecision"]>[1];

/**
 * The refused drift, or the decision a publish may go ahead with: nothing differs, or
 * every differing path is in a list this source produced and the person accepted.
 * Matching is by path (repositories apart), so a file that keeps being written cannot bounce an accepted
 * move; any new path needs review. Nothing is saved here: the caller records the
 * decision only once the coordinator's fence is written.
 */
async function checkDrift(
  sources: SourceTransfers,
  record: SourceOperationRecord,
  options: { readonly acceptedSourceChanges?: string },
): Promise<{ readonly refused: SourceDrift } | { readonly decision: FolderCopyDriftDecision }> {
  const drift = await sources.driftSince(record.operationId);
  if (drift.total === 0) return { decision: null };
  if (!record.capturedSource || !options.acceptedSourceChanges) return { refused: drift };
  const accepted = await sources.driftReport(record.operationId, options.acceptedSourceChanges);
  const current = await sources.driftReport(record.operationId, drift.digest);
  if (!accepted || !current) return { refused: drift };
  // Each row by what it describes: accepting a repository never covers a file at its path.
  const keys = new Set(accepted.rows.map(driftRowKey));
  if (!current.rows.every((row) => keys.has(driftRowKey(row)))) return { refused: drift };
  return {
    decision: {
      accepted: { digest: accepted.digest, total: accepted.total },
      leftOnSource: { digest: drift.digest, total: drift.total },
    },
  };
}

/** The manifest a folder-copy handoff carries: repositories and heads from the offered scan. */
export const makeFolderCopyManifest =
  (
    sources: SourceTransfers,
    idle?: (id: ProjectId, root: string) => Effect.Effect<void, MachineHandoffError>,
  ) =>
  (
    operationId: string,
    projectId: ProjectId,
    destinationEnvironmentId: string,
    workspaceRoot: string,
    options: { readonly publish?: boolean; readonly acceptedSourceChanges?: string } = {},
  ) =>
    Effect.gen(function* () {
      const record = yield* Effect.tryPromise({
        try: () => sources.read(operationId),
        catch: () => new MachineHandoffError({ code: "storage_failed" }),
      });
      if (
        !record ||
        record.projectId !== projectId ||
        record.mode !== "copy-and-move" ||
        record.destinationEnvironmentId !== destinationEnvironmentId ||
        record.summary === null ||
        ["failed", "released", "cancelled"].includes(record.state)
      )
        return yield* new MachineHandoffError({ code: "invalid" });
      if (idle) yield* idle(projectId, record.folder);
      const scope = yield* Effect.tryPromise({
        try: () => resolveCopyScope(workspaceRoot, record.folder),
        catch: () => new MachineHandoffError({ code: "source_changed" }),
      });
      if (scope.projectRelativePath !== (record.projectRelativePath ?? "."))
        return yield* new MachineHandoffError({ code: "source_changed" });
      let decision: FolderCopyDriftDecision | undefined;
      if (record.state === "committed") {
        const checked = yield* Effect.tryPromise({
          try: () => checkDrift(sources, record, options),
          catch: () => new MachineHandoffError({ code: "source_changed" }),
        });
        if ("refused" in checked)
          return yield* new MachineHandoffError({
            code: "source_changed",
            changes: sourceChanges(checked.refused, record),
          });
        if (options.publish) decision = checked.decision;
      }
      return {
        manifest: {
          version: 1 as const,
          operationId,
          ...(record.projectRelativePath !== undefined ? { copyScope: scope } : {}),
          repositories: folderCopyManifestRepositories(operationId, record.summary),
        },
        // Absent unless publishing a committed copy: then the source records it after the fence.
        ...(decision !== undefined ? { decision } : {}),
      };
    });

/** Saves what a published move went ahead with; null clears an earlier attempt's list. */
export const makeFolderCopyDriftDecision =
  (sources: SourceTransfers) => (operationId: string, decision: FolderCopyDriftDecision) =>
    Effect.tryPromise({
      try: () => sources.recordDriftDecision(operationId, decision),
      catch: () => new MachineHandoffError({ code: "storage_failed" }),
    });

/** The destination half proves its copy was applied into this exact project folder. */
export const makeAppliedFolderCopyCheck =
  (
    copies: DestinationCopies,
    fs: FileSystem.FileSystem,
    path: Path.Path,
    idle?: (id: ProjectId, root: string) => Effect.Effect<void, MachineHandoffError>,
  ) =>
  (
    operationId: string,
    projectId: ProjectId,
    sourceEnvironmentId: string,
    workspaceRoot: string,
    manifest: MachineHandoffManifest,
  ) =>
    Effect.gen(function* () {
      const record = yield* Effect.tryPromise({
        try: () => copies.read(operationId),
        catch: () => new MachineHandoffError({ code: "storage_failed" }),
      });
      const real = (value: string) =>
        fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
      if (
        !record ||
        record.mode !== "copy-and-move" ||
        record.state !== "applied" ||
        !record.committed ||
        record.unstable.length > 0 ||
        record.checks.some((check) => !check.ok) ||
        record.projectId !== projectId ||
        record.sourceEnvironmentId !== sourceEnvironmentId ||
        !validProjectRelativePath(record.projectRelativePath ?? ".") ||
        (record.projectRelativePath ?? ".") !== (manifest.copyScope?.projectRelativePath ?? ".") ||
        (manifest.copyScope !== undefined && record.copyRoot !== manifest.copyScope.copyRoot) ||
        (yield* real(copiedProjectFolder(record.targetFolder, record.projectRelativePath))) !==
          (yield* real(workspaceRoot))
      )
        return yield* new MachineHandoffError({ code: "conflict" });
      if (idle) yield* idle(projectId, record.targetFolder);
      yield* Effect.tryPromise({
        try: () => verifyCopiedProjectFolder(record.targetFolder, record.projectRelativePath),
        catch: () => new MachineHandoffError({ code: "conflict" }),
      });
    });

/** Never roll back ownership once publication might have reached the destination. */
export const abandonCopiedContext = (
  sources: SourceTransfers,
  input: FolderCopyReleaseInput,
  prepared: MachineHandoffPrepareResult | null,
  binding: ProjectCoordinatorBinding | undefined,
) => {
  if (
    prepared?.publication === "published" ||
    (binding?.operationId === input.operationId && binding.state !== "active")
  )
    return Effect.fail(
      new FolderCopyError({
        code: "refused",
        detail:
          "Coordinator transfer has already started. Keep this handoff open and check its destination before changing ownership.",
      }),
    );
  return attempt(() => sources.abandonContextTransfer(input.operationId, input.reason)).pipe(
    Effect.as({ projectId: input.projectId, released: false }),
  );
};

export const makeFolderCopyContextCheck = (sources: SourceTransfers) => (operationId: string) =>
  Effect.tryPromise({
    try: () => sources.assertContextAvailable(operationId),
    catch: () => new MachineHandoffError({ code: "conflict" }),
  });

/** Source, read-only: what differs since a committed copy-and-move, and what the move left here. */
export const makeFolderCopyDrift =
  (sources: SourceTransfers) =>
  (input: FolderCopyDriftInput): Effect.Effect<FolderCopyDriftResult, FolderCopyError> =>
    Effect.gen(function* () {
      const record = yield* attempt(() => sources.read(input.operationId));
      if (
        !record ||
        record.projectId !== input.projectId ||
        record.mode !== "copy-and-move" ||
        record.state !== "committed"
      )
        return yield* new FolderCopyError({ code: "invalid" });
      const drift = yield* attempt(() => sources.driftSince(input.operationId));
      return {
        drift: sourceChanges(drift, record),
        ...(record.leftOnSource ? { leftOnSource: record.leftOnSource } : {}),
      };
    });
