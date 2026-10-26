import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as History from "./UsageLimitHistory.ts";
import * as Sources from "./UsageLimitSources.ts";

const claude = ProviderDriverKind.make("claudeAgent");

function provider(usedPercent: number, checkedAt: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "main@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          windowDurationMins: 300,
          resetsAt: "2026-10-26T14:00:00.000Z",
        },
      ],
    },
  };
}

const hub = (usedPercent: number, checkedAt: string): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "Hub",
  checkedAt,
  accounts: [
    {
      id: "codex.json",
      driver: ProviderDriverKind.make("codex"),
      email: "pro@example.com",
      usageLimits: {
        checkedAt,
        windows: [{ id: "secondary", kind: "weekly", label: "Weekly", usedPercent }],
      },
    },
  ],
});

/** One server lifetime: fake provider and hub feeds over a real state directory. */
const lifetime = (stateDir: string) =>
  Effect.gen(function* () {
    const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
    const sourceChanges = yield* PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>();
    const registry = {
      getProviders: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(providerChanges),
    } as unknown as ProviderRegistry.ProviderRegistry["Service"];
    const sources = {
      streamChanges: Stream.fromPubSub(sourceChanges),
    } as unknown as Sources.UsageLimitSources["Service"];
    const scope = yield* Scope.make();
    const service = yield* History.make.pipe(
      Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
      Effect.provideService(Sources.UsageLimitSources, sources),
      Effect.provideService(ServerConfig.ServerConfig, {
        stateDir,
      } as ServerConfig.ServerConfig["Service"]),
      Scope.provide(scope),
    );
    // The feeds subscribe on forked fibers; let them attach before publishing.
    yield* Effect.yieldNow;
    yield* Effect.sleep("10 millis");
    return { service, scope, providerChanges, sourceChanges };
  });

describe("UsageLimitHistory", () => {
  it.live("records native and hub reads, serves them, and keeps them across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "usage-limit-history-" });

      const first = yield* lifetime(stateDir);
      yield* PubSub.publish(first.providerChanges, [provider(10, "2026-10-26T10:00:00.000Z")]);
      yield* PubSub.publish(first.providerChanges, [provider(25, "2026-10-26T10:20:00.000Z")]);
      yield* PubSub.publish(first.sourceChanges, [hub(40, "2026-10-26T10:05:00.000Z")]);
      yield* Effect.sleep("20 millis");

      const read = yield* first.service.read({ sinceHours: 336 });
      const byAccount = Object.fromEntries(
        read.series.map((series) => [series.accountKey, series]),
      );
      expect(byAccount["claudeAgent:main@example.com"]).toMatchObject({
        windowId: "five_hour",
        windowKind: "session",
        windowDurationMins: 300,
        samples: [
          { at: "2026-10-26T10:00:00.000Z", usedPercent: 10 },
          { at: "2026-10-26T10:20:00.000Z", usedPercent: 25 },
        ],
      });
      expect(byAccount["codex:pro@example.com"]?.samples).toEqual([
        { at: "2026-10-26T10:05:00.000Z", usedPercent: 40 },
      ]);

      // Shutdown writes what was recorded since the last periodic save.
      yield* Scope.close(first.scope, Exit.void);
      expect(yield* fs.exists(path.join(stateDir, History.USAGE_LIMIT_HISTORY_FILE))).toBe(true);

      const second = yield* lifetime(stateDir);
      const reread = yield* second.service.read({ sinceHours: 336 });
      expect(reread.series).toEqual(read.series);
      yield* Scope.close(second.scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
  );
});
