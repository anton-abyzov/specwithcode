/**
 * An increment's review policy and its review records, as SpecWeave writes
 * them (`src/core/review/policy.ts` and `record.ts` in the specweave
 * repository; keep the formats in step):
 *
 *   ## Review
 *   - Reviewer: openai (gpt-6.1-sol)   cross-family | a family | a model id
 *   - Depth: deep                      standard | deep
 *   - Required: yes                    specweave complete waits for a matching ship review
 *
 *   <!-- specweave review: reviewer=… model=gpt-6.1-sol family=openai author=claude … head=<sha> at=… -->
 *
 * Read offline: no CLI, no Git.
 *
 * @module reviewPolicy
 */
import { type ModelFamily, modelFamily } from "./fallbackOptions.ts";
import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";

import { type ExcludedFallbackModel, normalizeModelKey } from "./providerFallback.ts";

export type ReviewPolicyFamily = Exclude<ModelFamily, "other"> | "cross-family";
export type ReviewPolicyDepth = "standard" | "deep";

export interface IncrementReviewPolicy {
  readonly family: ReviewPolicyFamily;
  readonly model?: string;
  readonly depth?: ReviewPolicyDepth;
  readonly required?: boolean;
}

const POLICY_FAMILIES: ReadonlyArray<Exclude<ReviewPolicyFamily, "cross-family">> = [
  "openai",
  "claude",
  "google",
  "xai",
  "meta",
];

/** Family of a model id, the way the app names families. */
export function familyOfModelId(id: string): ModelFamily {
  return modelFamily({ slug: id });
}

export type ReviewFamily = Exclude<ReviewPolicyFamily, "cross-family">;

/**
 * A family name, model id or tool name (`openai`, `gpt-6.1-sol`, `codex`,
 * `fable`) as one of the families a policy can name, or null when it names
 * none. An unclassified family is never evidence of a cross-family review.
 */
export function canonicalReviewFamily(value: string | null | undefined): ReviewFamily | null {
  const key = (value ?? "").trim().toLowerCase();
  if (key === "" || key === "unknown") return null;
  const named = POLICY_FAMILIES.find((family) => family === key);
  if (named !== undefined) return named;
  if (/^(anthropic)/u.test(key)) return "claude";
  if (/^(openai|chatgpt)/u.test(key)) return "openai";
  if (/^(google)/u.test(key)) return "google";
  if (/^(xai)/u.test(key)) return "xai";
  const family = familyOfModelId(key);
  return family === "other" ? null : family;
}

/** Model ids every provider spells alike: Copilot's `claude-opus-5.5` is `claude-opus-5-5`. */
export function sameReviewModel(a: string, b: string): boolean {
  return normalizeModelKey(a) === normalizeModelKey(b);
}

function parseReviewer(value: string): Pick<IncrementReviewPolicy, "family" | "model"> | null {
  const v = value.trim().replace(/[`*_]/g, "");
  if (v === "") return null;
  const paren = /^([^()]+?)\s*\(([^()]+)\)\s*$/u.exec(v);
  const head = (paren?.[1] ?? v).trim().toLowerCase();
  const model = paren?.[2]?.trim();
  const withModel = model === undefined || model === "" ? {} : { model };
  if (/^(cross[- ]?family|cross[- ]?model|any other family|other family|auto)$/u.test(head))
    return { family: "cross-family", ...withModel };
  const named = POLICY_FAMILIES.find((family) => family === head);
  if (named !== undefined) return { family: named, ...withModel };
  const family = familyOfModelId(head);
  return family === "other" ? null : { family, model: paren ? (model ?? head) : v.trim() };
}

function parseDepth(value: string): ReviewPolicyDepth | undefined {
  const v = value.trim().toLowerCase();
  if (/^(deep|xhigh|ultra|high|max|thorough)$/u.test(v)) return "deep";
  if (/^(standard|normal|regular|default|medium)$/u.test(v)) return "standard";
  return undefined;
}

function parseRequired(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (/^(yes|true|required|on|y)$/u.test(v)) return true;
  if (/^(no|false|optional|off|n)$/u.test(v)) return false;
  return undefined;
}

interface ReviewSection {
  readonly family?: ReviewPolicyFamily;
  readonly model?: string;
  readonly depth?: ReviewPolicyDepth;
  readonly required?: boolean;
}

/** What the spec's `## Review` section says, field by field, or null without one. */
function readReviewSection(spec: string): ReviewSection | null {
  const lines = spec.replace(/\r\n/gu, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+review\s*$/iu.test(line.trim()));
  if (start < 0) return null;
  let reviewer: Pick<IncrementReviewPolicy, "family" | "model"> | null = null;
  let depth: ReviewPolicyDepth | undefined;
  let required: boolean | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,2}\s/u.test(line)) break;
    const match = /^\s*[-*]\s*\**([A-Za-z ]+?)\**\s*:\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").trim().toLowerCase();
    const value = (match[2] ?? "").replace(/\s+#.*$/u, "");
    if (key === "reviewer" || key === "reviewed by") reviewer = parseReviewer(value) ?? reviewer;
    else if (key === "depth" || key === "effort") depth = parseDepth(value) ?? depth;
    else if (key === "required" || key === "required to close")
      required = parseRequired(value) ?? required;
  }
  return {
    ...(reviewer === null ? {} : reviewer),
    ...(depth === undefined ? {} : { depth }),
    ...(required === undefined ? {} : { required }),
  };
}

/** The spec's `## Review` section, or null when it has none or names no reviewer, depth or requirement. */
export function parseIncrementReviewPolicy(spec: string): IncrementReviewPolicy | null {
  const section = readReviewSection(spec);
  if (
    section === null ||
    (section.family === undefined && section.depth === undefined && section.required === undefined)
  )
    return null;
  return { family: "cross-family", ...section };
}

/** `.specweave/config.json` `review`, as far as the policy reads it. */
export interface ReviewConfigLayer {
  readonly policy?: {
    readonly reviewer?: unknown;
    readonly depth?: unknown;
    readonly required?: unknown;
  } | null;
  readonly crossModel?: unknown;
}

/**
 * The effective policy, layered the way `specweave` resolves it: the spec's
 * `## Review`, then `review.policy`, then `review.crossModel: true` (required,
 * cross-family). Null when no layer says anything.
 */
export function resolveIncrementReviewPolicy(input: {
  readonly spec: string | null;
  readonly config: ReviewConfigLayer | null;
}): IncrementReviewPolicy | null {
  const spec = input.spec === null ? null : readReviewSection(input.spec);
  const raw = input.config?.policy;
  const configPolicy = raw !== null && typeof raw === "object" ? raw : null;
  const configReviewer =
    typeof configPolicy?.reviewer === "string" ? parseReviewer(configPolicy.reviewer) : null;
  const configDepth =
    typeof configPolicy?.depth === "string" ? parseDepth(configPolicy.depth) : undefined;
  const configRequired =
    typeof configPolicy?.required === "boolean" ? configPolicy.required : undefined;
  const crossModel = input.config?.crossModel === true;
  const reviewer =
    spec?.family !== undefined
      ? { family: spec.family, ...(spec.model === undefined ? {} : { model: spec.model }) }
      : configReviewer;
  const depth = spec?.depth ?? configDepth;
  const required = spec?.required ?? configRequired ?? (crossModel ? true : undefined);
  if (reviewer === null && depth === undefined && required === undefined) return null;
  return {
    family: reviewer?.family ?? "cross-family",
    ...(reviewer?.model === undefined ? {} : { model: reviewer.model }),
    ...(depth === undefined ? {} : { depth }),
    ...(required === undefined ? {} : { required }),
  };
}

export interface ReviewRecordHeader {
  readonly reviewer: string;
  readonly model: string | null;
  readonly family: string;
  readonly author: string | null;
  readonly depth: string | null;
  readonly repo: string | null;
  readonly head: string | null;
  readonly at: string | null;
}

const HEADER = /^<!--\s*specweave review:([^>]*)-->\s*$/mu;
const SHA = /^[0-9a-f]{7,40}$/iu;

/** Header values are percent-encoded (`repositories/acme/My%20App`); an older plain value reads as is. */
function decodeField(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The record line of a review report, or null for a report without one. */
export function parseReviewRecordHeader(text: string): ReviewRecordHeader | null {
  const match = HEADER.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const pair of (match[1] ?? "").trim().split(/\s+/u)) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields.set(pair.slice(0, eq), decodeField(pair.slice(eq + 1)));
  }
  const reviewer = fields.get("reviewer") ?? fields.get("model");
  if (reviewer === undefined || reviewer === "") return null;
  const head = fields.get("head");
  const author = fields.get("author");
  return {
    reviewer,
    model: fields.get("model") ?? null,
    family: fields.get("family") ?? "unknown",
    author: author === undefined || author === "unknown" ? null : author,
    depth: fields.get("depth") ?? null,
    repo: fields.get("repo") ?? null,
    head: head !== undefined && SHA.test(head) ? head : null,
    at: validAt(fields.get("at")),
  };
}

function validAt(value: string | undefined): string | null {
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Whether a reviewer satisfies the policy for work `authorFamily` wrote:
 * family and author compared as canonical families (an unclassified reviewer
 * family never counts), a pinned model compared across provider spellings,
 * and a deep policy met only by a deep review.
 */
export function reviewPolicyAccepts(
  policy: Pick<IncrementReviewPolicy, "family" | "model" | "depth">,
  reviewer: {
    readonly family: string;
    readonly model?: string | null;
    readonly depth?: string | null;
  },
  authorFamily: string | null,
): boolean {
  if (policy.model !== undefined) {
    if (!reviewer.model || !sameReviewModel(reviewer.model, policy.model)) return false;
  }
  if (policy.depth === "deep" && reviewer.depth !== "deep") return false;
  const family = canonicalReviewFamily(reviewer.family);
  if (family === null) return false;
  // A model the record names that belongs to another family contradicts it.
  const modelFamilyOf = reviewer.model ? canonicalReviewFamily(reviewer.model) : null;
  if (modelFamilyOf !== null && modelFamilyOf !== family) return false;
  if (policy.family === "cross-family") {
    const author = canonicalReviewFamily(authorFamily);
    return author === null || family !== author;
  }
  return family === policy.family;
}

export interface ReviewRecordForPolicy {
  readonly family: string;
  readonly model: string | null;
  readonly depth: string | null;
  readonly author: string | null;
  readonly repo: string | null;
  readonly verdict: "ship" | "fix first" | null;
}

/** `repositories/acme/api` and `./repositories/acme/api/` name one repository; absent is the root. */
export function reviewRepoKey(repo: string | null | undefined): string {
  const key = (repo ?? ".")
    .replace(/\\/gu, "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  return key === "" ? "." : key;
}

/**
 * The repositories an increment's task Files live in (`.` for the project
 * root), from its spec's `Files:` fields. Increment bookkeeping and `none`
 * do not count.
 */
export function incrementReviewRepos(spec: string | null): ReadonlyArray<string> {
  if (spec === null) return [];
  const repos = new Set<string>();
  for (const match of spec.matchAll(/Files:\s*([^|\n]+)/giu)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const file = raw.trim().replace(/[`*]/gu, "").replace(/\\/gu, "/");
      if (file === "" || /^(none|n\/a|-)$/iu.test(file) || /(^|\/)\.specweave(\/|$)/u.test(file))
        continue;
      const repo = /^(repositories\/[^/\s]+\/[^/\s]+)\//u.exec(file);
      repos.add(repo?.[1] ?? ".");
    }
  }
  return [...repos].sort();
}

/**
 * Whether the records satisfy the policy the way `specweave complete` judges
 * them: in every repository, the newest record that matches the policy says
 * ship. Records come newest first. Freshness against verify and the reviewed
 * commit are left to closure, which has Git.
 */
export function reviewPolicySatisfied(
  policy: Pick<IncrementReviewPolicy, "family" | "model" | "depth">,
  records: ReadonlyArray<ReviewRecordForPolicy>,
  repos: ReadonlyArray<string>,
  authorFamily: string | null,
): boolean {
  const newestMatch = (inRepo: ReadonlyArray<ReviewRecordForPolicy>) =>
    inRepo.find((record) => reviewPolicyAccepts(policy, record, record.author ?? authorFamily));
  if (repos.length === 0) return newestMatch(records)?.verdict === "ship";
  return repos.every(
    (repo) =>
      newestMatch(records.filter((record) => reviewRepoKey(record.repo) === reviewRepoKey(repo)))
        ?.verdict === "ship",
  );
}

/**
 * Every model on these providers outside the review's family, as fallback
 * exclusions: added to a review thread's limit rule, a quota stop can move
 * the review only to another model of its reviewer's family, or it waits.
 */
export function reviewFamilyExclusions(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
  family: ReviewFamily,
): ReadonlyArray<ExcludedFallbackModel & { readonly instanceId: ProviderInstanceId }> {
  return providers.flatMap((provider) =>
    provider.models
      .filter((model) => modelFamily(model) !== family)
      .map((model) => ({ instanceId: provider.instanceId, model: model.slug })),
  );
}

/** A limit rule for this thread: unchanged, or narrowed to its review family. */
export function reviewConstrainedRule<
  R extends {
    readonly providerLimitExcludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  },
>(
  rule: R,
  routing: { readonly reviewFamily?: ReviewFamily | undefined } | null | undefined,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): R {
  const family = routing?.reviewFamily;
  if (family === undefined) return rule;
  return {
    ...rule,
    providerLimitExcludedModels: [
      ...(rule.providerLimitExcludedModels ?? []),
      ...reviewFamilyExclusions(providers, family),
    ],
  };
}
