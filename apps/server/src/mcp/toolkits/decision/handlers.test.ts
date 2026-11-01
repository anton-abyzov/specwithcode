import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";
import { decide, decideResult, duplicateOption } from "./handlers.ts";

const input = {
  question: "Which thread should own the follow-up?",
  options: [
    { name: "docs", meaning: "The docs thread" },
    { name: "api", meaning: "The API thread" },
    { name: "new", meaning: "Start a new thread" },
  ],
  context: "The follow-up changes the API response and its docs page.",
};

const jev = (choice: string, probabilities: Record<string, number>) =>
  (async () =>
    Response.json({
      model: "jev-latest",
      answers: {
        choice: { type: "choice", choice, confidence: probabilities[choice], probabilities },
      },
    })) as typeof fetch;

it("lists every option's probability, highest first", () => {
  const result = decideResult(input, {
    model: "jev-latest",
    answers: {
      choice: {
        type: "choice",
        choice: "api",
        confidence: 0.7,
        probabilities: { api: 0.7, docs: 0.2, new: 0.1 },
      },
    },
  });
  NodeAssert.deepEqual(result, {
    choice: "api",
    probability: 0.7,
    options: [
      { name: "api", probability: 0.7 },
      { name: "docs", probability: 0.2 },
      { name: "new", probability: 0.1 },
    ],
    model: "jev-latest",
  });
});

it("finds an option listed twice", () => {
  NodeAssert.equal(duplicateOption(input), null);
  NodeAssert.equal(
    duplicateOption({ ...input, options: [...input.options, { name: " API ", meaning: "" }] }),
    "API",
  );
});

it.effect("asks Jev one choice question built from the options", () =>
  Effect.gen(function* () {
    const result = yield* decide(input, jev("docs", { docs: 0.8, api: 0.15, new: 0.05 }));
    NodeAssert.equal(result.choice, "docs");
    NodeAssert.equal(result.probability, 0.8);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ decisionModel: { provider: "typesafe", apiKey: "ts-key" } }),
    ),
  ),
);

it.effect("reports model_unavailable when no decision model is set up", () =>
  Effect.gen(function* () {
    const never = (async () => {
      throw new Error("no request expected");
    }) as typeof fetch;
    const error = yield* Effect.flip(decide(input, never));
    NodeAssert.equal(error.code, "model_unavailable");
    NodeAssert.match(error.message, /Settings > Providers > Decision model/);
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("refuses an answer outside the list", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(input, jev("other", { other: 0.9 })));
    NodeAssert.equal(error.code, "provider_unavailable");
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ decisionModel: { provider: "typesafe", apiKey: "ts-key" } }),
    ),
  ),
);
