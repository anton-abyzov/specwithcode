import { assert, it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { CodexSettings, type ServerProviderModel } from "@specweave-studio/contracts";
import * as CodexErrors from "@specweave-studio/effect-codex-app-server/errors";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  makeCodexModelCatalogCache,
  codexNativeRouteVerified,
  readCodexNativeRoute,
  readCodexProviderMetadata,
  checkCodexProviderStatus,
  withAccountBilling,
  type CodexAppServerProviderSnapshot,
} from "./CodexProvider.ts";

describe("fresh Codex account status with optional discovery", () => {
  const account = {
    account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
    requiresOpenaiAuth: true,
  } as CodexSchema.V2GetAccountResponse;
  const settings = Schema.decodeUnknownSync(CodexSettings)({ binaryPath: "fixture-only-codex" });
  it.effect("keeps fresh supported account proof when skills and model catalogs time out", () =>
    Effect.gen(function* () {
      const client = {
        request: (method: string) => {
          if (method === "skills/list" || method === "model/list") return Effect.never;
          if (method === "config/read") return Effect.succeed({ config: {}, origins: {} });
          return Effect.succeed({ rateLimits: {}, ordinaryUsageAllowed: true });
        },
      } as Parameters<typeof readCodexProviderMetadata>[0];
      const probe = yield* checkCodexProviderStatus(settings, () =>
        readCodexProviderMetadata(client, { cwd: "/fixture" }).pipe(
          Effect.map((metadata) => ({
            account,
            nativeRouteVerified: metadata.nativeRouteVerified,
            ...(metadata.rateLimits ? { rateLimits: metadata.rateLimits } : {}),
            models: metadata.models,
            skills: [],
            version: "0.160.1",
          })),
        ),
      ).pipe(
        Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({})),
        Effect.forkChild,
      );
      yield* TestClock.adjust("4 seconds");
      const status = yield* Fiber.join(probe);
      expect(status.status).toBe("ready");
      expect(status.auth.status).toBe("authenticated");
      expect(status.auth.type).toBe("chatgpt");
      expect(status.models).toEqual([]);
      expect(status.skills).toEqual([]);
      expect(status.usageLimits?.nativeRouteVerified).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps optional route discovery bounded without treating unknown routing as verified",
    () =>
      Effect.gen(function* () {
        const client = {
          request: (method: string) => {
            if (method === "config/read") return Effect.never;
            if (method === "skills/list") return Effect.succeed({ data: [] });
            if (method === "model/list") return Effect.succeed({ data: [], nextCursor: null });
            return Effect.succeed({ rateLimits: {}, ordinaryUsageAllowed: true });
          },
        } as Parameters<typeof readCodexProviderMetadata>[0];
        const probe = yield* readCodexProviderMetadata(client, { cwd: "/fixture" }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("4 seconds");
        expect((yield* Fiber.join(probe)).nativeRouteVerified).toBe(false);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "degrades optional RPC failures without treating failed account probes as authenticated",
    () =>
      Effect.gen(function* () {
        const client = {
          request: (method: string) =>
            method === "config/read"
              ? Effect.succeed({ config: {}, origins: {} })
              : Effect.fail(new CodexErrors.CodexAppServerInputStreamEndedError({})),
        } as Parameters<typeof readCodexProviderMetadata>[0];
        const metadata = yield* readCodexProviderMetadata(client, { cwd: "/fixture" });
        expect(metadata.models).toEqual([]);
        expect(metadata.modelsDiscoveryFailed).toBe(true);
        expect(metadata.skillsResponse.data).toEqual([]);
        expect(metadata.rateLimits).toEqual({ failure: "Codex did not answer the usage request." });
        const failed = yield* checkCodexProviderStatus(settings, () =>
          Effect.fail(new CodexErrors.CodexAppServerInputStreamEndedError({})),
        ).pipe(Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({})));
        expect(failed.status).toBe("error");
        expect(failed.auth.status).toBe("unknown");
      }),
  );
  it.effect(
    "keeps a late fresh account result when bounded optional discovery reaches beyond the old combined deadline",
    () =>
      Effect.gen(function* () {
        const client = {
          request: (method: string) =>
            method === "config/read" ? Effect.succeed({ config: {}, origins: {} }) : Effect.never,
        } as Parameters<typeof readCodexProviderMetadata>[0];
        const checked = yield* checkCodexProviderStatus(settings, () =>
          Effect.sleep("9 seconds").pipe(
            Effect.andThen(readCodexProviderMetadata(client, { cwd: "/fixture" })),
            Effect.map((metadata) => ({
              account,
              nativeRouteVerified: metadata.nativeRouteVerified,
              ...(metadata.rateLimits ? { rateLimits: metadata.rateLimits } : {}),
              models: metadata.models,
              skills: [],
              version: "0.160.1",
            })),
          ),
        ).pipe(
          Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({})),
          Effect.forkChild,
        );
        yield* TestClock.adjust("9 seconds");
        yield* TestClock.adjust("4 seconds");
        const status = yield* Fiber.join(checked);
        expect(status.status).toBe("ready");
        expect(status.auth.type).toBe("chatgpt");
        expect(status.models).toEqual([]);
        expect(status.usageLimits?.nativeRouteVerified).toBe(true);
        expect(status.usageLimits?.unavailable?.reason).toBe("probeFailed");
      }).pipe(Effect.scoped),
  );
  it.effect(
    "leaves an unresponsive account probe unauthorized after its finite combined budget",
    () =>
      Effect.gen(function* () {
        const checked = yield* checkCodexProviderStatus(settings, () => Effect.never).pipe(
          Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({})),
          Effect.forkChild,
        );
        yield* TestClock.adjust("14 seconds");
        const status = yield* Fiber.join(checked);
        expect(status.status).toBe("error");
        expect(status.auth.status).toBe("unknown");
      }).pipe(Effect.scoped),
  );
});

describe("native Codex model discovery continuity", () => {
  const now = Date.parse("2026-10-09T00:00:00Z");
  const future: ServerProviderModel = {
    slug: "future-native",
    name: "Future Native",
    isCustom: false,
    isDefault: true,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "future-effort", label: "Future", isDefault: true }],
        },
      ],
    },
  };
  const observation = (
    changes: Partial<CodexAppServerProviderSnapshot> = {},
  ): CodexAppServerProviderSnapshot => ({
    account: {
      account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
      requiresOpenaiAuth: true,
    },
    version: "0.160.1",
    models: [future],
    skills: [],
    ...changes,
  });

  it("preserves a future native default instead of the static ranking", () => {
    expect(
      applyPreferredCodexDefaultModel([
        { slug: "gpt-6-astra", name: "Static preferred", isCustom: false, capabilities: null },
        future,
      ]).filter((model) => model.isDefault),
    ).toEqual([future]);
  });

  it("retains models and exact capabilities only for failed discovery of the same account", () => {
    const cache = makeCodexModelCatalogCache();
    expect(cache.resolve(observation(), now)).toEqual([future]);
    expect(
      cache.resolve(observation({ models: [], modelsDiscoveryFailed: true }), now + 1000),
    ).toEqual([future]);
    expect(
      cache.resolve(
        observation({
          models: [],
          modelsDiscoveryFailed: true,
          account: {
            account: { type: "chatgpt", email: "other@example.invalid", planType: "pro" },
            requiresOpenaiAuth: true,
          },
        }),
        now + 2000,
      ),
    ).toEqual([]);
    expect(
      cache.resolve(observation({ models: [], modelsDiscoveryFailed: true }), now + 3000),
    ).toEqual([]);
  });

  it("never replaces a successful empty catalog with an old catalog", () => {
    const cache = makeCodexModelCatalogCache();
    cache.resolve(observation(), now);
    expect(
      cache.resolve(observation({ models: [], modelsDiscoveryFailed: false }), now + 1000),
    ).toEqual([]);
    expect(
      cache.resolve(observation({ models: [], modelsDiscoveryFailed: true }), now + 2000),
    ).toEqual([]);
  });

  it("does not retain models when the same email moves to another reported account", () => {
    const cache = makeCodexModelCatalogCache();
    const first = observation({
      rateLimits: { snapshot: {}, resetCredits: null, accountId: "account-a" },
    });
    cache.resolve(first, now);
    expect(
      cache.resolve({ ...first, models: [], modelsDiscoveryFailed: true }, now + 1000),
    ).toEqual([future]);
    expect(
      cache.resolve(
        {
          ...first,
          models: [],
          modelsDiscoveryFailed: true,
          rateLimits: { snapshot: {}, resetCredits: null, accountId: "account-b" },
        },
        now + 2000,
      ),
    ).toEqual([]);
    cache.resolve(first, now + 3000);
    expect(
      cache.resolve(
        {
          ...first,
          models: [],
          modelsDiscoveryFailed: true,
          rateLimits: { failure: "Usage unavailable" },
        },
        now + 4000,
      ),
    ).toEqual([]);
  });

  it("bounds retention, isolates instances, and keeps current custom rows", () => {
    const cache = makeCodexModelCatalogCache();
    cache.resolve(observation(), now);
    const custom = { slug: "custom-current", name: "Custom", isCustom: true, capabilities: null };
    const failed = observation({ models: [custom], modelsDiscoveryFailed: true });
    expect(cache.resolve(failed, now + 1000)).toEqual([future, custom]);
    expect(makeCodexModelCatalogCache().resolve(failed, now + 1000)).toEqual([custom]);
    expect(cache.resolve(failed, now + 3600001)).toEqual([custom]);
    cache.resolve(observation(), now);
    cache.clear();
    expect(cache.resolve(failed, now + 1000)).toEqual([custom]);
  });

  it("does not reuse catalogs for anonymous or API authorization", () => {
    for (const account of [
      null,
      { type: "apiKey" as const },
      { type: "chatgpt" as const, email: null, planType: "pro" },
    ]) {
      const cache = makeCodexModelCatalogCache();
      cache.resolve(observation({ account: { account, requiresOpenaiAuth: true } }), now);
      expect(
        cache.resolve(
          observation({
            account: { account, requiresOpenaiAuth: true },
            models: [],
            modelsDiscoveryFailed: true,
          }),
          now + 1000,
        ),
      ).toEqual([]);
    }
  });

  it.effect(
    "reads every native page and distinguishes successful empty discovery from failure",
    () =>
      Effect.gen(function* () {
        const cursors: unknown[] = [];
        const wire = (id: string, isDefault: boolean): CodexSchema.V2ModelListResponse__Model => ({
          id,
          model: id,
          displayName: id,
          description: "Fixture",
          hidden: false,
          isDefault,
          defaultReasoningEffort: "future-effort",
          supportedReasoningEfforts: [{ reasoningEffort: "future-effort", description: "Future" }],
        });
        const client = {
          request: (method: string, params: { cursor?: string }) => {
            if (method === "model/list") {
              cursors.push(params.cursor);
              return Effect.succeed(
                params.cursor
                  ? { data: [wire("native-future", true)], nextCursor: null }
                  : { data: [wire("native-first", false)], nextCursor: "page-two" },
              );
            }
            if (method === "skills/list") return Effect.succeed({ data: [] });
            if (method === "config/read") return Effect.succeed({ config: {}, origins: {} });
            return Effect.succeed({ rateLimits: {} });
          },
        } as Parameters<typeof readCodexProviderMetadata>[0];
        const metadata = yield* readCodexProviderMetadata(client, { cwd: "/fixture" });
        expect(cursors).toEqual([undefined, "page-two"]);
        expect(metadata.models.map((model) => model.slug)).toEqual([
          "native-first",
          "native-future",
        ]);
        expect(metadata.modelsDiscoveryFailed).toBe(false);
        expect(metadata.models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          currentValue: "future-effort",
        });
        const empty = {
          request: (method: string) =>
            Effect.succeed(
              method === "model/list"
                ? { data: [], nextCursor: null }
                : method === "skills/list"
                  ? { data: [] }
                  : method === "config/read"
                    ? { config: {}, origins: {} }
                    : { rateLimits: {} },
            ),
        } as Parameters<typeof readCodexProviderMetadata>[0];
        const emptyMetadata = yield* readCodexProviderMetadata(empty, { cwd: "/fixture" });
        expect(emptyMetadata.models).toEqual([]);
        expect(emptyMetadata.modelsDiscoveryFailed).toBe(false);
      }),
  );

  it.effect(
    "publishes retained models through the provider check without retaining failed authentication",
    () =>
      Effect.gen(function* () {
        const cache = makeCodexModelCatalogCache();
        const settings = yield* Schema.decodeUnknownEffect(CodexSettings)({
          binaryPath: "fixture-only-codex",
        });
        const check = (snapshot: CodexAppServerProviderSnapshot) =>
          checkCodexProviderStatus(
            settings,
            () => Effect.succeed(snapshot),
            {},
            undefined,
            cache,
          ).pipe(Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({})));
        yield* check(observation());
        expect(
          (yield* check(observation({ models: [], modelsDiscoveryFailed: true }))).models,
        ).toEqual([{ ...future, billing: "subscription" }]);
        expect(
          (yield* check(
            observation({
              account: { account: null, requiresOpenaiAuth: true },
              models: [],
              modelsDiscoveryFailed: true,
            }),
          )).auth.status,
        ).toBe("unauthenticated");
        expect(
          (yield* check(observation({ models: [], modelsDiscoveryFailed: true }))).models,
        ).toEqual([]);
      }),
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("preserves the native default even when a static preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: undefined },
      { slug: "gpt-5.4", isDefault: true },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps qualified native defaults and their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-luna"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

describe("supported Codex native route metadata", () => {
  const defaultRoutes: ReadonlyArray<CodexSchema.V2ConfigReadResponse["config"]> = [
    {},
    { model_provider: "openai" },
    { forced_login_method: "chatgpt" },
    { model_providers: { other: { base_url: "http://unused.invalid" } } },
  ];
  const customRoutes: ReadonlyArray<CodexSchema.V2ConfigReadResponse["config"]> = [
    { model_provider: "custom" },
    { forced_login_method: "api" },
    { model_providers: { openai: { base_url: "http://custom.invalid" } } },
    { model_providers: { openai: { env_key: "CUSTOM_KEY" } } },
    { chatgpt_base_url: "http://custom.invalid" },
    { model_providers: [] },
  ];
  it.each(defaultRoutes)("accepts a default effective subscription route", (config) => {
    expect(codexNativeRouteVerified(config)).toBe(true);
  });
  it.each(customRoutes)("rejects custom provider, endpoint and forced API routes", (config) => {
    expect(codexNativeRouteVerified(config)).toBe(false);
  });
  it.each(["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/"])(
    "accepts the exact official ChatGPT default %s",
    (chatgpt_base_url) => {
      expect(
        codexNativeRouteVerified({
          model_provider: "openai",
          forced_login_method: "chatgpt",
          chatgpt_base_url,
        }),
      ).toBe(true);
      expect(codexNativeRouteVerified({ chatgpt_base_url })).toBe(true);
    },
  );
  it.each([
    "http://chatgpt.com/backend-api/",
    "https://chatgpt.com.evil.invalid/backend-api/",
    "https://www.chatgpt.com/backend-api/",
    "https://chatgpt.com@evil.invalid/backend-api/",
    "https://user@chatgpt.com/backend-api/",
    "https://user:password@chatgpt.com/backend-api/",
    "https://chatgpt.com:443/backend-api/",
    "https://chatgpt.com:8443/backend-api/",
    "https://chatgpt.com/backend-api/?route=native",
    "https://chatgpt.com/backend-api/?",
    "https://chatgpt.com/backend-api/#fragment",
    "https://chatgpt.com/backend-api/#",
    "https://chatgpt.com/backend-api/v1",
    "https://chatgpt.com/backend-api//",
    "https://chatgpt.com//backend-api/",
    "https://chatgpt.com/custom/../backend-api/",
    "https://chatgpt.com/%62ackend-api/",
    "https://CHATGPT.com/backend-api/",
    "HTTPS://chatgpt.com/backend-api/",
    " https://chatgpt.com/backend-api/",
    "https://chatgpt.com/backend-api/ ",
    "https:\\chatgpt.com\\backend-api\\",
    "",
  ])("rejects ambiguous, custom or malformed ChatGPT endpoint %s", (chatgpt_base_url) => {
    expect(codexNativeRouteVerified({ chatgpt_base_url })).toBe(false);
  });
  const canonicalWithUnsupportedRoute: ReadonlyArray<CodexSchema.V2ConfigReadResponse["config"]> = [
    { chatgpt_base_url: 42 },
    { chatgpt_base_url: [] },
    { chatgpt_base_url: { url: "https://chatgpt.com/backend-api/" } },
    { chatgpt_base_url: "https://chatgpt.com/backend-api/", model_provider: "custom" },
    { chatgpt_base_url: "https://chatgpt.com/backend-api/", forced_login_method: "api" },
    {
      chatgpt_base_url: "https://chatgpt.com/backend-api/",
      openai_base_url: "https://chatgpt.com/backend-api/",
    },
    {
      chatgpt_base_url: "https://chatgpt.com/backend-api/",
      model_providers: { openai: { base_url: "https://chatgpt.com/backend-api/" } },
    },
    {
      chatgpt_base_url: "https://chatgpt.com/backend-api/",
      model_providers: { openai: { env_key: "EXPLICIT_API_KEY" } },
    },
    {
      chatgpt_base_url: "https://chatgpt.com/backend-api/",
      model_providers: { openai: { http_headers: { Authorization: "synthetic-fixture-only" } } },
    },
  ];
  it.each(canonicalWithUnsupportedRoute)(
    "never lets a canonical endpoint override API or malformed route denial",
    (config) => {
      expect(codexNativeRouteVerified(config)).toBe(false);
    },
  );
  it("reads actual project cwd and denies a project override rather than reusing global proof", async () => {
    const requests: unknown[] = [];
    const client: Parameters<typeof readCodexNativeRoute>[0] = {
      request: (method, params) =>
        Effect.sync((): CodexSchema.V2ConfigReadResponse => {
          requests.push({ method, params });
          return {
            config:
              params.cwd === "/workspace/custom"
                ? { model_provider: "custom" }
                : { chatgpt_base_url: "https://chatgpt.com/backend-api/" },
            origins: {},
          };
        }),
    };
    expect(await Effect.runPromise(readCodexNativeRoute(client, "/workspace/default"))).toBe(true);
    expect(await Effect.runPromise(readCodexNativeRoute(client, "/workspace/custom"))).toBe(false);
    expect(requests).toEqual([
      { method: "config/read", params: { cwd: "/workspace/default", includeLayers: false } },
      { method: "config/read", params: { cwd: "/workspace/custom", includeLayers: false } },
    ]);
  });
  it("reports unavailable verification when supported config read fails", async () => {
    const client: Parameters<typeof readCodexNativeRoute>[0] = {
      request: () => Effect.fail(new CodexErrors.CodexAppServerInputStreamEndedError({})),
    };
    await expect(
      Effect.runPromise(readCodexNativeRoute(client, "/workspace")),
    ).rejects.toMatchObject({
      _tag: "CodexNativeRouteCheckError",
      reason: "unavailable",
    });
  });
  it.effect(
    "admits delayed valid native configuration beyond optional discovery's three seconds",
    () =>
      Effect.gen(function* () {
        const client: Parameters<typeof readCodexNativeRoute>[0] = {
          request: () => Effect.sleep("4 seconds").pipe(Effect.as({ config: {}, origins: {} })),
        };
        const checked = yield* readCodexNativeRoute(client, "/workspace").pipe(Effect.forkChild);
        yield* TestClock.adjust("4 seconds");
        expect(yield* Fiber.join(checked)).toBe(true);
      }).pipe(Effect.scoped),
  );
  it.effect("reports a bounded admission timeout without classifying it as a custom route", () =>
    Effect.gen(function* () {
      const client: Parameters<typeof readCodexNativeRoute>[0] = { request: () => Effect.never };
      const checked = yield* readCodexNativeRoute(client, "/workspace").pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("61 seconds");
      expect(yield* Fiber.join(checked)).toMatchObject({
        _tag: "CodexNativeRouteCheckError",
        reason: "timeout",
      });
    }).pipe(Effect.scoped),
  );
});

describe("withAccountBilling", () => {
  const models: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    },
    { slug: "mine", name: "Mine", isCustom: true, capabilities: { optionDescriptors: [] } },
  ];

  it("bills a ChatGPT sign-in on the plan and an API key per token, never custom models", () => {
    expect(withAccountBilling(models, "chatgpt").map((model) => model.billing)).toEqual([
      "subscription",
      undefined,
    ]);
    expect(withAccountBilling(models, "apiKey")[0]?.billing).toBe("api");
    expect(withAccountBilling(models, "amazonBedrock")[0]?.billing).toBe("api");
  });

  it("leaves billing unreported without an account read", () => {
    expect(withAccountBilling(models, undefined)).toBe(models);
    expect(withAccountBilling(models, "something-new")).toBe(models);
  });
});
