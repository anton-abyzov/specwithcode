import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import {
  DECISION_MAX_OPTIONS,
  DECISION_STATE_MAX_CHARS,
} from "@specweave-studio/shared/decisionModel";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const OptionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/\S/),
);

export const DecideInput = Schema.Struct({
  question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)).annotate({
    description: "The question, phrased so that exactly one option answers it.",
  }),
  options: Schema.Array(
    Schema.Struct({
      name: OptionName.annotate({ description: "A short, unique name for the option." }),
      meaning: Schema.String.check(Schema.isMaxLength(500)).annotate({
        description: "What choosing this option means, in one or two sentences.",
      }),
    }),
  )
    .check(Schema.isMinLength(2), Schema.isMaxLength(DECISION_MAX_OPTIONS))
    .annotate({ description: "Two or more options to pick from." }),
  context: Schema.String.check(Schema.isMaxLength(DECISION_STATE_MAX_CHARS)).annotate({
    description:
      "The facts the decision rests on: the task, the thread summaries, the error, the diff summary. The model sees only this and the question.",
  }),
});
export type DecideInput = typeof DecideInput.Type;

export const DecideResult = Schema.Struct({
  choice: Schema.String,
  /** Probability of the chosen option, 0..1. */
  probability: Schema.Number,
  /** Every option's probability, highest first. */
  options: Schema.Array(Schema.Struct({ name: Schema.String, probability: Schema.Number })),
  model: Schema.String,
});
export type DecideResult = typeof DecideResult.Type;

const DecideTool = Tool.make("studio_decide", {
  description:
    "Ask the decision model (TypeSafe's Jev, through OpenRouter or TypeSafe) to pick one of a fixed list of options. It answers in well under a second, costs almost nothing, and returns the choice with every option's probability instead of prose. Use it when you face a multiple-choice decision you would otherwise reason through at length: which thread should own a follow-up, whether a result meets the bar, which of several approaches fits the brief, which lane (complex or routine) a task belongs in. Put everything the decision needs in context; the model sees nothing else. Treat a probability under 0.7 as unsure and decide yourself, or ask the user. Fails with model_unavailable when the user has not set up the decision model in Settings > Providers > Decision model; then decide yourself and do not ask them to set it up unless they asked about it.",
  parameters: DecideInput,
  success: DecideResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Decide between options")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const DecisionToolkit = Toolkit.make(DecideTool);
