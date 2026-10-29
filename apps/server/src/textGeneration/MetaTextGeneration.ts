/**
 * MetaTextGeneration — commit messages, PR content, branch names, and
 * thread titles through the Meta Model API (per-token Muse Wonder / Spark
 * over the OpenAI-compatible Chat Completions endpoint). Used when the
 * Muse instance carries a Meta API key; agentic turns and Wonder Full
 * stay on the Muse Code subscription driver, which the API cannot serve.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TextGenerationError } from "@specweave-studio/contracts";

import { stringifyJson } from "../json.ts";
import * as TextGenerationOperations from "./TextGenerationOperations.ts";

const META_API_TIMEOUT_MS = 180_000;
const META_API_BASE_URL = "https://api.meta.ai/v1";

const isTextGenerationError = Schema.is(TextGenerationError);

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The API key a Muse instance may carry, under either documented name. */
export function metaApiKey(environment: NodeJS.ProcessEnv): string | undefined {
  const key = environment.META_API_KEY?.trim() || environment.MODEL_API_KEY?.trim();
  return key ? key : undefined;
}

export const makeMetaTextGeneration = (
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
  baseUrl: string = META_API_BASE_URL,
) => {
  const runMetaJson: TextGenerationOperations.Runner = (request) => {
    const { operation, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const apiKey = metaApiKey(environment);
      if (apiKey === undefined) {
        return yield* new TextGenerationError({
          operation,
          detail: "No Meta API key is configured for this Muse Code instance.",
        });
      }
      const model =
        modelSelection.model === "default" || modelSelection.model === ""
          ? "muse-spark-1.3"
          : modelSelection.model;
      if (/full/i.test(model)) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Muse Wonder Full is a Muse Code subscription model and is not available on the Meta Model API. Pick Muse Wonder or Spark for API-key text generation.",
        });
      }
      const body = stringifyJson({
        model,
        messages: [{ role: "user", content: prompt }],
      });
      const text = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body,
          });
          if (!response.ok) {
            throw new TextGenerationError({
              operation,
              detail: `Meta Model API request failed with HTTP ${response.status}. Check the Meta API key and model, then retry.`,
            });
          }
          const payload = (await response.json()) as {
            choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
          };
          const content = payload.choices?.[0]?.message?.content;
          return typeof content === "string" ? content.trim() : "";
        },
        catch: (cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Meta Model API text generation failed.",
                cause,
              }),
      });
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: "Meta Model API returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Meta Model API", text);
    }).pipe(
      Effect.timeoutOption(META_API_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Meta Model API request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Meta Model API text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner("MetaTextGeneration", runMetaJson);
};
