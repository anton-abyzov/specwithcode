/**
 * Task-aware Auto model routing: the one place that decides which model a
 * worker runs on from the kind of work it was given. Pure and deterministic:
 * no model call is made to route a task.
 *
 * Auto only ever moves a task *down* from its baseline (the model the app
 * would pick without Auto) to a cheaper tier the task's class allows, and
 * only to a model the live catalog lists on a provider that can take the
 * turn now. A named model, the user's floor and exclusions, and the
 * paid-API cap always win. A failed run on the cheaper model continues once
 * on the baseline (see TaskRoutingEscalationWorker).
 *
 * @module taskRouting
 */
import {
  MODEL_TIERS,
  type ModelSelection,
  type ModelTier,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type TaskClass,
  type TaskRoutingBilling,
  type TaskRoutingChunkPlan,
  type TaskRoutingConfidence,
  type TaskRoutingDecision,
  type TaskRoutingSettings,
} from "@specweave-studio/contracts";

import * as DateTime from "effect/DateTime";

import {
  canTakeTurn,
  isGeminiSpendProvider,
  isPerTokenProvider,
  providerUsedPercent,
} from "./providerFallback.ts";

// ── Tiers ────────────────────────────────────────────────────────────

const TIER_RANK: Record<ModelTier, number> = { economy: 0, standard: 1, frontier: 2 };

export const tierRank = (tier: ModelTier): number => TIER_RANK[tier];

export const TIER_LABELS: Record<ModelTier, string> = {
  economy: "Economy",
  standard: "Standard",
  frontier: "Frontier",
};

/**
 * Model families with a known place, matched on slug or name. Anything else
 * (GPT-6 Sol/Astra/Luna, Grok, Copilot's `auto`) has no tier: Auto never
 * moves a task onto it, and a baseline without a tier is kept.
 */
const TIER_RULES: ReadonlyArray<readonly [RegExp, ModelTier]> = [
  [/haiku/, "economy"],
  [/flash[\s._-]*lite/, "economy"],
  [/(?:^|[\s._-])(?:mini|nano)(?:$|[\s._-])/, "economy"],
  [/sonnet/, "standard"],
  [/flash/, "standard"],
  [/opus/, "frontier"],
  [/fable/, "frontier"],
  [/gemini.*(?:^|[\s._-])pro(?:$|[\s._-])/, "frontier"],
];

/** The tier of a catalog model, or null when its family is not known. */
export function modelTier(
  model: Pick<ServerProviderModel, "slug"> & { name?: string },
): ModelTier | null {
  for (const spelling of [model.slug, model.name]) {
    if (spelling === undefined) continue;
    const key = spelling.toLowerCase();
    for (const [pattern, tier] of TIER_RULES) if (pattern.test(key)) return tier;
  }
  return null;
}

/** "5-5" > "5" > "4-6": the first two version numbers after the family name. */
function versionScore(slug: string): number {
  const numbers = slug.match(/\d+/g)?.filter((part) => part.length <= 3) ?? [];
  return Number(numbers[0] ?? 0) * 100 + Number(numbers[1] ?? 0);
}

// ── Classes ──────────────────────────────────────────────────────────

/** The tier each class may use under the `balanced` preference. */
export const DEFAULT_CLASS_TIERS: Record<TaskClass, ModelTier> = {
  translation: "standard",
  transcript: "standard",
  summary: "standard",
  research: "standard",
  "animation-draft": "standard",
  "animation-final": "frontier",
  code: "frontier",
  review: "frontier",
  design: "frontier",
  general: "frontier",
};

/** Final and high-risk work never goes below this tier, whatever the overrides. */
export const HIGH_RISK_FLOOR: Partial<Record<TaskClass, ModelTier>> = {
  "animation-final": "standard",
  code: "standard",
  review: "standard",
  design: "standard",
  general: "frontier",
};

/** Classes the `economy` preference lowers to economy models. */
const ROUTINE_CLASSES: ReadonlySet<TaskClass> = new Set([
  "translation",
  "transcript",
  "summary",
  "research",
]);

export const TASK_CLASS_LABELS: Record<TaskClass, string> = {
  translation: "Translation",
  transcript: "Transcript or speech",
  summary: "Summary",
  research: "Research",
  "animation-draft": "Animation first draft",
  "animation-final": "Animation final",
  code: "Code",
  review: "Review",
  design: "Design",
  general: "General",
};

/** The highest tier a class may use under the policy, before the floor. */
export function classTier(taskClass: TaskClass, policy: TaskRoutingSettings): ModelTier {
  if (policy.quality === "best") return "frontier";
  const override = policy.classTiers[taskClass];
  let tier: ModelTier =
    override ??
    (policy.quality === "economy" && ROUTINE_CLASSES.has(taskClass)
      ? "economy"
      : DEFAULT_CLASS_TIERS[taskClass]);
  const floor = HIGH_RISK_FLOOR[taskClass];
  if (floor !== undefined && tierRank(tier) < tierRank(floor)) tier = floor;
  return tier;
}

// ── Classification ───────────────────────────────────────────────────

const AUDIO_FILE = /\.(?:mp3|wav|m4a|aac|flac|ogg|oga|opus|weba|aiff?|amr)$/i;

const CLASS_SIGNALS: ReadonlyArray<readonly [TaskClass | "animation", RegExp, string]> = [
  ["translation", /\btranslat(?:e|es|ed|ion|ions|ing)\b/i, "translate"],
  ["translation", /\blocali[sz](?:e|ation)\b|\bi18n\b/i, "localize"],
  ["transcript", /\btranscri(?:pt|pts|be|bed|bing|ption)\b/i, "transcript"],
  [
    "transcript",
    /\b(?:speech|recording|podcast|lecture|interview|voice\s?memo|audio|subtitles?|captions?)\b/i,
    "speech or audio",
  ],
  ["summary", /\bsummar(?:y|ies|i[sz]e|i[sz]ing)\b|\btl;?dr\b|\bmeeting notes\b/i, "summarize"],
  [
    "research",
    /\b(?:research|look\s?up|find out|investigate|survey|compare (?:options|tools|libraries))\b/i,
    "research",
  ],
  [
    "animation",
    /\b(?:animat(?:e|ion|ions|ed)|motion graphics?|storyboard|explainer video|promo video|video draft|hyperframes|remotion|lottie)\b/i,
    "animation",
  ],
  [
    "code",
    /\b(?:implement|refactor|bug|fix(?:es|ed)?|endpoint|function|unit tests?|typescript|compile|pull request|codebase|regression)\b/i,
    "code",
  ],
  ["review", /\b(?:review|audit|critique|qa|verify|verification|second opinion)\b/i, "review"],
  [
    "design",
    /\b(?:design|ux|ui|wireframe|figma|mockup|architecture|information architecture)\b/i,
    "design",
  ],
];

const DRAFT_MARKERS =
  /\b(?:first draft|draft|rough cut|rough|prototype|storyboard|preview|sketch|v0|mock(?:-|\s)?up)\b/i;
const FINAL_MARKERS =
  /\b(?:final|publish(?:ed|able)?|production|ship(?:pable)?|deliverable|polish(?:ed)?)\b/i;
/** "release notes" is routine writing, not a release. */
const RISK_MARKERS =
  /\b(?:final|production|prod|release(?! notes)|publish|deploy|merge|security|auth(?:entication)?|payment|billing|migration|legal|contract|medical|compliance)\b/i;

const CHEAP_PRIORITY: ReadonlyArray<TaskClass> = [
  "transcript",
  "translation",
  "animation-draft",
  "summary",
  "research",
];
const HIGH_RISK_CLASSES: ReadonlyArray<TaskClass> = ["review", "code", "design", "animation-final"];

export interface TaskClassification {
  readonly taskClass: TaskClass;
  readonly confidence: TaskRoutingConfidence;
  readonly signals: ReadonlyArray<string>;
  /** Audio has to become text (speech-to-text) before any text model reads it. */
  readonly needsTranscription: boolean;
  /** Spoken length named in the task or found in attachments, when known. */
  readonly audioMinutes: number | null;
  /** Characters of text input known up front (a transcript attachment), when known. */
  readonly textChars: number | null;
}

export interface TaskClassificationInput {
  readonly text: string;
  readonly title?: string | undefined;
  readonly hint?: TaskClass | undefined;
  readonly attachments?: ReadonlyArray<{
    readonly name: string;
    readonly mimeType?: string | undefined;
    readonly sizeBytes?: number | undefined;
  }>;
}

function spokenMinutes(text: string): number | null {
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:-|\s)?(?:hours?|hrs?|h)\b/i);
  if (hours) return Math.round(Number(hours[1]) * 60);
  if (/\b(?:an|one)\s+hour\b|\bhour[\s-]long\b/i.test(text)) return 60;
  const minutes = text.match(/(\d+)\s*(?:-|\s)?(?:minutes?|mins?)\b/i);
  return minutes ? Number(minutes[1]) : null;
}

/**
 * The kind of work a task is, from its words and attachments alone. A
 * caller's hint wins. Signals of cheap work next to signals of code, review
 * or design, or a risk marker (final, production, security, legal...) next
 * to cheap work, make the result uncertain: an uncertain task keeps its
 * baseline model.
 */
export function classifyTask(input: TaskClassificationInput): TaskClassification {
  const text = [input.title ?? "", input.text].join("\n");
  const attachments = input.attachments ?? [];
  const audioAttachments = attachments.filter(
    (attachment) =>
      AUDIO_FILE.test(attachment.name) || attachment.mimeType?.startsWith("audio/") === true,
  );
  const textChars =
    attachments
      .filter((attachment) => /\.(?:txt|srt|vtt|md)$/i.test(attachment.name))
      .reduce((sum, attachment) => sum + (attachment.sizeBytes ?? 0), 0) || null;
  const scores = new Map<TaskClass, number>();
  const signals: string[] = [];
  const add = (taskClass: TaskClass, signal: string) => {
    scores.set(taskClass, (scores.get(taskClass) ?? 0) + 1);
    if (!signals.includes(signal)) signals.push(signal);
  };
  for (const [kind, pattern, signal] of CLASS_SIGNALS) {
    if (!pattern.test(text)) continue;
    if (kind === "animation") {
      add(
        DRAFT_MARKERS.test(text) && !FINAL_MARKERS.test(text)
          ? "animation-draft"
          : "animation-final",
        DRAFT_MARKERS.test(text) && !FINAL_MARKERS.test(text)
          ? "animation draft"
          : "animation final",
      );
    } else add(kind, signal);
  }
  if (audioAttachments.length > 0) add("transcript", "audio attachment");
  const audioMinutes = spokenMinutes(text);
  const needsTranscription =
    audioAttachments.length > 0 ||
    /\btranscrib/i.test(text) ||
    ((scores.get("transcript") ?? 0) > 0 && !/\btranscripts?\b/i.test(text));
  const base = { signals: signals.slice(0, 12), needsTranscription, audioMinutes, textChars };

  if (input.hint !== undefined)
    return {
      ...base,
      taskClass: input.hint,
      confidence: "hint",
      signals: [`hint: ${input.hint}`, ...base.signals].slice(0, 12),
    };

  const risky = HIGH_RISK_CLASSES.filter((taskClass) => (scores.get(taskClass) ?? 0) > 0);
  const cheap = CHEAP_PRIORITY.filter((taskClass) => (scores.get(taskClass) ?? 0) > 0);
  if (cheap.length === 0 && risky.length === 0)
    return { ...base, taskClass: "general", confidence: "uncertain" };
  if (cheap.length === 0) {
    const top = [...risky].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))[0]!;
    return { ...base, taskClass: top, confidence: risky.length === 1 ? "high" : "uncertain" };
  }
  const riskMarker = text.match(RISK_MARKERS)?.[0];
  if (risky.length > 0 || riskMarker !== undefined) {
    const taskClass = risky[0] ?? cheap[0]!;
    return {
      ...base,
      taskClass,
      confidence: "uncertain",
      signals: [
        ...base.signals,
        ...(riskMarker ? [`risk: ${riskMarker.toLowerCase()}`] : []),
      ].slice(0, 12),
    };
  }
  return { ...base, taskClass: cheap[0]!, confidence: "high" };
}

// ── Context and chunking ─────────────────────────────────────────────

/** Spoken English runs about 150 words a minute; a word is about 1.33 tokens. */
const TOKENS_PER_SPOKEN_MINUTE = 200;
const CHARS_PER_TOKEN = 4;
/** Half the window per chunk leaves room for instructions and the answer. */
const CHUNK_SHARE = 0.5;
/** Assumed when a model does not say: smaller than any current model's window. */
export const UNKNOWN_CONTEXT_TOKENS = 100_000;

function parseTokenCount(value: string): number | null {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) return null;
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

/** The context window a model starts with: its default `contextWindow` option, if it has one. */
export function contextWindowTokens(model: ServerProviderModel | undefined): number | null {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "contextWindow",
  );
  if (descriptor === undefined || descriptor.type !== "select") return null;
  const choice = descriptor.options.find((option) => option.isDefault) ?? descriptor.options[0];
  return choice === undefined
    ? null
    : (parseTokenCount(choice.id) ?? parseTokenCount(choice.label));
}

/**
 * How a transcript is split for a model: by spoken minutes or by text size,
 * each chunk at most half the window. Null when the size is unknown.
 */
export function planTranscriptChunks(
  size: { readonly minutes?: number | null; readonly chars?: number | null },
  contextTokens: number | null,
): TaskRoutingChunkPlan | null {
  const estimatedTokens =
    size.chars != null && size.chars > 0
      ? Math.ceil(size.chars / CHARS_PER_TOKEN)
      : size.minutes != null && size.minutes > 0
        ? size.minutes * TOKENS_PER_SPOKEN_MINUTE
        : null;
  if (estimatedTokens === null) return null;
  const maxTokensPerChunk = Math.floor((contextTokens ?? UNKNOWN_CONTEXT_TOKENS) * CHUNK_SHARE);
  return {
    estimatedTokens,
    maxTokensPerChunk,
    chunks: Math.max(1, Math.ceil(estimatedTokens / maxTokensPerChunk)),
  };
}

// ── Routing ──────────────────────────────────────────────────────────

export interface ResolveTaskRoutingInput {
  readonly policy: TaskRoutingSettings;
  readonly classification: TaskClassification;
  /** The model the app would use without Auto. */
  readonly baseline: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  /** Usage at which a subscription counts as out of room (`providerLimitSwitchAtPercent`). */
  readonly switchAtPercent?: number | null | undefined;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  /** Provider instances to prefer, in order (`defaultModelProviders`). */
  readonly preferredProviders?: ReadonlyArray<ProviderInstanceId> | undefined;
  /** Instances that can run a worker here; absent means every listed one. */
  readonly runnableInstanceIds?: ReadonlySet<string> | undefined;
}

const PAID_API_TIER: Record<TaskRoutingSettings["paidApi"], ModelTier | null> = {
  never: null,
  economy: "economy",
  standard: "standard",
};

export function providerLabel(
  provider: Pick<ServerProvider, "displayName" | "instanceId"> | undefined,
  fallback?: string,
): string {
  return provider?.displayName ?? provider?.instanceId ?? fallback ?? "unknown provider";
}

function findModel(
  provider: ServerProvider | undefined,
  slug: string,
): ServerProviderModel | undefined {
  return provider?.models.find((model) => model.slug === slug || model.aliases?.includes(slug));
}

/** Sign-ins billed per token whatever the driver calls them (Gemini and Cursor keys, Vertex). */
const PER_TOKEN_AUTH = /api[-_ ]?key|bedrock|vertex|agent-platform|env[-_]?var/i;
/** Sign-ins that run on a plan's usage rather than per token. */
const SUBSCRIPTION_AUTH = new Set([
  "subscription",
  "subscription-auth-unverified",
  "chatgpt",
  "cached_token",
  "browser",
  "oauth",
]);

function isCopilotProvider(provider: ServerProvider): boolean {
  return /copilot/i.test(provider.instanceId) || /copilot/i.test(provider.displayName ?? "");
}

/** Drivers whose auth type names the plan (max, pro, team); their API-key sign-ins are caught above. */
const PLAN_NAMED_DRIVERS = new Set(["claudeAgent", "codex"]);

/**
 * How a provider's turns are paid for. A sign-in this does not recognise is
 * unknown, and Auto treats unknown like per-token: it never assumes a turn
 * is free of charge.
 */
export function billingOf(provider: ServerProvider | undefined): TaskRoutingBilling {
  if (provider === undefined) return "unknown";
  const type = provider.auth.type;
  if (isPerTokenProvider(provider) || (type !== undefined && PER_TOKEN_AUTH.test(type)))
    return "api";
  if (type !== undefined && SUBSCRIPTION_AUTH.has(type)) return "subscription";
  if (PLAN_NAMED_DRIVERS.has(provider.driver) && type !== "status-check-failed")
    return "subscription";
  // Without a sign-in type only a Copilot seat is known to be a subscription;
  // a harness such as OpenCode may hold anyone's API key.
  if (type === undefined && isCopilotProvider(provider)) return "subscription";
  return "unknown";
}

interface Candidate {
  readonly provider: ServerProvider;
  readonly model: ServerProviderModel;
  readonly rank: number;
}

function routingPipeline(
  classification: TaskClassification,
  modelName: string,
  chunking: TaskRoutingChunkPlan | null,
): ReadonlyArray<string> | undefined {
  if (classification.taskClass !== "transcript") return undefined;
  const chunk =
    chunking === null
      ? "Split the transcript into chunks of at most half the model's context window."
      : `Split the transcript into ${chunking.chunks} chunk${chunking.chunks === 1 ? "" : "s"} of at most ${chunking.maxTokensPerChunk.toLocaleString("en-US")} tokens.`;
  return [
    ...(classification.needsTranscription
      ? [
          "Transcribe the audio with a speech-to-text (ASR) tool first; the text model never reads audio.",
        ]
      : []),
    chunk,
    `Process each chunk on ${modelName}, then merge the results.`,
  ];
}

/**
 * Which model a task runs on under Auto. Never above the baseline, never
 * below the floor, never an excluded provider, never one that cannot take a
 * turn now or is out of room, never a per-token provider beyond the paid-API
 * cap, never a model without a known tier. With nothing eligible the
 * baseline stays and the reason says why.
 */
export function resolveTaskRouting(input: ResolveTaskRoutingInput): TaskRoutingDecision {
  const { policy, classification, baseline } = input;
  const decidedAt = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs));
  const baselineProvider = input.providers.find(
    (provider) => provider.instanceId === baseline.instanceId,
  );
  const baselineModel = findModel(baselineProvider, baseline.model);
  const baselineName = baselineModel?.name ?? baseline.model;
  const baselineTier = baselineModel
    ? modelTier(baselineModel)
    : modelTier({ slug: baseline.model });
  const classLabel = TASK_CLASS_LABELS[classification.taskClass];
  const keep = (reason: string, tier: ModelTier | null = baselineTier): TaskRoutingDecision => {
    const chunking =
      classification.taskClass === "transcript"
        ? planTranscriptChunks(
            { minutes: classification.audioMinutes, chars: classification.textChars },
            contextWindowTokens(baselineModel),
          )
        : null;
    const pipeline = routingPipeline(classification, baselineName, chunking);
    return {
      taskClass: classification.taskClass,
      confidence: classification.confidence,
      moved: false,
      tier,
      selection: baseline,
      baseline,
      escalation: null,
      billing: billingOf(baselineProvider),
      reason,
      signals: [...classification.signals],
      ...(pipeline === undefined ? {} : { pipeline: [...pipeline] }),
      ...(chunking === null ? {} : { chunking }),
      decidedAt,
    };
  };

  if (classification.confidence === "uncertain")
    return keep(
      classification.taskClass === "general"
        ? `No clear kind of work: kept ${baselineName}.`
        : `${classLabel} with mixed or high-risk signals: kept ${baselineName}.`,
    );
  const allowed = classTier(classification.taskClass, policy);
  const floor = policy.minimumTier;
  const wanted: ModelTier = floor !== null && tierRank(floor) > tierRank(allowed) ? floor : allowed;
  if (baselineTier === null) return keep(`${baselineName} has no known tier, so Auto keeps it.`);
  if (tierRank(wanted) >= tierRank(baselineTier))
    return keep(
      floor !== null && wanted === floor && tierRank(floor) > tierRank(allowed)
        ? `Minimum tier ${TIER_LABELS[floor]}: kept ${baselineName}.`
        : `${classLabel} needs ${TIER_LABELS[wanted]}: kept ${baselineName}.`,
    );

  const excluded = new Set<string>(policy.excludedProviders);
  const limited = input.limitedInstanceIds ?? new Set<string>();
  const threshold = input.switchAtPercent ?? 100;
  const paidCap = PAID_API_TIER[policy.paidApi];
  const preferred = input.preferredProviders ?? [];
  const skipped: string[] = [];
  const providerRank = (provider: ServerProvider): number => {
    if (provider.instanceId === baseline.instanceId) return 0;
    const order = preferred.indexOf(provider.instanceId);
    if (order >= 0) return 2 + order;
    if (provider.driver === baselineProvider?.driver) return 1;
    return 100;
  };
  const candidates = (tier: ModelTier): Candidate[] => {
    const found: Candidate[] = [];
    for (const provider of input.providers) {
      const label = providerLabel(provider);
      const models = provider.models.filter(
        (model) => model.isLegacy !== true && modelTier(model) === tier,
      );
      if (models.length === 0) continue;
      if (excluded.has(provider.instanceId)) {
        skipped.push(`${label}: excluded`);
        continue;
      }
      if (input.runnableInstanceIds && !input.runnableInstanceIds.has(provider.instanceId)) {
        skipped.push(`${label}: cannot run workers here`);
        continue;
      }
      if (!canTakeTurn(provider)) {
        skipped.push(`${label}: not ready`);
        continue;
      }
      if (isGeminiSpendProvider(provider)) {
        skipped.push(`${label}: Gemini spend is off`);
        continue;
      }
      const billing = billingOf(provider);
      const perToken = billing !== "subscription";
      if (perToken && (paidCap === null || tierRank(tier) > tierRank(paidCap))) {
        skipped.push(`${label}: ${billing === "api" ? "billed per token" : "billing unknown"}`);
        continue;
      }
      for (const model of models) {
        if (limited.has(provider.instanceId)) {
          skipped.push(`${label}: at its usage limit`);
          break;
        }
        const used = providerUsedPercent(provider, input.nowMs, model.slug);
        if (used !== null && used >= threshold) {
          skipped.push(`${label}: at ${Math.round(used)}% usage`);
          break;
        }
        found.push({ provider, model, rank: providerRank(provider) + (perToken ? 50 : 0) });
      }
    }
    return found.sort(
      (a, b) =>
        a.rank - b.rank ||
        versionScore(b.model.slug) - versionScore(a.model.slug) ||
        Number(b.model.isDefault === true) - Number(a.model.isDefault === true),
    );
  };

  for (let rank = tierRank(wanted); rank < tierRank(baselineTier); rank += 1) {
    const tier = MODEL_TIERS[rank]!;
    const best = candidates(tier)[0];
    if (best === undefined) continue;
    const selection: ModelSelection = {
      instanceId: best.provider.instanceId,
      model: best.model.slug,
    };
    const chunking =
      classification.taskClass === "transcript"
        ? planTranscriptChunks(
            { minutes: classification.audioMinutes, chars: classification.textChars },
            contextWindowTokens(best.model),
          )
        : null;
    const pipeline = routingPipeline(classification, best.model.name, chunking);
    const where =
      best.provider.instanceId === baseline.instanceId ? "" : ` on ${providerLabel(best.provider)}`;
    return {
      taskClass: classification.taskClass,
      confidence: classification.confidence,
      moved: true,
      tier,
      selection,
      baseline,
      escalation: policy.escalate ? baseline : null,
      billing: billingOf(best.provider),
      reason: `${classLabel} fits ${TIER_LABELS[tier]}: ${best.model.name}${where} instead of ${baselineName}.`,
      signals: [...classification.signals],
      ...(pipeline === undefined ? {} : { pipeline: [...pipeline] }),
      ...(chunking === null ? {} : { chunking }),
      decidedAt,
    };
  }
  const why = [...new Set(skipped)].slice(0, 3).join("; ");
  return keep(
    `No ${TIER_LABELS[wanted]} model is eligible${why ? ` (${why})` : ""}: kept ${baselineName}.`,
  );
}

/**
 * The note a routed worker's prompt carries when its input needs steps
 * outside the model, so the agent does not try to read audio as text.
 */
export function routingPromptNote(decision: TaskRoutingDecision): string | null {
  if (decision.pipeline === undefined || decision.pipeline.length === 0) return null;
  return [
    "Processing plan (SpecWithCode Auto routing):",
    ...decision.pipeline.map((step, index) => `${index + 1}. ${step}`),
    ...(decision.pipeline[0]?.startsWith("Transcribe")
      ? [
          "If no speech-to-text tool is available on this machine, stop and report that as a blocker instead of guessing the audio's content.",
        ]
      : []),
  ].join("\n");
}

// ── Conflicts ────────────────────────────────────────────────────────

export interface TaskRoutingConflictInput {
  readonly policy: TaskRoutingSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The project's saved worker model, when one is set. */
  readonly projectWorkerModel?: ModelSelection | null | undefined;
}

/**
 * What a person should know about the policy before Auto acts on it: a
 * floor that overrides class tiers, a project worker model Auto may leave,
 * tiers with every provider excluded or unavailable.
 */
export function taskRoutingConflicts(input: TaskRoutingConflictInput): ReadonlyArray<string> {
  const { policy } = input;
  if (policy.mode !== "auto") return [];
  const notes: string[] = [];
  const floor = policy.minimumTier;
  if (floor !== null) {
    const below = (Object.keys(DEFAULT_CLASS_TIERS) as TaskClass[]).filter(
      (taskClass) => tierRank(classTier(taskClass, policy)) < tierRank(floor),
    );
    if (below.length > 0)
      notes.push(
        `Minimum tier ${TIER_LABELS[floor]} overrides ${below.map((taskClass) => TASK_CLASS_LABELS[taskClass]).join(", ")}.`,
      );
  }
  if (input.projectWorkerModel) {
    const provider = input.providers.find(
      (entry) => entry.instanceId === input.projectWorkerModel?.instanceId,
    );
    const name =
      findModel(provider, input.projectWorkerModel.model)?.name ?? input.projectWorkerModel.model;
    notes.push(
      `This project's workers start on ${name}. Auto may move routine work below it; threads that must stay on it should name it, or turn Auto off for this project.`,
    );
  }
  for (const tier of ["economy", "standard"] as const) {
    const used = (Object.keys(DEFAULT_CLASS_TIERS) as TaskClass[]).some(
      (taskClass) =>
        classTier(taskClass, policy) === tier &&
        (floor === null || tierRank(floor) <= tierRank(tier)),
    );
    if (!used) continue;
    const ready = input.providers.some(
      (provider) =>
        !policy.excludedProviders.includes(provider.instanceId) &&
        canTakeTurn(provider) &&
        provider.models.some((model) => model.isLegacy !== true && modelTier(model) === tier),
    );
    if (!ready)
      notes.push(
        `No ready, non-excluded provider offers a ${TIER_LABELS[tier]} model; those tasks keep their baseline.`,
      );
  }
  return notes;
}
