import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderSessionId,
  ThreadId,
  type ServerProviderUsageLimits,
} from "@specweave-studio/contracts";
import type * as CodexClient from "@specweave-studio/effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { codexRateLimitsToLimits } from "../../provider/codexUsageLimits.ts";
import { applyUsageLimitsUpdate } from "../../provider/providerUsageLimits.ts";
import { capacitySnapshot, nativeQuotaDenied } from "../../studio/capacitySnapshot.ts";
import { provider, rawSnapshot, settings } from "../../studio/fixtures.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

// Register the actual adapter callbacks against a transport double. Opening
// this scope cannot initialize a model, start a turn or touch a native account.
const observeNotification = (rateLimits: unknown, followups: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      originalAt = DateTime.formatIso(DateTime.makeUnsafe(now - 1000));
    let limits: ServerProviderUsageLimits = codexRateLimitsToLimits({
      checkedAt: originalAt,
      ordinaryUsageAllowed: true,
      snapshot: {
        spendControlReached: false,
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: Math.floor(now / 1000) + 3600,
        },
      },
    });
    const updates: Array<unknown> = [];
    const callbacks = new Map<string, (payload: unknown) => Effect.Effect<void>>();
    const requests: string[] = [];
    const unexpectedRequest = (method: string) =>
      Effect.sync(() => {
        requests.push(method);
      }).pipe(
        Effect.andThen(
          Effect.die("No native requests are permitted in this notification regression."),
        ),
      );
    const client = {
      awaitTermination: Effect.never,
      raw: {
        notifications: Stream.never,
        requests: Stream.never,
        request: unexpectedRequest,
        notify: () => Effect.void,
        respond: () => Effect.void,
        respondError: () => Effect.void,
      },
      request: unexpectedRequest,
      notify: () => Effect.void,
      handleServerRequest: () => Effect.void,
      handleServerNotification: (
        method: string,
        callback: (payload: unknown) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          callbacks.set(method, callback);
        }),
      handleUnknownServerRequest: () => Effect.void,
      handleUnknownServerNotification: () => Effect.void,
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* makeReplayServerConfig("quota-denial-notification").pipe(
      Effect.orDie,
    );
    yield* Effect.addFinalizer(() =>
      fileSystem.remove(serverConfig.baseDir, { recursive: true }).pipe(Effect.orDie),
    );
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: yield* Schema.decodeEffect(CodexSettings)({}),
      environment: {},
      clientFactory: { open: () => Effect.succeed(client) },
      crypto: yield* Crypto.Crypto,
      fileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
      onUsageLimits: (update) =>
        Effect.sync(() => {
          updates.push(update);
          limits =
            applyUsageLimitsUpdate({ previous: limits, update, checkedAt: update.checkedAt }) ??
            limits;
        }),
    });
    yield* adapter.openSession({
      threadId: ThreadId.make("thread-quota-denial-notification"),
      providerSessionId: ProviderSessionId.make("provider-session-quota-denial-notification"),
      modelSelection: { instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" },
      runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    });
    const callback = callbacks.get("account/rateLimits/updated");
    if (!callback)
      return yield* Effect.die(
        "The actual adapter did not register its quota notification callback.",
      );
    yield* callback({ rateLimits });
    const firstDenialObservedAt = limits.nativeDenialObservedAt;
    for (const update of followups) yield* callback({ rateLimits: update });
    const base = provider("codex", "codex", now);
    const snapshot = capacitySnapshot({
      raw: rawSnapshot(now - 2000),
      settings,
      providers: [{ ...base, usageLimits: { ...base.usageLimits!, ...limits } }],
      baseEnv: {},
      now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
    return {
      limits,
      updates,
      originalAt,
      firstDenialObservedAt,
      requests,
      snapshot,
      denied: nativeQuotaDenied(limits, DateTime.toEpochMillis(DateTime.nowUnsafe())),
    };
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)));

describe("Codex adapter native quota denial notification", () => {
  it.each(["codex", "spark"])(
    "publishes cached windows once per bucket through the actual callback: %s",
    async (limitId) => {
      const cached = {
        limitId,
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 25, windowDurationMins: 300 },
      };
      const other = { limitId: limitId === "codex" ? "spark" : "codex", primary: cached.primary };
      const result = await Effect.runPromise(
        observeNotification(cached, [
          other,
          { limitId },
          { limitId, primary: cached.primary },
          structuredClone(cached),
        ]),
      );
      expect(result.requests).toEqual([]);
      expect(result.updates).toHaveLength(2);
      expect(result.updates).toEqual([
        expect.objectContaining({
          windows: [
            expect.objectContaining({ id: limitId === "codex" ? "primary" : "spark:primary" }),
          ],
        }),
        expect.objectContaining({
          windows: [
            expect.objectContaining({ id: limitId === "codex" ? "spark:primary" : "primary" }),
          ],
        }),
      ]);
    },
  );
  it.each([true, false])(
    "withdraws earlier permission through the real callback, windows present: %s",
    async (hasWindow) => {
      const result = await Effect.runPromise(
        observeNotification(
          {
            limitId: "codex",
            spendControlReached: true,
            rateLimitReachedType: "workspace_member_usage_limit_reached",
            ...(hasWindow ? { primary: { usedPercent: 20, windowDurationMins: 300 } } : {}),
          },
          [
            {
              limitId: "codex",
              spendControlReached: false,
              primary: { usedPercent: 10, windowDurationMins: 300 },
            },
            { limitId: "codex", primary: { usedPercent: 15, windowDurationMins: 300 } },
          ],
        ),
      );
      expect(result.requests).toEqual([]);
      expect(result.limits.spendControlReached).toBe(true);
      expect(result.limits.ordinaryUsageAllowed).toBe(true);
      expect(result.limits.nativeAllowanceObservedAt).toBe(result.originalAt);
      expect(result.limits.nativeDenialObservedAt).toBeDefined();
      expect(result.limits.nativeDenialObservedAt).toBe(result.firstDenialObservedAt);
      expect(result.denied).toBe(true);
      expect(result.snapshot.accounts[0]?.status).toBe("exhausted");
    },
  );

  it("keeps model-specific spend denial scoped to its own usage rows", async () => {
    const result = await Effect.runPromise(
      observeNotification({
        limitId: "codex_bengalfox",
        spendControlReached: true,
        primary: { usedPercent: 20, windowDurationMins: 300 },
      }),
    );
    expect(result.requests).toEqual([]);
    expect(result.limits.spendControlReached).toBe(false);
    expect(result.limits.nativeAllowanceObservedAt).toBe(result.originalAt);
    expect(result.limits.nativeDenialObservedAt).toBeUndefined();
    expect(result.limits.windows.some((window) => window.id === "codex_bengalfox:primary")).toBe(
      true,
    );
    expect(result.denied).toBe(false);
    expect(result.snapshot.accounts[0]?.status).toBe("ready");
  });
});
