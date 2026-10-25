import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";

import { classifyBaseUrlBilling, isPaidModel, modelBilling } from "./modelBilling.ts";

const model = (slug: string, over: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...over,
});

const provider = (over: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  version: null,
  models: [
    model("openrouter/qwen3-coder", { billing: "paid-router" }),
    model("ollama/qwen3", { billing: "local" }),
    model("anthropic/claude", { billing: "api" }),
    model("plan", { billing: "subscription" }),
    model("unproven", { billing: "unknown" }),
    model("bare"),
  ],
  slashCommands: [],
  skills: [],
  ...over,
});

const apiKeyProvider = provider({ auth: { status: "authenticated", type: "apiKey" } });

describe("modelBilling", () => {
  it("returns the billing the provider reports for the model", () => {
    expect(modelBilling(provider(), "openrouter/qwen3-coder")).toBe("paid-router");
    expect(modelBilling(provider(), "ollama/qwen3")).toBe("local");
    expect(modelBilling(provider(), "anthropic/claude")).toBe("api");
    expect(modelBilling(provider(), "plan")).toBe("subscription");
  });

  it("is unknown when nothing is reported and the instance is not per-token", () => {
    expect(modelBilling(provider(), "bare")).toBe("unknown");
    expect(modelBilling(provider(), "unproven")).toBe("unknown");
    expect(modelBilling(provider(), "missing")).toBe("unknown");
    expect(modelBilling(provider(), undefined)).toBe("unknown");
    expect(modelBilling(undefined, "bare")).toBe("unknown");
  });

  it("derives api from a per-token instance when the model reports nothing provable", () => {
    expect(modelBilling(apiKeyProvider, "bare")).toBe("api");
    expect(modelBilling(apiKeyProvider, "unproven")).toBe("api");
    expect(modelBilling(apiKeyProvider, undefined)).toBe("api");
    expect(modelBilling(apiKeyProvider, "ollama/qwen3")).toBe("local");
  });
});

describe("isPaidModel", () => {
  it("is true for paid-router and api models on a subscription instance", () => {
    expect(isPaidModel(provider(), "openrouter/qwen3-coder")).toBe(true);
    expect(isPaidModel(provider(), "anthropic/claude")).toBe(true);
  });

  it("is false for local, subscription and unproven models on a subscription instance", () => {
    for (const slug of ["ollama/qwen3", "plan", "unproven", "bare", "missing"]) {
      expect(isPaidModel(provider(), slug)).toBe(false);
    }
    expect(isPaidModel(provider(), undefined)).toBe(false);
    expect(isPaidModel(undefined, "bare")).toBe(false);
  });

  it("is true for every model of a per-token instance", () => {
    expect(isPaidModel(apiKeyProvider, "ollama/qwen3")).toBe(true);
    expect(isPaidModel(apiKeyProvider, "bare")).toBe(true);
    expect(isPaidModel(apiKeyProvider, undefined)).toBe(true);
  });
});

describe("classifyBaseUrlBilling", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://127.10.0.3",
    "http://[::1]:8080/v1",
    "http://[::ffff:127.0.0.1]:1234/v1",
    "http://0.0.0.0:8000",
    "http://api.localhost:3000",
    "localhost:11434",
  ])("reads %s as local", (baseUrl) => {
    expect(classifyBaseUrlBilling(baseUrl, "ollama")).toBe("local");
  });

  it("does not read an IPv4-mapped LAN address as local", () => {
    expect(classifyBaseUrlBilling("http://[::ffff:10.0.0.5]:1234/v1", "ollama")).toBe("unknown");
  });

  it("reads a coding-plan endpoint as unknown, not a keyed API", () => {
    expect(classifyBaseUrlBilling("https://api.z.ai/api/coding/paas/v4", "zai")).toBe("unknown");
    expect(classifyBaseUrlBilling("https://api.kimi.com/coding", "kimi-coding")).toBe("unknown");
    expect(classifyBaseUrlBilling("https://api.z.ai/api/paas/v4", "zai")).toBe("api");
  });

  it("requires a known local runtime before treating loopback as free", () => {
    const ids = [
      "anthropic",
      "openai",
      "google",
      "ollama",
      "lmstudio",
      "custom",
      undefined,
      "openrouter",
    ];
    expect(ids.map((id) => classifyBaseUrlBilling("http://127.0.0.1:4000/v1", id))).toEqual([
      "api",
      "api",
      "api",
      "local",
      "local",
      "unknown",
      "unknown",
      "paid-router",
    ]);
  });

  it("reads OpenRouter by id or host as paid-router, even behind a loopback proxy", () => {
    expect(classifyBaseUrlBilling(undefined, "openrouter")).toBe("paid-router");
    expect(classifyBaseUrlBilling(undefined, "OpenRouter")).toBe("paid-router");
    expect(classifyBaseUrlBilling("https://openrouter.ai/api/v1", "custom")).toBe("paid-router");
    expect(classifyBaseUrlBilling("http://localhost:4000", "openrouter")).toBe("paid-router");
  });

  it.each([
    "anthropic",
    "openai",
    "google",
    "deepseek",
    "moonshotai",
    "zai",
    "zhipuai",
    "xai",
    "mistral",
    "groq",
    "together",
    "fireworks",
    "cerebras",
    "deepinfra",
    "amazon-bedrock",
    "opencode",
    "vercel-ai-gateway",
    "huggingface",
  ])("reads provider id %s as api", (id) => {
    expect(classifyBaseUrlBilling(undefined, id)).toBe("api");
  });

  it("reads a known cloud API host as api whatever the provider id", () => {
    expect(classifyBaseUrlBilling("https://api.deepseek.com/v1", "my-deepseek")).toBe("api");
    expect(classifyBaseUrlBilling("https://api.moonshot.ai/v1", undefined)).toBe("api");
    expect(
      classifyBaseUrlBilling("https://generativelanguage.googleapis.com/v1beta", "gemini"),
    ).toBe("api");
  });

  it("leaves subscription plans and unknown endpoints unknown", () => {
    expect(classifyBaseUrlBilling(undefined, "zai-coding-plan")).toBe("unknown");
    expect(classifyBaseUrlBilling(undefined, "github-copilot")).toBe("unknown");
    expect(classifyBaseUrlBilling("http://192.168.1.20:11434/v1", "ollama")).toBe("unknown");
    expect(classifyBaseUrlBilling("https://llm.example.com/v1", "custom")).toBe("unknown");
    expect(classifyBaseUrlBilling("not a url", undefined)).toBe("unknown");
    expect(classifyBaseUrlBilling("", "")).toBe("unknown");
    expect(classifyBaseUrlBilling(null, null)).toBe("unknown");
  });

  it("does not mistake a lookalike host for a known domain", () => {
    expect(classifyBaseUrlBilling("https://notopenrouter.ai", undefined)).toBe("unknown");
    expect(classifyBaseUrlBilling("https://localhost.example.com", undefined)).toBe("unknown");
  });
});
