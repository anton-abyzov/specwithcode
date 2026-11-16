/**
 * The advisor: a stronger model a running thread can consult and keep working.
 * Settings shapes, the per-thread choice and the `advisor` tool's input and
 * result. Which model advises and by which route is
 * `@specweave-studio/shared/advisor`.
 *
 * @module advisor
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NodeId, NonNegativeInt } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const MIN_ADVISOR_BUILT_IN_CONTEXT_LIMIT = 50_000;
export const MAX_ADVISOR_BUILT_IN_CONTEXT_LIMIT = 1_000_000;
export const DEFAULT_ADVISOR_BUILT_IN_CONTEXT_LIMIT = 200_000;
export const MIN_ADVISOR_CONSULTS_PER_RUN = 1;
export const MAX_ADVISOR_CONSULTS_PER_RUN = 10;
export const DEFAULT_ADVISOR_CONSULTS_PER_RUN = 3;
export const MIN_ADVISOR_BRIEF_TOKEN_BUDGET = 4_000;
export const MAX_ADVISOR_BRIEF_TOKEN_BUDGET = 64_000;
export const DEFAULT_ADVISOR_BRIEF_TOKEN_BUDGET = 24_000;
/** The longest `focus` a consult may carry, in characters. */
export const MAX_ADVISOR_FOCUS_LENGTH = 2_000;

export const AdvisorBuiltInContextLimit = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_ADVISOR_BUILT_IN_CONTEXT_LIMIT,
    maximum: MAX_ADVISOR_BUILT_IN_CONTEXT_LIMIT,
  }),
);
export const AdvisorConsultsPerRun = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_ADVISOR_CONSULTS_PER_RUN,
    maximum: MAX_ADVISOR_CONSULTS_PER_RUN,
  }),
);
export const AdvisorBriefTokenBudget = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_ADVISOR_BRIEF_TOKEN_BUDGET,
    maximum: MAX_ADVISOR_BRIEF_TOKEN_BUDGET,
  }),
);

/**
 * The advisor policy. Off by default: a consult spends the strongest model's
 * tokens. `model` null means the built-in order (Claude Fable 5.2, then the
 * Review track).
 */
export const AdvisorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  model: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Claude threads use Claude's own advisor when the pair allows it. */
  claudeBuiltIn: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Above this many context tokens a Claude thread uses the budgeted brief instead. */
  builtInContextLimit: AdvisorBuiltInContextLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ADVISOR_BUILT_IN_CONTEXT_LIMIT)),
  ),
  maxConsultsPerRun: AdvisorConsultsPerRun.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ADVISOR_CONSULTS_PER_RUN)),
  ),
  /** The largest brief the advisor is sent; one UTF-8 byte counts as one token. */
  briefTokenBudget: AdvisorBriefTokenBudget.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ADVISOR_BRIEF_TOKEN_BUDGET)),
  ),
});
export type AdvisorSettings = typeof AdvisorSettings.Type;

/**
 * A change to some fields of the advisor policy. Fields left out keep their
 * value on every target, so a project overrides only what it changed.
 */
export const AdvisorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  claudeBuiltIn: Schema.optionalKey(Schema.Boolean),
  builtInContextLimit: Schema.optionalKey(AdvisorBuiltInContextLimit),
  maxConsultsPerRun: Schema.optionalKey(AdvisorConsultsPerRun),
  briefTokenBudget: Schema.optionalKey(AdvisorBriefTokenBudget),
});
export type AdvisorSettingsPatch = typeof AdvisorSettingsPatch.Type;

export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = {
  enabled: false,
  model: null,
  claudeBuiltIn: true,
  builtInContextLimit: DEFAULT_ADVISOR_BUILT_IN_CONTEXT_LIMIT,
  maxConsultsPerRun: DEFAULT_ADVISOR_CONSULTS_PER_RUN,
  briefTokenBudget: DEFAULT_ADVISOR_BRIEF_TOKEN_BUDGET,
};

/**
 * A thread's own advisor choice. Absent or null follows the project (which
 * follows the machine).
 */
export const ThreadAdvisorMode = Schema.Literals(["on", "off"]);
export type ThreadAdvisorMode = typeof ThreadAdvisorMode.Type;

/** Marks a delegated child that exists only to advise its parent. */
export const AdvisorTaskPurpose = Schema.Literal("advisor");
export type AdvisorTaskPurpose = typeof AdvisorTaskPurpose.Type;

// ── The `advisor` tool ───────────────────────────────────────────────

export const AdvisorConsultInput = Schema.Struct({
  focus: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_ADVISOR_FOCUS_LENGTH)).annotate({
      description:
        "Optional. The one question or decision you most want reviewed, up to 2,000 characters. Leave it out to get a review of your whole approach.",
    }),
  ),
});
export type AdvisorConsultInput = typeof AdvisorConsultInput.Type;

/** Why a consult was refused; nothing was started. */
export const AdvisorRefusalReason = Schema.Literals([
  /** The advisor is off for this thread. */
  "off",
  /** The caller is itself an advisor. */
  "advisor-thread",
  /** This run used all its consults. */
  "limit",
  /** No model in the advisor order can run now. */
  "no-advisor",
  /** The call did not come from a thread's running turn. */
  "no-run",
]);
export type AdvisorRefusalReason = typeof AdvisorRefusalReason.Type;

export const AdvisorConsultResult = Schema.Struct({
  status: Schema.Literals(["advice", "working", "refused", "failed"]).annotate({
    description:
      "advice: the advisor answered, read `advice`. working: the advisor is still thinking; finish what does not depend on it and end your turn, the advice arrives as the next message, or call advisor again to pick it up. refused: nothing was started, `message` says why. failed: the advisor started but gave no advice; carry on without it.",
  }),
  message: Schema.String.annotate({
    description: "One sentence on what happened, safe to repeat to the user.",
  }),
  advice: Schema.optional(
    Schema.String.annotate({
      description:
        "The advisor's review. Weigh it seriously; where it conflicts with evidence you hold, say so and reconcile instead of switching silently.",
    }),
  ),
  advisor: Schema.optional(
    Schema.String.annotate({ description: "The advising model and the provider serving it." }),
  ),
  advisorModel: Schema.optional(ModelSelection),
  consultsRemaining: Schema.optional(
    NonNegativeInt.annotate({ description: "Consults left in this run." }),
  ),
  refusal: Schema.optional(AdvisorRefusalReason),
  /** The advisor's task, for a `working` consult. */
  taskId: Schema.optional(NodeId),
  briefTokens: Schema.optional(
    NonNegativeInt.annotate({ description: "Size of the brief the advisor was sent." }),
  ),
  leftOut: Schema.optional(
    NonNegativeInt.annotate({
      description: "Older activity items left out of the brief to fit its budget.",
    }),
  ),
});
export type AdvisorConsultResult = typeof AdvisorConsultResult.Type;
