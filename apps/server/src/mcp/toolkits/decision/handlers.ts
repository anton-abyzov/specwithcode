import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import type { DecisionResponse } from "@specweave-studio/shared/decisionModel";
import * as Effect from "effect/Effect";

import { ASKED_DECISION_TIMEOUT_MS, askDecisionModel } from "../../../decisions/DecisionModel.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { type DecideInput, type DecideResult, DecisionToolkit } from "./tools.ts";

/** Option names must be unique, ignoring case and surrounding space. */
export function duplicateOption(input: DecideInput): string | null {
  const seen = new Set<string>();
  for (const option of input.options) {
    const key = option.name.trim().toLowerCase();
    if (seen.has(key)) return option.name.trim();
    seen.add(key);
  }
  return null;
}

/** The tool result from the model's answer to the one `choice` question. */
export function decideResult(input: DecideInput, response: DecisionResponse): DecideResult | null {
  const answer = response.answers.choice;
  if (answer === undefined || answer.type !== "choice") return null;
  const names = input.options.map((option) => option.name.trim());
  if (!names.includes(answer.choice)) return null;
  const options = names
    .map((name) => ({ name, probability: answer.probabilities[name] ?? 0 }))
    .sort((a, b) => b.probability - a.probability);
  return {
    choice: answer.choice,
    probability: answer.probabilities[answer.choice] ?? answer.confidence,
    options,
    model: response.model,
  };
}

export const decide = (input: DecideInput, send?: typeof fetch) =>
  Effect.gen(function* () {
    const duplicate = duplicateOption(input);
    if (duplicate !== null)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Option "${duplicate}" is listed twice. Give every option a different name.`,
      });
    const response = yield* askDecisionModel(
      {
        state: input.context,
        questions: {
          choice: {
            type: "choice",
            instructions: input.question,
            criteria: Object.fromEntries(
              input.options.map((option) => [option.name.trim(), option.meaning]),
            ),
          },
        },
      },
      { timeoutMs: ASKED_DECISION_TIMEOUT_MS, ...(send === undefined ? {} : { send }) },
    ).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.kind === "off" ? "model_unavailable" : "provider_unavailable",
            message: error.message,
          }),
      ),
    );
    const result = decideResult(input, response);
    if (result === null)
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: "The decision model answered with an option that is not in the list.",
      });
    return result;
  });

export const layer = McpToolAccess.toLayer(DecisionToolkit, {
  studio_decide: McpToolAccess.readsAsCaller((input) => decide(input)),
});
