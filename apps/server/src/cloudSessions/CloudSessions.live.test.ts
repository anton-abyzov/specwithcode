import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as CloudSessions from "./CloudSessions.ts";

/**
 * Drives the real Claude Code CLI and creates a real cloud session on the
 * signed-in account's plan, so it only runs when asked:
 *
 *   CLOUD_SESSIONS_LIVE=1 CLOUD_SESSIONS_LIVE_REPO=<git checkout> \
 *   CLOUD_SESSIONS_LIVE_REPORT=<json path> vp test run apps/server/src/cloudSessions/CloudSessions.live.test.ts
 */
const repo = process.env.CLOUD_SESSIONS_LIVE_REPO;
const live = process.env.CLOUD_SESSIONS_LIVE === "1" && repo !== undefined;

describe.skipIf(!live)("cloud sessions against the real CLI", () => {
  it("creates a session from an uploaded checkout, sends a follow-up and records both", async () => {
    const projectId = ProjectId.make("project-cloud-live");
    const layer = CloudSessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodePtyAdapter.layer,
          ProcessRunner.layer,
          ServerSettings.layerTest(),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(
                id === projectId
                  ? Option.some({
                      id: projectId,
                      title: "Cloud live check",
                      workspaceRoot: repo!,
                      defaultModelSelection: null,
                      scripts: [],
                      createdAt: "2026-10-16T00:00:00.000Z",
                      updatedAt: "2026-10-16T00:00:00.000Z",
                      deletedAt: null,
                    })
                  : Option.none(),
              ),
          }),
        ),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-cloud-live-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const result = await Effect.gen(function* () {
      const cloud = yield* CloudSessions.CloudSessions;
      const availability = yield* cloud.availability({ refresh: true });
      expect(availability.status).toBe("ready");
      const created = yield* cloud.create({
        task: "Reply with the single word OK, then stop. Do not change any file.",
        projectId,
        upload: true,
        title: "SpecWithCode live check",
      });
      const sent = yield* cloud.send({
        sessionId: created.session.sessionId,
        message: "Reply with the single word DONE, then stop.",
      });
      const listed = yield* cloud.list({ projectId });
      return { availability, created, sent, listed };
    }).pipe(Effect.provide(layer), Effect.runPromise);
    const report = process.env.CLOUD_SESSIONS_LIVE_REPORT;
    if (report !== undefined)
      await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const ranAt = DateTime.formatIso(yield* DateTime.now);
        yield* fs.writeFileString(report, JSON.stringify({ ranAt, ...result }, null, 2));
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
    expect(result.created.session.url).toMatch(/^https:\/\/claude\.ai\/code\//);
    expect(result.sent.ok).toBe(true);
    expect(result.listed.sessions[0]?.sessionId).toBe(result.created.session.sessionId);
    expect(result.listed.sessions[0]?.lastSentAt).not.toBeNull();
  }, 600_000);
});
