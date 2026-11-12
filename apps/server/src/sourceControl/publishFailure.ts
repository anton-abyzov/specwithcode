/**
 * Why publishing a new repository failed, from the provider's typed error,
 * in fixed words: never the provider's raw text, which can carry a token.
 *
 * @module publishFailure
 */
import type { SourceControlPublishFailureReason } from "@specweave-studio/contracts";

const tagOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "_tag" in value
    ? String((value as { _tag: unknown })._tag)
    : undefined;

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/**
 * The reason and its words for a failed `createRepository`, or null when the
 * provider gave nothing that can be told apart. `providerCause` is the
 * provider's own error (a GitHub CLI error for GitHub).
 */
export function classifyCreateRepositoryFailure(input: {
  readonly providerCause: unknown;
  readonly repository: string;
}): { readonly reason: SourceControlPublishFailureReason; readonly detail: string } | null {
  const owner = input.repository.includes("/") ? input.repository.split("/")[0] : null;
  const account = owner ? `the ${owner} account` : "that account";
  const cause = input.providerCause;
  switch (tagOf(cause)) {
    case "GitHubCliUnavailableError":
    case "GitHubCliAuthenticationError":
      return {
        reason: "not_signed_in",
        detail:
          "This machine is not signed in to GitHub. Run gh auth login there, then publish again.",
      };
    case "GitHubCliRateLimitError":
      return {
        reason: "rate_limited",
        detail: "GitHub's rate limit was reached. Publish again once it resets.",
      };
    case "GitHubPullRequestNotFoundError":
      // GitHub answers 404 for an organization the account cannot create in.
      return {
        reason: "no_permission",
        detail: `This GitHub sign-in may not create repositories in ${account}.`,
      };
    case "GitHubCliCommandError": {
      const status = fieldOf(cause, "httpStatus");
      if (status === 422) {
        return {
          reason: "name_taken",
          detail: `A repository named ${input.repository} already exists in ${account}. Rename the project folder or publish under another name.`,
        };
      }
      if (status === 403 || status === 401) {
        return {
          reason: "no_permission",
          detail: `This GitHub sign-in may not create repositories in ${account}.`,
        };
      }
      if (tagOf(fieldOf(cause, "cause")) === "GitHubApiRequestError") {
        return {
          reason: "network",
          detail: "This machine could not reach GitHub. Check its network, then publish again.",
        };
      }
      return null;
    }
    default:
      return null;
  }
}
