import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { chatGptModels } from "./CodexChatGptModels.ts";

it.effect(
  "uses each selected profile's token and the server's visible catalog order and names",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.url, "https://api.openai.com/v1/models");
          requests.push(request.headers.authorization!);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                models:
                  request.headers.authorization === "Bearer account-a"
                    ? [
                        { slug: "second", display_name: "Second from OpenAI", visibility: "list" },
                        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
                        { slug: "first", display_name: "First from OpenAI", visibility: "list" },
                      ]
                    : [{ slug: "account-b-only", display_name: "B", visibility: "list" }],
              }),
            ),
          );
        }),
      );
      const native = [
        {
          slug: "first",
          name: "Cached first",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
        { slug: "not-entitled", name: "Cached other", isCustom: false, capabilities: null },
      ];
      const a = yield* chatGptModels("account-a", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        a.map((model) => [model.slug, model.name]),
        [
          ["second", "Second from OpenAI"],
          ["first", "First from OpenAI"],
        ],
      );
      assert.deepEqual(a[1]!.capabilities, native[0]!.capabilities);
      assert.isNull(a[0]!.capabilities);
      const b = yield* chatGptModels("account-b", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        b.map((model) => model.slug),
        ["account-b-only"],
      );
      assert.deepEqual(requests, ["Bearer account-a", "Bearer account-b"]);
    }),
);

it.effect("does not present a cached catalog as account entitlements when discovery fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
    );
    const error = yield* Effect.flip(
      chatGptModels("account-a", []).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
    assert.strictEqual(error._tag, "ChatGptCatalogError");
  }),
);

it.effect("a release this Codex build does not list borrows its line's newest options", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              models: [
                { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
                { slug: "gpt-6.2-nova", display_name: "GPT-6.2-Nova", visibility: "list" },
              ],
            }),
          ),
        ),
      ),
    );
    const levels = (ids: ReadonlyArray<string>) => ({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: ids.map((id) => ({ id, label: id })),
        },
      ],
    });
    const tiers = {
      id: "serviceTier",
      label: "Service Tier",
      type: "select" as const,
      options: [{ id: "default", label: "Standard" }],
    };
    const newest = levels(["low", "xhigh"]);
    const native = [
      { slug: "gpt-5.6-sol", name: "old", isCustom: false, capabilities: levels(["low"]) },
      {
        slug: "gpt-6-sol",
        name: "new",
        isCustom: false,
        capabilities: { optionDescriptors: [...newest.optionDescriptors, tiers] },
      },
      { slug: "gpt-6-luna", name: "other", isCustom: false, capabilities: levels(["medium"]) },
    ];
    const models = yield* chatGptModels("token", native).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    // Only the reasoning levels: service tiers are not borrowed.
    assert.deepEqual(models[0]!.capabilities, newest);
    assert.isNull(models[1]!.capabilities);
  }),
);
