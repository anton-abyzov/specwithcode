import * as NodeAssert from "node:assert/strict";
import { it } from "vite-plus/test";

import { JEV_ENDPOINTS, requestJevDecision } from "./jevClient.ts";

const request = {
  state: "Fix the typo in README",
  questions: {
    lane: {
      type: "choice" as const,
      instructions: "Which lane?",
      criteria: { complex: "Hard", routine: "Easy" },
    },
  },
};
const options = () => ({ signal: new AbortController().signal, timeoutMs: 2_000 });

it("posts the model, state and questions with the key as a bearer token", async () => {
  let seen: { url: string; headers: Headers; body: unknown } | null = null;
  const response = await requestJevDecision(
    { provider: "typesafe", apiKey: "ts-key", model: "jev-latest" },
    request,
    options(),
    (async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({
        model: "jev-2026-10",
        answers: {
          lane: {
            type: "choice",
            choice: "routine",
            confidence: 0.9,
            probabilities: { routine: 0.9, complex: 0.1 },
          },
        },
        usage: { input_tokens: 30, output_tokens: 0 },
      });
    }) as typeof fetch,
  );
  NodeAssert.ok(seen);
  const sent = seen as { url: string; headers: Headers; body: unknown };
  NodeAssert.equal(sent.url, JEV_ENDPOINTS.typesafe);
  NodeAssert.equal(sent.headers.get("authorization"), "Bearer ts-key");
  NodeAssert.deepEqual(sent.body, { model: "jev-latest", ...request });
  NodeAssert.equal(response.model, "jev-2026-10");
});

it("never puts the key or the provider's body in an error", async () => {
  for (const [status, pattern] of [
    [401, /refused the API key/],
    [429, /request or usage limit/],
    [422, /could not read the question/],
    [503, /HTTP 503/],
  ] as const) {
    await NodeAssert.rejects(
      requestJevDecision(
        { provider: "typesafe", apiKey: "ts-key", model: "jev-latest" },
        request,
        options(),
        (async () => new Response("ts-key is wrong", { status })) as typeof fetch,
      ),
      (error: Error) => pattern.test(error.message) && !error.message.includes("ts-key"),
    );
  }
});

it("refuses an answer that is not a decision", async () => {
  await NodeAssert.rejects(
    requestJevDecision(
      { provider: "openrouter", apiKey: "k", model: "jev-1.13" },
      request,
      options(),
      (async () => Response.json({ hello: "world" })) as typeof fetch,
    ),
    /cannot read/,
  );
  await NodeAssert.rejects(
    requestJevDecision(
      { provider: "openrouter", apiKey: "k", model: "jev-1.13" },
      request,
      options(),
      (async () => {
        throw new TypeError("network down");
      }) as typeof fetch,
    ),
    /did not answer within 2 s/,
  );
});

it("masks credentials, and the key itself, before anything leaves the machine", async () => {
  let body = "";
  await requestJevDecision(
    { provider: "openrouter", apiKey: "sk-or-v1-secretkeyvalue", model: "jev-1.13" },
    {
      state: "Deploy with GITHUB_TOKEN=ghp_abcdefghijklmnop1234 and key sk-or-v1-secretkeyvalue",
      questions: {
        ok: { type: "noul", instructions: "Use password: hunter2hunter2 to log in?" },
      },
    },
    options(),
    (async (url: string, init?: RequestInit) => {
      NodeAssert.equal(url, JEV_ENDPOINTS.openrouter);
      body = String(init?.body);
      return Response.json({ model: "jev-1.13", answers: { ok: { type: "noul", noul: 0.2 } } });
    }) as typeof fetch,
  );
  NodeAssert.doesNotMatch(body, /ghp_abcdefghijklmnop1234|secretkeyvalue|hunter2/);
  NodeAssert.match(body, /\[redacted\]/);
});
