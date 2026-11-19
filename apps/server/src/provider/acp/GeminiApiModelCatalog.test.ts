import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  fetchGeminiApiModels,
  geminiApiKeyForInstance,
  parseGeminiApiModels,
} from "./GeminiApiModelCatalog.ts";

const text = ["generateContent", "countTokens", "batchGenerateContent"];
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name: `models/${name}`,
  displayName: name,
  supportedGenerationMethods: text,
  thinking: true,
  inputTokenLimit: 1_048_576,
  outputTokenLimit: 65_536,
  ...extra,
});

// Shape and names from the Gemini API's models.list for a paid EasyChamp key,
// November 19, 2026.
const LIST = {
  models: [
    entry("gemini-2.5-pro", { displayName: "Gemini 2.5 Pro" }),
    entry("gemini-2.5-flash-preview-tts", { thinking: undefined }),
    entry("gemini-flash-latest"),
    entry("gemma-4-31b-it"),
    entry("gemini-3.1-flash-lite-preview"),
    entry("gemini-3.1-flash-lite"),
    entry("gemini-3.1-pro-preview-customtools"),
    entry("gemini-3-pro-image"),
    entry("gemini-omni-1.2-flash"),
    entry("gemini-3.8-flash", { displayName: "Gemini 3.8 Flash" }),
    entry("gemini-3.8-flash-tts", { thinking: undefined }),
    entry("gemini-4-argon", { displayName: "Gemini 4 Argon", outputTokenLimit: 32_768 }),
    entry("gemini-4-neon", { displayName: "Gemini 4 Neon" }),
    entry("gemini-2.5-computer-use-preview-10-2025"),
    entry("gemini-robotics-er-2-preview"),
    entry("gemini-embedding-2", { supportedGenerationMethods: ["embedContent"] }),
    entry("gemini-3.8-live", { supportedGenerationMethods: ["bidiGenerateContent"] }),
  ],
};

describe("parseGeminiApiModels", () => {
  it("keeps thinking text models, newest family first, without media or dated variants", () => {
    expect(parseGeminiApiModels(LIST).map((model) => model.id)).toEqual([
      "gemini-4-argon",
      "gemini-4-neon",
      "gemini-3.8-flash",
      "gemini-3.1-flash-lite",
      "gemini-2.5-pro",
    ]);
  });

  it("carries the display name and the token limits the API reports", () => {
    expect(parseGeminiApiModels(LIST).find((model) => model.id === "gemini-4-neon")).toEqual({
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      contextWindow: 1_048_576,
      maxOutput: 65_536,
    });
  });

  it("reads nothing from a malformed body", () => {
    expect(parseGeminiApiModels(null)).toEqual([]);
    expect(parseGeminiApiModels({ models: "x" })).toEqual([]);
    expect(parseGeminiApiModels({ models: [null, 3, { name: 4 }] })).toEqual([]);
  });
});

describe("geminiApiKeyForInstance", () => {
  const env = { GEMINI_API_KEY: " key-1 " };
  it("uses the key only for Gemini CLI signed in with a Gemini API key", () => {
    expect(
      geminiApiKeyForInstance({ agentId: "gemini", authMethodId: "gemini-api-key" }, env),
    ).toBe("key-1");
    expect(geminiApiKeyForInstance({ agentId: "gemini" }, env)).toBe("key-1");
    expect(
      geminiApiKeyForInstance({ agentId: "gemini", authMethodId: "vertex-ai" }, env),
    ).toBeUndefined();
    expect(
      geminiApiKeyForInstance({ agentId: "gemini", authMethodId: "oauth-personal" }, env),
    ).toBeUndefined();
    expect(geminiApiKeyForInstance({ agentId: "github-copilot-cli" }, env)).toBeUndefined();
    expect(geminiApiKeyForInstance({ agentId: "gemini" }, {})).toBeUndefined();
  });
});

describe("fetchGeminiApiModels", () => {
  it.effect("lists the key's models from the Gemini API", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("https://gemini.example/v1beta/models?pageSize=1000");
        expect(request.headers["x-goog-api-key"]).toBe("key-1");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(LIST)));
      });
      const models = yield* fetchGeminiApiModels({
        apiKey: "key-1",
        baseUrl: "https://gemini.example/",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(models.map((model) => model.id)).toContain("gemini-4-neon");
    }),
  );

  it.effect("returns no models when the key is refused", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("denied", { status: 403 })),
        ),
      );
      const models = yield* fetchGeminiApiModels({ apiKey: "bad" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(models).toEqual([]);
    }),
  );
});
