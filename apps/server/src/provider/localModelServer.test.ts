import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildLocalModelOpenCodeConfig,
  isLocalModelSlug,
  fetchLocalModelIds,
  normalizeLocalServerUrl,
  parseLocalModelIds,
  withLocalModelServerEnvironment,
} from "./localModelServer.ts";

describe("normalizeLocalServerUrl", () => {
  it("adds /v1 and drops trailing slashes", () => {
    assert.strictEqual(
      normalizeLocalServerUrl(" http://localhost:11434/ "),
      "http://localhost:11434/v1",
    );
    assert.strictEqual(
      normalizeLocalServerUrl("http://127.0.0.1:1234/v1/"),
      "http://127.0.0.1:1234/v1",
    );
    assert.strictEqual(normalizeLocalServerUrl("   "), "");
  });

  it("adds a scheme when none is given and keeps an explicit path", () => {
    assert.strictEqual(normalizeLocalServerUrl("localhost:11434"), "http://localhost:11434/v1");
    assert.strictEqual(
      normalizeLocalServerUrl("http://127.0.0.1:8080/api/v1"),
      "http://127.0.0.1:8080/api/v1",
    );
  });
});

describe("isLocalModelSlug", () => {
  it("matches only the local provider's models", () => {
    assert.isTrue(isLocalModelSlug("local/qwen3-8b"));
    assert.isFalse(isLocalModelSlug("localai/qwen3-8b"));
    assert.isFalse(isLocalModelSlug("anthropic/claude"));
    assert.isFalse(isLocalModelSlug(undefined));
  });
});

describe("parseLocalModelIds", () => {
  it("reads unique ids from an OpenAI-style list", () => {
    assert.deepStrictEqual(
      parseLocalModelIds({
        data: [{ id: "qwen3-8b" }, { id: "qwen3-8b" }, { id: " " }, { x: 1 }, null],
      }),
      ["qwen3-8b"],
    );
  });

  it("yields no ids for malformed replies", () => {
    assert.deepStrictEqual(parseLocalModelIds(null), []);
    assert.deepStrictEqual(parseLocalModelIds({ data: "nope" }), []);
    assert.deepStrictEqual(parseLocalModelIds("text"), []);
  });
});

describe("buildLocalModelOpenCodeConfig", () => {
  it("registers the server as the keyless local provider", () => {
    const config = JSON.parse(
      buildLocalModelOpenCodeConfig("http://localhost:11434/v1", ["qwen3-8b"]),
    );
    assert.deepStrictEqual(config, {
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local model",
          options: { baseURL: "http://localhost:11434/v1", apiKey: "local" },
          models: { "qwen3-8b": { name: "qwen3-8b" } },
        },
      },
    });
  });
});

describe("fetchLocalModelIds", () => {
  it.effect("lists models from /models", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const fakeFetch = (async (url: string) => {
        requested.push(url);
        return new Response(JSON.stringify({ data: [{ id: "qwen3-8b" }] }));
      }) as unknown as typeof globalThis.fetch;
      const ids = yield* fetchLocalModelIds("http://localhost:8081/v1", fakeFetch);
      assert.deepStrictEqual(ids, ["qwen3-8b"]);
      assert.deepStrictEqual(requested, ["http://localhost:8081/v1/models"]);
    }),
  );

  it.effect("yields no models when the server is down or errors", () =>
    Effect.gen(function* () {
      const down = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch;
      const failing = (async () =>
        new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
      assert.deepStrictEqual(yield* fetchLocalModelIds("http://localhost:1/v1", down), []);
      assert.deepStrictEqual(yield* fetchLocalModelIds("http://localhost:1/v1", failing), []);
    }),
  );
});

describe("withLocalModelServerEnvironment", () => {
  const listModels = () => Effect.succeed(["qwen3-8b"] as ReadonlyArray<string>);

  it.effect("adds the local provider config to the instance environment", () =>
    Effect.gen(function* () {
      const environment = yield* withLocalModelServerEnvironment({
        enabled: true,
        inheritedConfigContent: undefined,
        localModelServer: "http://localhost:11434",
        serverUrl: "",
        environment: [{ name: "FOO", value: "bar", sensitive: false }],
        listModels,
      });
      assert.strictEqual(environment?.length, 2);
      assert.strictEqual(environment?.[0]?.name, "FOO");
      const injected = environment?.[1];
      assert.strictEqual(injected?.name, "OPENCODE_CONFIG_CONTENT");
      const config = JSON.parse(injected?.value ?? "{}");
      assert.strictEqual(config.provider.local.options.baseURL, "http://localhost:11434/v1");
      assert.deepStrictEqual(Object.keys(config.provider.local.models), ["qwen3-8b"]);
    }),
  );

  it.effect("leaves the environment alone when not applicable", () =>
    Effect.gen(function* () {
      const own = [{ name: "OPENCODE_CONFIG_CONTENT", value: "{}", sensitive: false }];
      const base = {
        enabled: true,
        inheritedConfigContent: undefined,
        localModelServer: "http://localhost:11434",
        serverUrl: "",
        environment: undefined,
        listModels,
      };
      assert.strictEqual(
        yield* withLocalModelServerEnvironment({ ...base, localModelServer: "" }),
        undefined,
      );
      assert.strictEqual(
        yield* withLocalModelServerEnvironment({ ...base, enabled: false }),
        undefined,
      );
      assert.strictEqual(
        yield* withLocalModelServerEnvironment({ ...base, inheritedConfigContent: "{}" }),
        undefined,
      );
      assert.strictEqual(
        yield* withLocalModelServerEnvironment({ ...base, serverUrl: "http://127.0.0.1:4096" }),
        undefined,
      );
      assert.strictEqual(
        yield* withLocalModelServerEnvironment({ ...base, environment: own }),
        own,
      );
    }),
  );
});
