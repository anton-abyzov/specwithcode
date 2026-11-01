/**
 * The decision model: a fast model that answers a typed question about some
 * text (pick one of these options, how likely is this, where on this scale)
 * with probabilities instead of prose. TypeSafe's Jev is the one supported.
 * This module builds the questions routing asks, reads the answers back and
 * decides when an answer is sure enough to act on. Pure: the server makes the
 * request (`apps/server/src/decisions`).
 *
 * @module decisionModel
 */
import { type ModelLane, TASK_CLASSES, type TaskClass } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The most text sent as state: about 6k tokens, far inside the model's window. */
export const DECISION_STATE_MAX_CHARS = 24_000;
/** A routing answer moves a worker only at this probability or more. */
export const DECISION_MIN_CONFIDENCE = 0.7;
/** Choice questions take at most this many options. */
export const DECISION_MAX_OPTIONS = 255;

export const DecisionQuestion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Schema.String,
    /** Option name to what it means. */
    criteria: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: Schema.String,
    criteria: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: Schema.String,
    /** Levels from lowest to highest; a level's position is its score. */
    criteria: Schema.Array(Schema.String),
  }),
]);
export type DecisionQuestion = typeof DecisionQuestion.Type;

export interface DecisionRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

const Probabilities = Schema.Record(Schema.String, Schema.Number);
export const DecisionAnswer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Schema.Number,
    probabilities: Probabilities,
  }),
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    confidence: Schema.Number,
    probabilities: Probabilities,
  }),
]);
export type DecisionAnswer = typeof DecisionAnswer.Type;

const DecisionResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, DecisionAnswer),
});
export type DecisionResponse = typeof DecisionResponse.Type;

const decodeDecisionResponse = Schema.decodeUnknownOption(DecisionResponse);

/** The response body, or null when it is not a decision response. */
export function parseDecisionResponse(body: unknown): DecisionResponse | null {
  return Option.getOrNull(decodeDecisionResponse(body));
}

const LANE_CRITERIA: Record<ModelLane, string> = {
  complex:
    "Hard, open-ended or creative work: architecture or system design, a new approach, hard debugging (race conditions, data loss, root cause), algorithms, security, strategy and trade-offs, or a long brief with many requirements. Needs the strongest model.",
  routine:
    "Clear, well-scoped work: a small fix or change, a rename, tests for existing code, docs, a summary, translation, a transcript, research with a known answer, or following an existing pattern. A fast, cheaper model does it well.",
};

const TASK_CLASS_CRITERIA: Record<TaskClass, string> = {
  translation: "Translate text between languages.",
  transcript: "Transcribe audio or clean up a transcript.",
  summary: "Summarize or condense existing material.",
  research: "Look things up and report findings, without building anything.",
  "animation-draft": "A rough or draft animation, storyboard or motion test.",
  "animation-final": "A final, polished animation or video.",
  code: "Write, change, fix or test software.",
  review: "Review code, a document or a design and give feedback.",
  design: "Visual, product or UX design work.",
  general: "Anything else, or a mix of the above.",
};

/** The task as the model reads it: title and brief, cut to the state limit. */
export function decisionTaskState(task: {
  readonly text: string;
  readonly title?: string | undefined;
}): string {
  const text = [task.title ?? "", task.text].filter((part) => part.trim().length > 0).join("\n\n");
  return text.length > DECISION_STATE_MAX_CHARS ? text.slice(0, DECISION_STATE_MAX_CHARS) : text;
}

/** One request that asks both the lane and the kind of work for a worker's task. */
export function routingDecisionRequest(task: {
  readonly text: string;
  readonly title?: string | undefined;
}): DecisionRequest {
  return {
    state: decisionTaskState(task),
    questions: {
      lane: {
        type: "choice",
        instructions:
          "This is a task for an AI coding agent. Which kind of model should do it: the strongest one, or a fast one?",
        criteria: LANE_CRITERIA,
      },
      taskClass: {
        type: "choice",
        instructions: "What kind of work is this task?",
        criteria: TASK_CLASS_CRITERIA,
      },
    },
  };
}

export interface SureChoice<T extends string> {
  readonly value: T;
  /** Probability of the chosen option, 0..1. */
  readonly probability: number;
}

/** The chosen option when it is one of `allowed` and sure enough to act on. */
export function sureChoice<T extends string>(
  answer: DecisionAnswer | undefined,
  allowed: ReadonlyArray<T>,
  minConfidence: number = DECISION_MIN_CONFIDENCE,
): SureChoice<T> | null {
  if (answer === undefined || answer.type !== "choice") return null;
  if (!(allowed as ReadonlyArray<string>).includes(answer.choice)) return null;
  const probability = answer.probabilities[answer.choice] ?? answer.confidence;
  if (!Number.isFinite(probability) || probability < minConfidence) return null;
  return { value: answer.choice as T, probability };
}

export interface RoutingDecision {
  readonly lane: SureChoice<ModelLane> | null;
  readonly taskClass: SureChoice<TaskClass> | null;
}

/** What the routing answers settle; each is null when the model was not sure. */
export function readRoutingDecision(response: DecisionResponse): RoutingDecision {
  return {
    lane: sureChoice(response.answers.lane, ["complex", "routine"] as const),
    taskClass: sureChoice(
      response.answers.taskClass,
      TASK_CLASSES.filter((taskClass) => taskClass !== "general"),
    ),
  };
}

/** "82%" for a routing reason. */
export function formatProbability(probability: number): string {
  return `${Math.round(Math.max(0, Math.min(1, probability)) * 100)}%`;
}
