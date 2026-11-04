/**
 * The first message of an adversarial review thread. It carries the whole
 * procedure, so a review runs the same whether or not the
 * `adversarial-review` skill is installed where the reviewer works.
 */
import type { ModelFamily } from "@specweave-studio/shared/fallbackOptions";

const FAMILY_NAMES: Record<ModelFamily, string> = {
  claude: "Claude",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  other: "another model",
};

export interface AdversarialReviewPromptInput {
  /** Title of the thread whose work is reviewed. */
  readonly sourceTitle: string;
  /** The model that did the work, as a person reads it ("Claude · Opus 5.5"). */
  readonly authorLabel: string;
  readonly authorFamily: ModelFamily;
  readonly branch: string | null;
  readonly incrementId: string | null;
  readonly specPath: string | null;
  readonly pullRequestUrl: string | null;
  /** What started the review, for the reader. */
  readonly trigger: "manual" | "feature-complete";
}

export function adversarialReviewPrompt(input: AdversarialReviewPromptInput): string {
  const scope = [
    `- Work: "${input.sourceTitle}", done by ${input.authorLabel} (${FAMILY_NAMES[input.authorFamily]} family).`,
    ...(input.branch === null ? [] : [`- Branch: ${input.branch}`]),
    ...(input.pullRequestUrl === null ? [] : [`- Pull request: ${input.pullRequestUrl}`]),
    ...(input.incrementId === null
      ? []
      : [
          `- Increment: ${input.incrementId}${input.specPath === null ? "" : ` (spec: ${input.specPath})`}`,
        ]),
    `- Started: ${input.trigger === "feature-complete" ? "automatically, because the feature's last task finished" : "by hand"}.`,
  ];
  return [
    "Adversarial review. Load the adversarial-review skill first, when it is installed; the steps below are the same.",
    "",
    "A different model family did this work. Find what is wrong with it. Do not approve it by default.",
    "",
    ...scope,
    "",
    "Steps:",
    `1. Find the change: the pull request diff, else \`git diff origin/main...${input.branch ?? "HEAD"}\` (three dots diff from the merge base), else \`git diff\`. ${input.branch === null ? "" : "Do not check out the branch; this checkout may be shared. Read its files with `git show <branch>:<path>` when HEAD is elsewhere. "}Read every changed file around each hunk, and the callers and tests of changed functions.`,
    "2. Find what was asked: the increment spec's acceptance criteria, else the pull request description, else the thread title.",
    "3. Attack it for correctness (edge cases, errors, ordering, restarts, old data), missed requirements, risky assumptions (platform, network, provider availability), security (injection, secrets, authorization, unsafe defaults) and tests that would not catch a regression. Run focused tests and type checks when you can.",
    "4. Re-check each finding against the code and drop the ones that do not hold.",
    "",
    "Rules: read-only. Do not edit files, commit, push or open pull requests. Every finding cites path:line and its evidence. No style nits.",
    "",
    "Report: first line is the verdict (blocking issues / fix before merge / no blocking issues) and the count per severity. Then each finding, most severe first:",
    "[critical|high|medium|low] Title",
    "Where: path:line",
    "Why: what breaks, for whom, how to trigger it",
    "Fix: the smallest change that removes it",
    'End with "Checked and ruled out:" and anything you could not check.',
  ].join("\n");
}
