import type {
  GitHubCredentialCopyPreview,
  GitHubCredentialState,
} from "@specweave-studio/contracts";

export type GitHubOfferRank = "primary" | "secondary" | "none";

export interface GitHubCredentialPlan {
  /** Copying this machine's sign-in there. */
  readonly copy: GitHubOfferRank;
  /** Signing that machine's gh in with a one-time code. */
  readonly deviceCode: GitHubOfferRank;
  /** The login SpecWithCode already uses there is the one a copy would bring. */
  readonly sameAccount: boolean;
  /**
   * gh's own active login there when SpecWithCode uses a different, copied one and
   * removing the copy would hand over to gh (no token variable in between).
   */
  readonly otherGhLogin: string | null;
  /** A copy would replace a token saved by hand there; it is offered only as that choice. */
  readonly replacesSaved: boolean;
}

/**
 * What the GitHub card offers for a machine. A machine that already has a working
 * login keeps it: nothing is offered by default, and a copy is only a secondary,
 * explicit choice that never touches gh. The device code is offered only while gh
 * holds no github.com login, so `gh auth login` never meets an existing one.
 */
export function planGitHubCredential(input: {
  readonly state: GitHubCredentialState;
  /** Both machines support copying and this client may change both. */
  readonly copySupported: boolean;
  readonly preview: GitHubCredentialCopyPreview | null;
  /** The source machine's "copy this machine's GitHub sign-in" setting. */
  readonly copyByDefault: boolean;
  /** The machine's server can run the device-code sign-in. */
  readonly deviceCodeSupported: boolean;
}): GitHubCredentialPlan {
  const { state, preview } = input;
  const canCopy = input.copySupported && preview?.available === true;
  const ghLogins = state.ghAccounts.filter((account) => account.authenticated);
  const ghActive = ghLogins.find((account) => account.active) ?? ghLogins[0];
  const ghHasLogin = state.ghAccounts.length > 0;
  const canDeviceCode =
    input.deviceCodeSupported && state.gh.installed && !state.gh.outdated && !ghHasLogin;
  const inUse = state.inUse;
  const sameAccount =
    inUse?.login != null && preview?.login != null && inUse.login === preview.login;
  const tokenVariable = state.environmentVariables.some(
    (name) => name === "GH_TOKEN" || name === "GITHUB_TOKEN",
  );
  const otherGhLogin =
    inUse?.source === "copied" && !tokenVariable && ghActive && ghActive.login !== inUse.login
      ? ghActive.login
      : null;
  const replacesSaved = inUse?.source === "saved";

  if (!state.hostEnabled)
    return { copy: "none", deviceCode: "none", sameAccount, otherGhLogin, replacesSaved };
  if (inUse !== null)
    return {
      // Already signed in: do nothing by default. A different account may be copied explicitly;
      // over a token saved by hand that means replacing it (and Remove brings it back).
      copy: canCopy && !sameAccount && inUse.source !== "copied" ? "secondary" : "none",
      deviceCode: "none",
      sameAccount,
      otherGhLogin,
      replacesSaved,
    };
  const copyFirst = canCopy && input.copyByDefault;
  return {
    copy: canCopy ? (copyFirst || !canDeviceCode ? "primary" : "secondary") : "none",
    deviceCode: canDeviceCode ? (copyFirst ? "secondary" : "primary") : "none",
    sameAccount,
    otherGhLogin,
    replacesSaved,
  };
}

/** The short "what this token is" text for the copy confirmation. */
export function describeToken(preview: GitHubCredentialCopyPreview): string {
  const scopes = preview.fineGrained
    ? "a fine-grained token"
    : preview.scopes.length > 0
      ? `scopes ${preview.scopes.join(", ")}`
      : "no scopes";
  const expiry = preview.expiresAt ? `expires ${preview.expiresAt}` : "does not expire";
  return `${scopes}; ${expiry}`;
}
