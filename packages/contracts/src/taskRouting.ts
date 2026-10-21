/**
 * Task-aware Auto model routing: the policy a person sets and the decision
 * the router records. The router itself is `@specweave-studio/shared/taskRouting`;
 * these are the wire and settings shapes only.
 *
 * @module taskRouting
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * What kind of work a task is. `general` is the class of anything the
 * classifier cannot place, and never moves a task off its baseline model.
 */
export const TASK_CLASSES = [
  "translation",
  "transcript",
  "summary",
  "research",
  "animation-draft",
  "animation-final",
  "code",
  "review",
  "design",
  "general",
] as const;
export const TaskClass = Schema.Literals(TASK_CLASSES);
export type TaskClass = typeof TaskClass.Type;

/** Model capability tiers, cheapest first. */
export const MODEL_TIERS = ["economy", "standard", "frontier"] as const;
export const ModelTier = Schema.Literals(MODEL_TIERS);
export type ModelTier = typeof ModelTier.Type;

/**
 * How far Auto may go: `best` never moves a task off its baseline model,
 * `balanced` uses each class's tier, `economy` lets the routine classes
 * (translation, transcript, summary, research) use economy models.
 */
export const TaskRoutingQuality = Schema.Literals(["economy", "balanced", "best"]);
export type TaskRoutingQuality = typeof TaskRoutingQuality.Type;

/**
 * The most Auto may pick on a provider billed per token (API credits):
 * `never` keeps Auto on subscriptions; `economy`/`standard` allow paid
 * models up to that tier. Auto never signs in, enables a provider or turns
 * on credits: only providers already signed in that way count.
 */
export const TaskRoutingPaidApi = Schema.Literals(["never", "economy", "standard"]);
export type TaskRoutingPaidApi = typeof TaskRoutingPaidApi.Type;

/** Per-class tier overrides; an absent class uses the built-in default. */
export const TaskRoutingClassTiers = Schema.Struct({
  translation: Schema.optionalKey(ModelTier),
  transcript: Schema.optionalKey(ModelTier),
  summary: Schema.optionalKey(ModelTier),
  research: Schema.optionalKey(ModelTier),
  "animation-draft": Schema.optionalKey(ModelTier),
  "animation-final": Schema.optionalKey(ModelTier),
  code: Schema.optionalKey(ModelTier),
  review: Schema.optionalKey(ModelTier),
  design: Schema.optionalKey(ModelTier),
  general: Schema.optionalKey(ModelTier),
} satisfies Record<TaskClass, unknown>);
export type TaskRoutingClassTiers = typeof TaskRoutingClassTiers.Type;

export const TaskRoutingSettings = Schema.Struct({
  /** Auto is opt-in: `off` keeps every worker on the model chosen today. */
  mode: Schema.Literals(["off", "auto"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  quality: TaskRoutingQuality.pipe(Schema.withDecodingDefault(Effect.succeed("balanced" as const))),
  classTiers: TaskRoutingClassTiers.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Auto never picks below this tier; null sets no floor. */
  minimumTier: Schema.NullOr(ModelTier).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Provider instances Auto never picks (a pinned model still may). */
  excludedProviders: Schema.Array(ProviderInstanceId)
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  paidApi: TaskRoutingPaidApi.pipe(Schema.withDecodingDefault(Effect.succeed("never" as const))),
  /** A failed run on a cheaper model continues once on the baseline model. */
  escalate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type TaskRoutingSettings = typeof TaskRoutingSettings.Type;

export const DEFAULT_TASK_ROUTING_SETTINGS: TaskRoutingSettings = {
  mode: "off",
  quality: "balanced",
  classTiers: {},
  minimumTier: null,
  excludedProviders: [],
  paidApi: "never",
  escalate: true,
};

/** How sure the router is of the class: a caller's hint, a clear match, or not sure. */
export const TaskRoutingConfidence = Schema.Literals(["hint", "high", "uncertain"]);
export type TaskRoutingConfidence = typeof TaskRoutingConfidence.Type;

export const TaskRoutingBilling = Schema.Literals(["subscription", "api", "unknown"]);
export type TaskRoutingBilling = typeof TaskRoutingBilling.Type;

const RoutingText = TrimmedNonEmptyString.check(Schema.isMaxLength(600));

/** How a long transcript is split for the routed model's context window. */
export const TaskRoutingChunkPlan = Schema.Struct({
  estimatedTokens: Schema.Int,
  maxTokensPerChunk: Schema.Int,
  chunks: Schema.Int,
});
export type TaskRoutingChunkPlan = typeof TaskRoutingChunkPlan.Type;

/**
 * What Auto decided for one task. `moved` says whether it left the baseline
 * (the model the app would have used without Auto); `escalation` is the one
 * stronger model a failed run continues on, or null.
 */
export const TaskRoutingDecision = Schema.Struct({
  taskClass: TaskClass,
  confidence: TaskRoutingConfidence,
  moved: Schema.Boolean,
  tier: Schema.NullOr(ModelTier),
  selection: ModelSelection,
  baseline: ModelSelection,
  escalation: Schema.NullOr(ModelSelection),
  billing: TaskRoutingBilling,
  reason: RoutingText,
  signals: Schema.Array(RoutingText).check(Schema.isMaxLength(12)),
  /** Ordered steps when the input needs more than one model call, e.g. ASR before text. */
  pipeline: Schema.optionalKey(Schema.Array(RoutingText).check(Schema.isMaxLength(6))),
  chunking: Schema.optionalKey(TaskRoutingChunkPlan),
  decidedAt: IsoDateTime,
});
export type TaskRoutingDecision = typeof TaskRoutingDecision.Type;
