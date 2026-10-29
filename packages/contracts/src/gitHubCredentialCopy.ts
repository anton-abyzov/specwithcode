import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId } from "./baseSchemas.ts";

/**
 * A machine's GitHub access as SpecWithCode sees it, and copying another
 * machine's sign-in into it. Detection reads names and logins only. A copied
 * token goes from the source server straight to the destination server over
 * their tailnet link and lands in the destination's secret store; it never
 * passes through a client and is never part of any of these results.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** Where the credential SpecWithCode uses on this machine comes from. */
export const GitHubCredentialSource = Schema.Literals(["copied", "saved", "env", "gh"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export const GitHubCredentialState = Schema.Struct({
  host: bounded(255),
  /** False when the host is turned off in Settings; SpecWithCode then uses nothing. */
  hostEnabled: Schema.Boolean,
  gh: Schema.Struct({
    installed: Schema.Boolean,
    version: Schema.NullOr(bounded(64)),
    /** Too old to report its sign-in (`gh auth status --json`). */
    outdated: Schema.Boolean,
  }),
  /** gh's logins for the host. gh's own active choice is never changed from here. */
  ghAccounts: Schema.Array(
    Schema.Struct({
      login: bounded(255),
      active: Schema.Boolean,
      authenticated: Schema.Boolean,
    }),
  ),
  /** Names of token variables set for the server, such as GH_TOKEN. Never their values. */
  environmentVariables: Schema.Array(bounded(64)),
  /** A token saved in Settings for the host, and where it came from when it was copied. */
  saved: Schema.NullOr(
    Schema.Struct({
      copiedFrom: Schema.NullOr(bounded(255)),
      copiedAt: Schema.NullOr(bounded(64)),
      login: Schema.NullOr(bounded(255)),
    }),
  ),
  /** git's global credential helpers, by program name only. */
  credentialHelpers: Schema.Array(bounded(255)),
  /** A helper configured for https://github.com specifically. */
  gitHubCredentialHelper: Schema.Boolean,
  /** What SpecWithCode's GitHub features use here, in GitHubCredentials' order. */
  inUse: Schema.NullOr(
    Schema.Struct({ source: GitHubCredentialSource, login: Schema.NullOr(bounded(255)) }),
  ),
});
export type GitHubCredentialState = typeof GitHubCredentialState.Type;

export const GitHubCredentialCopyUnavailable = Schema.Literals([
  /** This machine has no GitHub sign-in to copy. */
  "no-token",
  /** github.com is turned off in this machine's Settings, so its sign-in is not used or copied. */
  "host-off",
  /** GitHub refused this machine's token. */
  "unverified",
  /** This machine has no fleet link with a management token to the destination. */
  "no-link",
  /** The destination is reachable only through Connect; tokens go over the tailnet only. */
  "connect-only",
]);
export type GitHubCredentialCopyUnavailable = typeof GitHubCredentialCopyUnavailable.Type;

export const GitHubCredentialCopyPreview = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(GitHubCredentialCopyUnavailable),
  message: Schema.NullOr(bounded(1000)),
  /** The account the token signs in as, checked with GitHub. */
  login: Schema.NullOr(bounded(255)),
  /** Classic scopes from X-OAuth-Scopes; empty for a fine-grained token. */
  scopes: Schema.Array(bounded(100)),
  fineGrained: Schema.Boolean,
  /** Null when GitHub reports no expiry, as for gh's OAuth tokens. */
  expiresAt: Schema.NullOr(bounded(64)),
  source: Schema.NullOr(Schema.Literals(["saved", "gh"])),
  /** This machine's name, recorded on the destination as where the token came from. */
  sourceLabel: bounded(255),
});
export type GitHubCredentialCopyPreview = typeof GitHubCredentialCopyPreview.Type;

export const GitHubCredentialStateInput = Schema.Struct({});
export const GitHubCredentialRemoveCopiedInput = Schema.Struct({});
export const GitHubCredentialCopyInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  /** Replace a token saved by hand on that machine; it is kept so Remove restores it. */
  replaceSaved: Schema.optionalKey(Schema.Boolean),
});
export type GitHubCredentialCopyInput = typeof GitHubCredentialCopyInput.Type;

export const GitHubCredentialCopyResult = Schema.Struct({
  login: bounded(255),
  copiedAt: bounded(64),
});
export type GitHubCredentialCopyResult = typeof GitHubCredentialCopyResult.Type;

export class GitHubCredentialError extends Schema.TaggedError<GitHubCredentialError>()(
  "GitHubCredentialError",
  { reason: bounded(1000) },
) {
  override get message(): string {
    return this.reason;
  }
}

export const GITHUB_CREDENTIAL_RPC_METHODS = {
  gitHubCredentialState: "gitHubCredential.state",
  gitHubCredentialRemoveCopied: "gitHubCredential.removeCopied",
  gitHubCredentialCopyPreview: "gitHubCredential.copyPreview",
  gitHubCredentialCopy: "gitHubCredential.copy",
} as const;

const error = Schema.Union([GitHubCredentialError, EnvironmentAuthorizationError]);
export const gitHubCredentialRpcs = [
  Rpc.make(GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialState, {
    payload: GitHubCredentialStateInput,
    success: GitHubCredentialState,
    error,
  }),
  Rpc.make(GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialRemoveCopied, {
    payload: GitHubCredentialRemoveCopiedInput,
    success: GitHubCredentialState,
    error,
  }),
  Rpc.make(GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialCopyPreview, {
    payload: GitHubCredentialCopyInput,
    success: GitHubCredentialCopyPreview,
    error,
  }),
  Rpc.make(GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialCopy, {
    payload: GitHubCredentialCopyInput,
    success: GitHubCredentialCopyResult,
    error,
  }),
] as const;
