import * as NodeOS from "node:os";

import { ThreadId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ProjectUsageReadError,
  type ProjectUsageReadInput,
  type ProjectUsageSummary,
} from "../../../../packages/contracts/src/projectUsage.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { aggregateFolderUsage } from "./projectFolderSessions.ts";
import { aggregateProjectUsage } from "./projectUsageAggregation.ts";
import * as UsageService from "./UsageService.ts";
import { resolveModelAliases } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

export class ProjectUsageService extends Context.Service<
  ProjectUsageService,
  {
    readonly read: (
      input: ProjectUsageReadInput,
    ) => Effect.Effect<ProjectUsageSummary, ProjectUsageReadError>;
  }
>()("studio/usage/ProjectUsageService") {}

/** Folder sessions older than this are not read: the scan cache keeps 90 days. */
export const FOLDER_SESSION_WINDOW_DAYS = 90;

/** `m4.local` → `m4`: the host as people name it. */
export function shortHostLabel(hostname: string): string {
  const short = hostname.trim().replace(/\.local$/i, "");
  return short.length > 0 ? short : "This host";
}

const decodeRates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ fetchedAtMs: Schema.Number, document: Schema.Unknown })),
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const usage = yield* UsageService.UsageService;

  const read = (
    input: ProjectUsageReadInput,
  ): Effect.Effect<ProjectUsageSummary, ProjectUsageReadError> =>
    Effect.gen(function* () {
      // One database snapshot across project settings, thread membership and
      // turn records prevents mixed totals during dispatch, replay or deletion.
      const snapshot = yield* sql.withTransaction(
        Effect.gen(function* () {
          const project = yield* projects.get(input.projectId);
          if (Option.isNone(project))
            return yield* new ProjectUsageReadError({ ...input, reason: "project_not_found" });
          const rows = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE project_id = ${input.projectId} AND deleted_at IS NULL
            ORDER BY thread_id ASC
          `;
          const records = yield* Effect.forEach(rows, (row) =>
            projections.getThreadRecords(ThreadId.make(row.thread_id), [
              "providerThreads",
              "providerTurns",
              "attempts",
              "runs",
            ]),
          );
          const workspace = (
            project.value as ProjectStore.ProjectRow & {
              readonly workspaceSettings?: { readonly coordinatorThreadId: ThreadId | null } | null;
            }
          ).workspaceSettings;
          // Every native session a Studio thread owns, in any project: those
          // turns are already recorded, so their CLI logs must not count again.
          const owned = yield* sql<{ readonly native_id: string | null }>`
            SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
            FROM orchestration_v2_projection_provider_threads
            UNION
            SELECT json_extract(payload_json, '$.nativeThreadId') AS native_id
            FROM orchestration_v2_projection_run_attempts
          `;
          const otherRoots = yield* sql<{ readonly workspace_root: string }>`
            SELECT workspace_root FROM projection_projects
            WHERE project_id <> ${input.projectId} AND deleted_at IS NULL
          `;
          return {
            records,
            coordinatorThreadId: workspace?.coordinatorThreadId ?? null,
            workspaceRoot: project.value.workspaceRoot,
            studioSessionIds: new Set(
              owned.flatMap((row) => (typeof row.native_id === "string" ? [row.native_id] : [])),
            ),
            otherRoots: otherRoots.map((row) => row.workspace_root),
          };
        }),
      );
      // Reuse the existing cached price catalogue. Project reads never scan
      // unrelated native homes or initiate a network request/provider turn.
      const rates = yield* fs
        .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
        .pipe(
          Effect.flatMap(decodeRates),
          Effect.map((cached) => parseRateTable(cached.document)),
          Effect.catch(() => Effect.succeed(new Map())),
        );
      const currentSettings = yield* settings.getSettings;
      const now = yield* DateTime.now;
      const priceOverrides = createOverrideRateTable(currentSettings.usagePriceOverrides);
      const modelAliases = resolveModelAliases(currentSettings.usageModelAliases);
      const summary = aggregateProjectUsage({
        ...input,
        readAt: DateTime.formatIso(now),
        coordinatorThreadId: snapshot.coordinatorThreadId,
        projections: snapshot.records,
        rates,
        priceOverrides,
        modelAliases,
      });
      // CLI sessions run in the project folder, read from local logs only.
      const roots = [snapshot.workspaceRoot].filter((root) => path.isAbsolute(root));
      // A nested project (a repository inside an umbrella) keeps its own sessions.
      const excludeRoots = snapshot.otherRoots.filter(
        (other) =>
          path.isAbsolute(other) &&
          roots.some((root) => {
            const relative = path.relative(root, other);
            return (
              relative.length > 0 &&
              relative !== ".." &&
              !relative.startsWith(".." + path.sep) &&
              !path.isAbsolute(relative)
            );
          }),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const files = yield* usage.readFolderSessions({
        roots,
        excludeRoots,
        sinceMs: nowMs - FOLDER_SESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      });
      return {
        ...summary,
        folderSessions:
          roots.length === 0
            ? null
            : aggregateFolderUsage({
                hostLabel: shortHostLabel(NodeOS.hostname()),
                windowDays: FOLDER_SESSION_WINDOW_DAYS,
                roots,
                files,
                studioSessionIds: snapshot.studioSessionIds,
                rates,
                priceOverrides,
                modelAliases,
              }),
      };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProjectUsageReadError
          ? cause
          : new ProjectUsageReadError({ ...input, reason: "read_failed", cause }),
      ),
    );
  return ProjectUsageService.of({ read });
});

export const layer = Layer.effect(ProjectUsageService, make);
