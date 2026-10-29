import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * Signing a machine's GitHub CLI in from another device. The machine's own
 * server runs `gh auth login --web` and publishes only the one-time code and
 * GitHub's device page; the person approves it in a browser on the device
 * they are using. The credential stays in that machine's gh store and no
 * token, transcript or credential value is ever part of this state.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const GitHubSignInPhase = Schema.Literals([
  "idle",
  "starting",
  "waiting",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type GitHubSignInPhase = typeof GitHubSignInPhase.Type;

export const GitHubSignInFailure = Schema.Literals([
  "not-installed",
  /** gh is too old to report its sign-in, so it is not driven from here. */
  "outdated",
  "unavailable",
  "timeout",
  "failed",
]);
export type GitHubSignInFailure = typeof GitHubSignInFailure.Type;

export const GitHubSignInState = Schema.Struct({
  flowId: Schema.NullOr(bounded(64)),
  phase: GitHubSignInPhase,
  host: bounded(255),
  /** gh's one-time code and the page to enter it on, once gh printed them. */
  deviceCode: Schema.NullOr(Schema.Struct({ userCode: bounded(16), url: bounded(2048) })),
  login: Schema.NullOr(bounded(255)),
  /** gh already held a login, so nothing was started. */
  alreadySignedIn: Schema.Boolean,
  failure: Schema.NullOr(GitHubSignInFailure),
  /** Safe for display: scrubbed of anything that looks like a credential. */
  message: Schema.NullOr(bounded(1000)),
  expiresAt: Schema.NullOr(Schema.Number),
});
export type GitHubSignInState = typeof GitHubSignInState.Type;

export const GitHubSignInStartInput = Schema.Struct({});
export type GitHubSignInStartInput = typeof GitHubSignInStartInput.Type;

export const GitHubSignInStatusInput = Schema.Struct({});
export type GitHubSignInStatusInput = typeof GitHubSignInStatusInput.Type;

export const GitHubSignInCancelInput = Schema.Struct({
  /** Cancels only this flow, so a stale client never stops a newer sign-in. */
  flowId: Schema.optional(bounded(64)),
});
export type GitHubSignInCancelInput = typeof GitHubSignInCancelInput.Type;

export class GitHubSignInError extends Schema.TaggedError<GitHubSignInError>()(
  "GitHubSignInError",
  { reason: bounded(1000) },
) {
  override get message(): string {
    return this.reason;
  }
}

export const GITHUB_SIGN_IN_RPC_METHODS = {
  gitHubSignInStart: "gitHubSignIn.start",
  gitHubSignInStatus: "gitHubSignIn.status",
  gitHubSignInCancel: "gitHubSignIn.cancel",
} as const;

const error = Schema.Union([GitHubSignInError, EnvironmentAuthorizationError]);
export const gitHubSignInRpcs = [
  Rpc.make(GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInStart, {
    payload: GitHubSignInStartInput,
    success: GitHubSignInState,
    error,
  }),
  Rpc.make(GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInStatus, {
    payload: GitHubSignInStatusInput,
    success: GitHubSignInState,
    error,
  }),
  Rpc.make(GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInCancel, {
    payload: GitHubSignInCancelInput,
    success: GitHubSignInState,
    error,
  }),
] as const;
