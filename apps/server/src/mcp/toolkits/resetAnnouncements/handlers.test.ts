import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ResetAnnouncement,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ResetAnnouncementMonitor from "../../../resetAnnouncements/ResetAnnouncementMonitor.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ResetAnnouncementToolkit } from "./tools.ts";

const caller = liveThreadShell(ThreadId.make("reset-watch"));
const scope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

const layerFor = (enabled: boolean, recorded: ResetAnnouncement[], saves = true) =>
  Access.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ResetAnnouncementMonitor.ResetAnnouncementMonitor)({
          record: (announcement) =>
            Effect.sync(() => {
              const seen = recorded.some((entry) => entry.sourceUrl === announcement.sourceUrl);
              if (seen) return { recorded: false, saved: true };
              if (!saves) return { recorded: false, saved: false };
              recorded.push(announcement);
              return { recorded: true, saved: true };
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({ resetAnnouncementsEnabled: enabled } as never),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
        }),
        Layer.succeed(Context.McpInvocationContext, scope),
      ),
    ),
  );

const record = (input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* ResetAnnouncementToolkit;
    return yield* toolkit.handle("studio_reset_announcement_record", input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result as Record<string, unknown>),
    );
  });

const POST = {
  provider: "codex",
  kind: "full_reset",
  headline: "Codex reset usage limits for all paid plans",
  sourceUrl: "https://x.com/OpenAI/status/1",
  // it.effect runs on a test clock at 0.
  publishedAt: "1970-01-01T00:00:00Z",
};

it.effect("records a post once and reports a repeat", () => {
  const recorded: ResetAnnouncement[] = [];
  return Effect.gen(function* () {
    expect(yield* record(POST)).toEqual({
      recorded: true,
      id: "recorded:https://x.com/openai/status/1",
      sourceUrl: "https://x.com/openai/status/1",
    });
    expect((yield* record(POST)).recorded).toBe(false);
    expect(recorded.map((entry) => [entry.provider, entry.origin])).toEqual([
      ["codex", "recorded"],
    ]);
  }).pipe(Effect.provide(layerFor(true, recorded)));
});

it.effect("refuses a link off the provider's sites and records nothing", () => {
  const recorded: ResetAnnouncement[] = [];
  return Effect.gen(function* () {
    const result = yield* record({ ...POST, sourceUrl: "https://example.com/codex-reset" });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(recorded).toEqual([]);
  }).pipe(Effect.provide(layerFor(true, recorded)));
});

it.effect("records nothing while reset announcements are off", () => {
  const recorded: ResetAnnouncement[] = [];
  return Effect.gen(function* () {
    const result = yield* record(POST);
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(String(result.message)).toContain("Read reset announcements");
    expect(recorded).toEqual([]);
  }).pipe(Effect.provide(layerFor(false, recorded)));
});

it.effect("says nothing was recorded when the post could not be saved", () => {
  const recorded: ResetAnnouncement[] = [];
  return Effect.gen(function* () {
    const result = yield* record(POST);
    expect(result).toMatchObject({ code: "orchestration_error" });
    expect(recorded).toEqual([]);
  }).pipe(Effect.provide(layerFor(true, recorded, false)));
});
