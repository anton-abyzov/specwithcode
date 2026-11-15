import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Ledger from "./UsageResetLedger.ts";
import * as Sources from "./UsageLimitSources.ts";

const codex = ProviderDriverKind.make("codex");
const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;
// The ledger keeps a year by the real clock, so the resets sit in the last two weeks.
const now = Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 60_000) * 60_000;
const reset1 = now - WEEK - 2 * HOUR;
const reset2 = reset1 + WEEK;
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

function provider(usedPercent: number, checkedAt: number, resetsAt: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: codex,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "pro@example.com" },
    checkedAt: iso(checkedAt),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(checkedAt),
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          windowDurationMins: 10_080,
          resetsAt: iso(resetsAt),
        },
      ],
    },
  };
}

/** One server lifetime: a fake provider feed over a real state directory. */
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
    const service = yield* Ledger.make.pipe(
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
    return { service, scope, providerChanges };
  });

describe("UsageResetLedger", () => {
  it.live("closes a period at a reset, serves it, and continues the next across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "usage-reset-ledger-" });

      const first = yield* lifetime(stateDir);
      yield* PubSub.publish(first.providerChanges, [provider(59, reset1 - HOUR, reset1)]);
      yield* PubSub.publish(first.providerChanges, [provider(2, reset1 + HOUR, reset2)]);
      yield* Effect.sleep("20 millis");

      const read = yield* first.service.read({});
      expect(read.periods).toEqual([
        {
          accountKey: "codex:pro@example.com",
          driver: codex,
          windowId: "secondary",
          windowKind: "weekly",
          windowDurationMins: 10_080,
          endedAt: iso(reset1),
          lastReadAt: iso(reset1 - HOUR),
          usedPercentAtReset: 59,
          lostPercent: 41,
          cause: "scheduled",
        },
      ]);

      yield* Scope.close(first.scope, Exit.void);
      expect(yield* fs.exists(path.join(stateDir, Ledger.USAGE_RESET_LEDGER_FILE))).toBe(true);

      const second = yield* lifetime(stateDir);
      yield* PubSub.publish(second.providerChanges, [provider(90, reset2 - HOUR, reset2)]);
      yield* PubSub.publish(second.providerChanges, [provider(1, reset2 + HOUR, reset2 + WEEK)]);
      yield* Effect.sleep("20 millis");
      const reread = yield* second.service.read({ sinceDays: 30 });
      expect(reread.periods).toHaveLength(2);
      expect(reread.periods[1]).toMatchObject({
        startedAt: iso(reset1),
        endedAt: iso(reset2),
        lostPercent: 10,
      });
      yield* Scope.close(second.scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
  );
});
