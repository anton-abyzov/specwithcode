import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  buildOpenModelEnvironment,
  OPEN_MODEL_PRESET_ENV,
  OPEN_MODEL_PRESETS,
  openModelPresetById,
} from "@specweave-studio/shared/openModelPresets";
import { isPerTokenProvider } from "@specweave-studio/shared/providerFallback";
import { billingOf } from "@specweave-studio/shared/taskRouting";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { BUNDLED_CLAUDE_MODEL_CATALOG } from "./ClaudeModelCatalog.ts";
import {
  discoverOpenModelIds,
  openModelRouteBilling,
  openModelRouteOf,
  presetOf,
  stampOpenModelSnapshot,
} from "./openModelRoute.ts";

const preset = (id: string) => {
  const found = openModelPresetById(id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

const routeFor = (id: string, input: { key?: string; baseUrl?: string; model?: string } = {}) => {
  const environment = buildOpenModelEnvironment({
    preset: preset(id),
    key: "sk-test-open-model",
    ...input,
  });
  const route = openModelRouteOf(environment);
  if (!route) throw new Error(`no route for ${id}`);
  return { environment, route };
};

const claudeModels = BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) => entry.model);
const builtInSlugsAndAliases = new Set(
  claudeModels.flatMap((model) => [model.slug, ...(model.aliases ?? [])]),
);

/** A Claude snapshot as the probe reports it: Claude's catalog, a plan and limits. */
const claudeSnapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude_open"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.331",
  status: "ready",
  auth: { status: "authenticated", type: "apiKey", label: "Claude Max", apiKeyBilling: true },
  checkedAt: "2026-11-28T00:00:00.000Z",
  models: [
    ...claudeModels,
    { slug: "my-custom", name: "My custom", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: { windows: [] } as unknown as ServerProvider["usageLimits"],
  ...overrides,
});

it("checks against a real built-in catalog with its aliases", () => {
  expect(claudeModels.length).toBeGreaterThan(0);
  expect(builtInSlugsAndAliases.has("opus")).toBe(true);
});

describe("openModelRouteOf", () => {
  it("reads the preset only from the marker row (D-05)", () => {
    expect(presetOf(routeFor("kimi").environment)?.id).toBe("kimi");
    const handBuilt: ProviderInstanceEnvironment = [
      { name: "ANTHROPIC_BASE_URL", value: "https://api.deepseek.com/anthropic", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-test-hand-built", sensitive: true },
    ];
    expect(openModelRouteOf(handBuilt)).toBeUndefined();
    expect(openModelRouteOf(undefined)).toBeUndefined();
    expect(
      openModelRouteOf([{ name: OPEN_MODEL_PRESET_ENV, value: "mistral", sensitive: false }]),
    ).toBeUndefined();
  });

  it("bills each preset as api, paid-router or local, never subscription", () => {
    const expected: Record<string, string> = {
      deepseek: "api",
      kimi: "api",
      zai: "api",
      openrouter: "paid-router",
      ollama: "local",
      lmstudio: "local",
    };
    for (const each of OPEN_MODEL_PRESETS) {
      const { route } = routeFor(each.id, { model: "test-model" });
      expect(route.billing).toBe(expected[each.id]);
      expect(route.billing).not.toBe("subscription");
    }
  });

  it("classifies the instance's own address, not only the preset's", () => {
    const { environment } = routeFor("ollama", { baseUrl: "http://127.0.0.1:11500" });
    expect(openModelRouteBilling(preset("ollama"), environment)).toBe("local");
    expect(openModelRouteOf(environment)?.baseUrl).toBe("http://127.0.0.1:11500");
  });

  it("lists the preset's ids, or the model the person chose", () => {
    expect(routeFor("zai").route.modelIds).toEqual(["glm-5.4", "glm-5.3-flash"]);
    expect(routeFor("openrouter", { model: "vendor/model-a" }).route.modelIds).toEqual([
      "vendor/model-a",
    ]);
    expect(routeFor("ollama").route.modelIds).toEqual([]);
  });
});

describe("stampOpenModelSnapshot", () => {
  it("lists only the vendor's models, billed per the route, with the route's label", () => {
    for (const each of OPEN_MODEL_PRESETS.filter((entry) => entry.kind === "key")) {
      const { route } = routeFor(each.id, { model: "vendor/model-a" });
      const stamped = stampOpenModelSnapshot(claudeSnapshot(), route);
      expect(stamped.openModelPreset).toBe(each.id);
      expect(stamped.auth).toEqual({
        status: "authenticated",
        type: "apiKey",
        label: "Your key",
      });
      expect(stamped.usageLimits).toBeUndefined();
      for (const model of stamped.models) {
        expect(builtInSlugsAndAliases.has(model.slug)).toBe(false);
        expect(model.aliases ?? []).toEqual([]);
        expect(model.billing).toBe(route.billing);
        expect(model.billing).not.toBe("subscription");
      }
      expect(stamped.models.map((model) => model.slug)).toEqual([...route.modelIds, "my-custom"]);
      expect(stamped.models[0]?.isDefault).toBe(true);
      expect(stamped.message).toBeUndefined();
    }
  });

  it("adds a local runtime's discovered models, and says when it lists none (D-09)", () => {
    const { route } = routeFor("lmstudio");
    const found = stampOpenModelSnapshot(claudeSnapshot(), route, ["qwen3-coder", "gemma-4"]);
    expect(found.auth.label).toBe("Local");
    expect(found.models.map((model) => [model.slug, model.billing])).toEqual([
      ["qwen3-coder", "local"],
      ["gemma-4", "local"],
      ["my-custom", "local"],
    ]);
    expect(found.message).toBeUndefined();

    const none = stampOpenModelSnapshot(claudeSnapshot(), route, []);
    expect(none.models.map((model) => model.slug)).toEqual(["my-custom"]);
    expect(none.message).toBe("No models found at http://localhost:1234");

    // Before the runtime has been asked, nothing is claimed.
    expect(stampOpenModelSnapshot(claudeSnapshot(), route).message).toBeUndefined();
    // A message the check already gave stays first.
    expect(
      stampOpenModelSnapshot(claudeSnapshot({ message: "Update Claude Code." }), route, []).message,
    ).toBe("Update Claude Code.");
  });

  it("reads the preset's token sign-in as your key or local, never a subscription", () => {
    // What Claude Code 2.1.331 reports under a preset's environment:
    // authMethod oauth_token, which the probe maps to an unverified subscription.
    const probed = claudeSnapshot({
      status: "warning",
      auth: {
        status: "unknown",
        type: "subscription-auth-unverified",
        label: "Subscription authorization unverified",
      },
    });
    const keyed = stampOpenModelSnapshot(probed, routeFor("zai").route);
    expect(keyed.status).toBe("ready");
    expect(keyed.auth).toEqual({ status: "authenticated", type: "apiKey", label: "Your key" });
    expect(isPerTokenProvider(keyed)).toBe(true);
    expect(billingOf(keyed, keyed.models[0])).toBe("api");

    const router = stampOpenModelSnapshot(
      probed,
      routeFor("openrouter", { model: "vendor/model-a" }).route,
    );
    expect(billingOf(router, router.models[0])).toBe("paid-router");

    const local = stampOpenModelSnapshot(probed, routeFor("ollama").route, ["llama4"]);
    expect(local.status).toBe("ready");
    expect(local.auth).toEqual({ status: "authenticated", type: "local", label: "Local" });
    expect(isPerTokenProvider(local)).toBe(false);
    expect(billingOf(local, local.models[0])).toBe("local");

    // A check that failed or found no sign-in is not turned into one.
    const failed = claudeSnapshot({
      status: "warning",
      auth: { status: "unknown", type: "status-check-failed" },
    });
    const stampedFailed = stampOpenModelSnapshot(failed, routeFor("kimi").route);
    expect(stampedFailed.status).toBe("warning");
    expect(stampedFailed.auth).toEqual({
      status: "unknown",
      type: "status-check-failed",
      label: "Your key",
    });
    const signedOut = claudeSnapshot({ status: "error", auth: { status: "unauthenticated" } });
    expect(stampOpenModelSnapshot(signedOut, routeFor("kimi").route).auth.status).toBe(
      "unauthenticated",
    );
  });

  it("returns a snapshot without a route untouched", () => {
    const snapshot = claudeSnapshot();
    expect(stampOpenModelSnapshot(snapshot, undefined, [])).toBe(snapshot);
  });
});

describe("discoverOpenModelIds", () => {
  const fakeFetch = (body: unknown, ok = true) => {
    const calls: Array<string> = [];
    const impl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return { ok, json: async () => body } as Response;
    }) as typeof globalThis.fetch;
    return { calls, impl };
  };

  it("asks a local runtime's /v1/models at the instance's address", async () => {
    const { route } = routeFor("ollama", { baseUrl: "http://127.0.0.1:11500" });
    const fetch = fakeFetch({ data: [{ id: "qwen3-coder:30b" }, { id: "llama4" }] });
    const ids = await Effect.runPromise(discoverOpenModelIds(route, fetch.impl));
    expect(ids).toEqual(["qwen3-coder:30b", "llama4"]);
    expect(fetch.calls).toEqual(["http://127.0.0.1:11500/v1/models"]);
  });

  it("gives an empty list when the runtime is down or answers badly", async () => {
    const { route } = routeFor("ollama");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    expect(await Effect.runPromise(discoverOpenModelIds(route, down))).toEqual([]);
    const bad = fakeFetch({ error: "nope" }, false);
    expect(await Effect.runPromise(discoverOpenModelIds(route, bad.impl))).toEqual([]);
  });

  it("does not call out for keyed presets", async () => {
    const { route } = routeFor("deepseek");
    const fetch = fakeFetch({ data: [{ id: "x" }] });
    expect(await Effect.runPromise(discoverOpenModelIds(route, fetch.impl))).toBeUndefined();
    expect(fetch.calls).toEqual([]);
  });
});
