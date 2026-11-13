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

/** The spec's `## Review` section, or null when it has none or names no reviewer, depth or requirement. */
export function parseIncrementReviewPolicy(spec: string): IncrementReviewPolicy | null {
  const lines = spec.replace(/\r\n/gu, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+review\s*$/iu.test(line.trim()));
  if (start < 0) return null;
  let family: ReviewPolicyFamily | undefined;
  let model: string | undefined;
  let depth: ReviewPolicyDepth | undefined;
  let required: boolean | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,2}\s/u.test(line)) break;
    const match = /^\s*[-*]\s*\**([A-Za-z ]+?)\**\s*:\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").trim().toLowerCase();
    const value = (match[2] ?? "").replace(/\s+#.*$/u, "");
    if (key === "reviewer" || key === "reviewed by") {
      const reviewer = parseReviewer(value);
      if (reviewer !== null) ({ family, model } = reviewer);
    } else if (key === "depth" || key === "effort") depth = parseDepth(value) ?? depth;
    else if (key === "required" || key === "required to close")
      required = parseRequired(value) ?? required;
  }
  if (family === undefined && depth === undefined && required === undefined) return null;
  return {
    family: family ?? "cross-family",
    ...(model === undefined ? {} : { model }),
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

/** The record line of a review report, or null for a report without one. */
export function parseReviewRecordHeader(text: string): ReviewRecordHeader | null {
  const match = HEADER.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const pair of (match[1] ?? "").trim().split(/\s+/u)) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields.set(pair.slice(0, eq), pair.slice(eq + 1));
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
    at: fields.get("at") ?? null,
  };
}

/** Whether a reviewer of `family` (and `model`) satisfies the policy for work `authorFamily` wrote. */
export function reviewPolicyAccepts(
  policy: Pick<IncrementReviewPolicy, "family" | "model">,
  reviewer: { readonly family: string; readonly model?: string | null },
  authorFamily: string | null,
): boolean {
  if (policy.model !== undefined) {
    if (!reviewer.model || reviewer.model.toLowerCase() !== policy.model.toLowerCase())
      return false;
  }
  if (policy.family === "cross-family")
    return authorFamily === null ? reviewer.family !== "unknown" : reviewer.family !== authorFamily;
  return reviewer.family === policy.family;
}
