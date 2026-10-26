/**
 * Model lanes: the user's two ordered model lists, one for complex or
 * creative work and one for routine work, and what each project learned
 * from its user about which model suits which task.
 *
 * A worker whose model nobody named starts on the first entry of its lane
 * that can run now. The lane comes from the caller's judgement (the
 * coordinator passes `taskLane`), else a learned preference, else the rules
 * below. Pure and deterministic: no model call is made to route a task.
 *
 * Lane entries are the user's explicit choices, so an instance billed per
 * token may be picked from a lane (the decision records `billing: "api"`).
 * A learned "prefer" rule is not: the coordinator can record one, so it moves
 * a worker onto a paid or unknown-billing model only within Auto's paid-API
 * setting, or when the model is in one of the user's lanes too.
 * Gemini and Vertex spend is never picked automatically, as everywhere else.
 *
 * @module modelLanes
 */
import {
  type LearnedModelPreference,
  type ModelLane,
  type ModelLanes,
  type ModelSelection,
  type ModelTier,
  type ServerProvider,
  MAX_LEARNED_MODEL_PREFERENCES,
  taskRoutingBilling,
  type TaskRoutingDecision,
  type TaskRoutingSettings,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { canTakeTurn, isGeminiSpendProvider, providerUsedPercent } from "./providerFallback.ts";
import {
  billingOf,
  modelTier,
  providerLabel,
  tierRank,
  TIER_LABELS,
  type TaskClassification,
} from "./taskRouting.ts";

export const LANE_LABELS: Record<ModelLane, string> = {
  complex: "Complex and creative",
  routine: "Routine",
};

// ── Lane classification ──────────────────────────────────────────────

const COMPLEX_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:architect(?:ure|ural)?|system design|data model|design (?:a|an|the) (?:new )?(?:system|api|schema|protocol|architecture))\b/i,
    "architecture",
  ],
  [
    /\b(?:from scratch|greenfield|novel|invent|rethink|redesign|re-?architect|new approach)\b/i,
    "new design",
  ],
  [
    /\b(?:creative|creativity|brainstorm(?:ing)?|ideas|concepts?|storytelling|narrative|naming|branding|copywriting|campaign)\b/i,
    "creative",
  ],
  [
    /\b(?:root cause|deep(?:ly)? (?:dive|debug(?:ging)?|investigation)|race conditions?|deadlocks?|memory leaks?|heisenbugs?|intermittent|corrupt(?:ion|ed)?|data loss)\b/i,
    "hard debugging",
  ],
  [
    /\b(?:strategy|strategic|trade-?offs?|evaluate (?:options|approaches)|compare approaches|decide between|how to organi[sz]e|best way to|figure out how)\b/i,
    "open design",
  ],
  [
    /\b(?:algorithms?|optimi[sz]ation|proofs?|formal(?:ly)?|concurren(?:t|cy)|distributed|consensus|cryptograph(?:y|ic))\b/i,
    "algorithms",
  ],
  [/\b(?:security audit|threat model(?:ing)?|vulnerabilit(?:y|ies))\b/i, "security"],
  [
    /\b(?:complex|complicated|tricky|hard problem|difficult|ambiguous|open-ended|ultrathink|think hard)\b/i,
    "named as complex",
  ],
  [
    /\b(?:specification|rfc|design doc(?:ument)?|synthesi[sz]e|plan (?:the|a) (?:migration|architecture|rewrite))\b/i,
    "spec or synthesis",
  ],
  [
    /\b(?:multi-?(?:repo|service|step)|across (?:the )?(?:codebase|repos|services)|cross-cutting)\b/i,
    "broad change",
  ],
];

const ROUTINE_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:typos?|rename|bump|version bump|formatting|lint(?:ing)?|one-?liner)\b/i, "small edit"],
  [
    /\b(?:update (?:the )?(?:docs|readme|changelog|copy|text|dependenc(?:y|ies))|release notes)\b/i,
    "docs or deps",
  ],
  [/\b(?:small fix|quick fix|simple|trivial|routine|straightforward)\b/i, "named as routine"],
  [
    /\b(?:status check|check (?:if|whether|the status)|screenshots?|install|run (?:the )?tests?|rebase|cherry-?pick|clean ?up)\b/i,
    "chore",
  ],
  [/\bdocumented (?:process|steps|release)\b/i, "documented process"],
];

/** Work a cheap class names outright: translation, transcripts and summaries are routine. */
const ROUTINE_CLASSES = new Set(["translation", "transcript", "summary"]);

/** A brief this long, or with this many requirement lines, is a big piece of work. */
const LONG_BRIEF_CHARS = 3_000;
const MANY_REQUIREMENTS = 8;

export interface LaneClassification {
  readonly lane: ModelLane;
  /** `hint`: the caller said; `learned`: a project preference said; `rules`: the signals below. */
  readonly source: "hint" | "learned" | "rules";
  readonly signals: ReadonlyArray<string>;
  /** The learned preference that set the lane, by id. */
  readonly preferenceId?: string | undefined;
}

export interface LaneTaskInput {
  readonly text: string;
  readonly title?: string | undefined;
}

function taskText(task: LaneTaskInput): string {
  return [task.title ?? "", task.text].join("\n");
}

/**
 * Complex or routine from the task's words alone. Complex needs a marker of
 * hard, open-ended or creative work, a long brief or a long requirement
 * list; anything else is routine, which is where most work belongs.
 */
export function classifyLaneByRules(
  task: LaneTaskInput,
  classification?: Pick<TaskClassification, "taskClass" | "confidence">,
): LaneClassification {
  const text = taskText(task);
  const complex: string[] = [];
  const routine: string[] = [];
  for (const [pattern, signal] of COMPLEX_SIGNALS) if (pattern.test(text)) complex.push(signal);
  for (const [pattern, signal] of ROUTINE_SIGNALS) if (pattern.test(text)) routine.push(signal);
  if (text.length > LONG_BRIEF_CHARS) complex.push("long brief");
  const requirementLines = text
    .split("\n")
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
  if (requirementLines >= MANY_REQUIREMENTS) complex.push(`${requirementLines} requirements`);
  if (classification?.taskClass === "animation-final") complex.push("final animation");
  if (
    classification !== undefined &&
    classification.confidence !== "uncertain" &&
    ROUTINE_CLASSES.has(classification.taskClass)
  )
    routine.push(classification.taskClass, classification.taskClass);
  const lane: ModelLane =
    complex.length >= 2 || (complex.length === 1 && routine.length === 0) ? "complex" : "routine";
  const signals = lane === "complex" ? complex : routine;
  return { lane, source: "rules", signals: [...new Set(signals)].slice(0, 6) };
}

// ── Learned preferences ──────────────────────────────────────────────

function keywordMatches(text: string, keyword: string): boolean {
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped.length === 0) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * How specifically a preference matches a task: 3 for keywords and class,
 * 2 for keywords, 1 for class, 0 for a prefer/avoid rule that names only a
 * lane; null when it does not match. `lane` is the task's lane, once known.
 */
export function preferenceMatch(
  preference: LearnedModelPreference,
  task: LaneTaskInput,
  classification: Pick<TaskClassification, "taskClass"> | undefined,
  lane: ModelLane | undefined,
): number | null {
  const text = taskText(task);
  const hasKeywords = preference.keywords.length > 0;
  if (hasKeywords && !preference.keywords.some((keyword) => keywordMatches(text, keyword)))
    return null;
  if (preference.taskClass !== undefined && preference.taskClass !== classification?.taskClass)
    return null;
  if (preference.action.kind !== "lane" && preference.lane !== undefined) {
    if (lane === undefined || preference.lane !== lane) return null;
  }
  const score = (hasKeywords ? 2 : 0) + (preference.taskClass !== undefined ? 1 : 0);
  if (score === 0 && (preference.action.kind === "lane" || preference.lane === undefined))
    return null;
  return score;
}

/** The best-matching preference of one kind: most specific first, then the newest. */
function bestPreference(
  preferences: ReadonlyArray<LearnedModelPreference>,
  kind: LearnedModelPreference["action"]["kind"],
  task: LaneTaskInput,
  classification: Pick<TaskClassification, "taskClass"> | undefined,
  lane: ModelLane | undefined,
): LearnedModelPreference | undefined {
  let best: { preference: LearnedModelPreference; score: number } | undefined;
  for (const preference of preferences) {
    if (preference.action.kind !== kind) continue;
    const score = preferenceMatch(preference, task, classification, lane);
    if (score === null) continue;
    if (
      best === undefined ||
      score > best.score ||
      (score === best.score && preference.createdAt > best.preference.createdAt)
    )
      best = { preference, score };
  }
  return best?.preference;
}

/** The task's lane: the caller's hint, else a learned lane rule, else the rules. */
export function classifyLane(input: {
  readonly task: LaneTaskInput;
  readonly hint?: ModelLane | undefined;
  readonly classification?: Pick<TaskClassification, "taskClass" | "confidence"> | undefined;
  readonly preferences?: ReadonlyArray<LearnedModelPreference> | undefined;
}): LaneClassification {
  if (input.hint !== undefined)
    return { lane: input.hint, source: "hint", signals: [`hint: ${input.hint}`] };
  const learned = bestPreference(
    input.preferences ?? [],
    "lane",
    input.task,
    input.classification,
    undefined,
  );
  if (learned !== undefined && learned.action.kind === "lane")
    return {
      lane: learned.action.lane,
      source: "learned",
      signals: [`learned: ${learned.note ?? learned.keywords.join(", ")}`.slice(0, 120)],
      preferenceId: learned.id,
    };
  return classifyLaneByRules(input.task, input.classification);
}

// ── Lane routing ─────────────────────────────────────────────────────

export interface ResolveLaneRoutingInput {
  readonly lanes: ModelLanes;
  readonly preferences: ReadonlyArray<LearnedModelPreference>;
  readonly task: LaneTaskInput;
  readonly classification: TaskClassification;
  readonly laneHint?: ModelLane | undefined;
  /** The model the app would use without lanes. */
  readonly baseline: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  /**
   * Exclusions and the escalation switch come from the Auto policy, and the
   * paid-API cap a learned preference keeps to. The cap counts only while
   * Auto is on (`mode: "auto"`); otherwise, or when absent, it reads as `never`.
   */
  readonly policy: Pick<TaskRoutingSettings, "excludedProviders" | "escalate"> &
    Partial<Pick<TaskRoutingSettings, "minimumTier" | "paidApi" | "mode">>;
  readonly switchAtPercent?: number | null | undefined;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  readonly runnableInstanceIds?: ReadonlySet<string> | undefined;
}

const selectionKey = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

function findModel(provider: ServerProvider | undefined, slug: string) {
  return provider?.models.find((model) => model.slug === slug || model.aliases?.includes(slug));
}

/** "Copilot managed · Claude Opus 5.5". */
export function laneEntryLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return `${providerLabel(provider, selection.instanceId)} · ${findModel(provider, selection.model)?.name ?? selection.model}`;
}

/** Why a lane entry cannot take a new worker now, or null when it can. */
export function laneEntryUnavailable(
  selection: ModelSelection,
  input: Pick<
    ResolveLaneRoutingInput,
    | "providers"
    | "nowMs"
    | "policy"
    | "switchAtPercent"
    | "limitedInstanceIds"
    | "runnableInstanceIds"
  >,
): string | null {
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined) return "not on this machine";
  const model = findModel(provider, selection.model);
  if (model === undefined) return "model not offered";
  const floor = input.policy.minimumTier;
  const tier = modelTier(model);
  if (floor != null && (tier === null || tierRank(tier) < tierRank(floor)))
    return `below minimum tier ${TIER_LABELS[floor]}`;
  if (input.policy.excludedProviders.includes(provider.instanceId)) return "excluded";
  if (input.runnableInstanceIds && !input.runnableInstanceIds.has(provider.instanceId))
    return "cannot run workers here";
  if (isGeminiSpendProvider(provider)) return "Gemini and Vertex are never picked automatically";
  if (input.limitedInstanceIds?.has(provider.instanceId)) return "at its usage limit";
  if (!canTakeTurn(provider))
    return provider.auth.status === "unauthenticated" ? "signed out" : "not ready";
  const used = providerUsedPercent(provider, input.nowMs, selection.model);
  const threshold = input.switchAtPercent ?? 100;
  if (used !== null && used >= threshold) return `at ${Math.round(used)}% usage`;
  return null;
}

const PAID_API_TIER: Record<TaskRoutingSettings["paidApi"], ModelTier | null> = {
  never: null,
  economy: "economy",
  standard: "standard",
};

/**
 * Why a learned "prefer" rule the coordinator recorded may not move a worker
 * onto `selection`, or null when it may. Such a rule is not the person's
 * choice, so a model billed per token, by a paid router or with unknown
 * billing needs their consent: the model is in one of their lanes, or Auto is
 * on and its paid-API setting covers its tier, as Auto checks. With Auto off
 * that setting is hidden and has no effect, so it grants nothing. A rule the person made
 * from the routing chip (`recordedBy: "person"`) is never checked here.
 */
export function learnedPreferenceBillingBlock(
  selection: ModelSelection,
  input: Pick<ResolveLaneRoutingInput, "providers" | "lanes" | "policy">,
): string | null {
  const key = selectionKey(selection);
  if ([...input.lanes.complex, ...input.lanes.routine].some((entry) => selectionKey(entry) === key))
    return null;
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = findModel(provider, selection.model);
  const billing = billingOf(provider, model);
  if (billing === "subscription" || billing === "local") return null;
  const cap = input.policy.mode === "auto" ? PAID_API_TIER[input.policy.paidApi ?? "never"] : null;
  const tier = model ? modelTier(model) : modelTier({ slug: selection.model });
  if (cap !== null && tier !== null && tierRank(tier) <= tierRank(cap)) return null;
  return billing === "unknown"
    ? "billing unknown; a learned preference never picks it"
    : "billed per token; a learned preference never picks it";
}

/**
 * The lane decision for one worker, or null when lanes have nothing to say
 * (the lane's list is empty and no usable learned preference names a model;
 * a coordinator's rule refused for billing counts as absent). A
 * matching "prefer" preference is tried before the list; an "avoid"
 * preference removes its model. The first entry that can run now wins, and
 * the next one that can is the escalation target. When none can, the
 * baseline stays and the decision says why.
 */
export interface LaneRoutingResult {
  readonly decision: TaskRoutingDecision;
  /** Whether a lane entry can take the worker; false keeps the baseline. */
  readonly found: boolean;
  /** A prohibited baseline must never be used as an implicit fallback. */
  readonly baselineUnavailable: string | null;
}

export function resolveLaneRouting(input: ResolveLaneRoutingInput): LaneRoutingResult | null {
  const lane = classifyLane({
    task: input.task,
    hint: input.laneHint,
    classification: input.classification,
    preferences: input.preferences,
  });
  // A coordinator's rule naming a paid model without the person's consent
  // counts as absent, so it never shadows another matching rule; the next
  // best rule, the lane list, or Auto when both are empty, decides.
  const refused: Array<{ readonly model: ModelSelection; readonly reason: string }> = [];
  const candidates = input.preferences.filter((preference) => {
    if (preference.action.kind !== "prefer" || preference.recordedBy === "person") return true;
    const reason = learnedPreferenceBillingBlock(preference.action.model, input);
    if (reason === null) return true;
    if (preferenceMatch(preference, input.task, input.classification, lane.lane) !== null)
      refused.push({ model: preference.action.model, reason });
    return false;
  });
  const preferred = bestPreference(
    candidates,
    "prefer",
    input.task,
    input.classification,
    lane.lane,
  );
  const avoided = new Set(
    input.preferences
      .filter(
        (preference) =>
          preference.action.kind === "avoid" &&
          preferenceMatch(preference, input.task, input.classification, lane.lane) !== null,
      )
      .flatMap((preference) =>
        preference.action.kind === "avoid" ? [selectionKey(preference.action.model)] : [],
      ),
  );
  const preferredModel = preferred?.action.kind === "prefer" ? preferred.action.model : undefined;
  const ordered: ModelSelection[] = [];
  const seen = new Set<string>();
  for (const selection of [
    ...(preferredModel !== undefined ? [preferredModel] : []),
    ...input.lanes[lane.lane],
  ]) {
    const key = selectionKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(selection);
  }
  if (ordered.length === 0 && avoided.size === 0) return null;

  const decidedAt = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs));
  const skipped: string[] = [
    ...new Map(
      refused.map((entry) => [
        selectionKey(entry.model),
        `${laneEntryLabel(input.providers, entry.model)}: ${entry.reason}`,
      ]),
    ).values(),
  ];
  const eligible: ModelSelection[] = [];
  for (const selection of ordered) {
    const label = laneEntryLabel(input.providers, selection);
    if (avoided.has(selectionKey(selection))) {
      skipped.push(`${label}: avoided for tasks like this`);
      continue;
    }
    const why = laneEntryUnavailable(selection, input);
    if (why !== null) {
      skipped.push(`${label}: ${why}`);
      continue;
    }
    eligible.push(selection);
    if (eligible.length === 2) break;
  }
  const laneLabel = LANE_LABELS[lane.lane];
  const signals = [`lane: ${lane.lane}`, ...lane.signals, ...input.classification.signals].slice(
    0,
    12,
  );
  const usedPreference =
    preferred !== undefined && eligible[0] !== undefined && preferred.action.kind === "prefer"
      ? selectionKey(preferred.action.model) === selectionKey(eligible[0])
        ? preferred.id
        : undefined
      : undefined;
  const preferenceId = usedPreference ?? lane.preferenceId;
  const common = {
    taskClass: input.classification.taskClass,
    confidence: lane.source === "hint" ? ("hint" as const) : ("high" as const),
    baseline: input.baseline,
    signals,
    lane: lane.lane,
    ...(skipped.length === 0 ? {} : { skipped: skipped.slice(0, 8) }),
    ...(preferenceId === undefined ? {} : { preferenceId }),
    decidedAt,
  };
  const chosen = eligible[0];
  if (chosen === undefined) {
    const baselineProvider = input.providers.find(
      (provider) => provider.instanceId === input.baseline.instanceId,
    );
    const baselineDetail = billingOf(
      baselineProvider,
      findModel(baselineProvider, input.baseline.model),
    );
    const decision: TaskRoutingDecision = {
      ...common,
      moved: false,
      tier: modelTier({ slug: input.baseline.model }),
      selection: input.baseline,
      escalation: null,
      billing: taskRoutingBilling(baselineDetail),
      modelBilling: baselineDetail,
      reason: `No ${laneLabel} model can run now (${skipped.slice(0, 3).join("; ")}): kept ${laneEntryLabel(input.providers, input.baseline)}.`,
    };
    const baselineUnavailable = avoided.has(selectionKey(input.baseline))
      ? "avoided for tasks like this"
      : laneEntryUnavailable(input.baseline, input);
    return { decision, found: false, baselineUnavailable };
  }
  const provider = input.providers.find((entry) => entry.instanceId === chosen.instanceId);
  const model = findModel(provider, chosen.model);
  const moved = selectionKey(chosen) !== selectionKey(input.baseline);
  const why =
    lane.source === "hint"
      ? "the coordinator judged it"
      : lane.source === "learned"
        ? "a learned preference says so"
        : lane.signals.length > 0
          ? lane.signals.slice(0, 2).join(", ")
          : "no sign of complex work";
  const via = usedPreference !== undefined ? " (learned preference)" : "";
  const passed = skipped.length > 0 ? ` after skipping ${skipped.length}` : "";
  const detail = billingOf(provider, model);
  const decision: TaskRoutingDecision = {
    ...common,
    moved,
    tier: model ? modelTier(model) : modelTier({ slug: chosen.model }),
    selection: moved
      ? { instanceId: chosen.instanceId, model: model?.slug ?? chosen.model }
      : input.baseline,
    escalation: moved && input.policy.escalate ? (eligible[1] ?? null) : null,
    billing: taskRoutingBilling(detail),
    modelBilling: detail,
    reason: `${laneLabel} (${why}): ${laneEntryLabel(input.providers, chosen)}${via}${passed}.`,
  };
  return { decision, found: true, baselineUnavailable: null };
}

// ── Recording preferences ────────────────────────────────────────────

/** Short topic words from a task title, for a preference's keywords. */
export function suggestPreferenceKeywords(title: string, max = 3): ReadonlyArray<string> {
  const STOP = new Set(
    "a an the and or of for to in on with from into at by is are be this that these those it its my our your new add make fix update run use".split(
      " ",
    ),
  );
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((word) => word.length >= 4 && !STOP.has(word));
  return [...new Set(words)].slice(0, max);
}

/**
 * The project's preference list with `next` added: a rule for the same
 * match and kind replaces the older one, and the oldest rules drop off
 * past the limit.
 */
export function withLearnedPreference(
  current: ReadonlyArray<LearnedModelPreference>,
  next: LearnedModelPreference,
  limit = MAX_LEARNED_MODEL_PREFERENCES,
): ReadonlyArray<LearnedModelPreference> {
  const sameMatch = (preference: LearnedModelPreference) =>
    preference.action.kind === next.action.kind &&
    (preference.taskClass ?? null) === (next.taskClass ?? null) &&
    (preference.lane ?? null) === (next.lane ?? null) &&
    [...preference.keywords]
      .map((word) => word.toLowerCase())
      .sort()
      .join("\u0000") ===
      [...next.keywords]
        .map((word) => word.toLowerCase())
        .sort()
        .join("\u0000") &&
    (next.action.kind !== "avoid" ||
      (preference.action.kind === "avoid" &&
        selectionKey(preference.action.model) === selectionKey(next.action.model)));
  const kept = current.filter((preference) => !sameMatch(preference));
  return [...kept, next].slice(-limit);
}

/** "Translations → Copilot managed · Claude Sonnet 5.5". */
export function describePreference(
  preference: LearnedModelPreference,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const scope = [
    preference.keywords.length > 0 ? `"${preference.keywords.join('", "')}"` : null,
    preference.taskClass ?? null,
    preference.action.kind !== "lane" && preference.lane
      ? `${LANE_LABELS[preference.lane]} tasks`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const action =
    preference.action.kind === "prefer"
      ? `use ${laneEntryLabel(providers, preference.action.model)}`
      : preference.action.kind === "avoid"
        ? `avoid ${laneEntryLabel(providers, preference.action.model)}`
        : `treat as ${LANE_LABELS[preference.action.lane]}`;
  return `${scope || "Any task"}: ${action}`;
}
