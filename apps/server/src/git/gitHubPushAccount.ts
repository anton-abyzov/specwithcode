/**
 * Which GitHub login a refused push should have used. Pure parsing and
 * wording; the credential reads and the retry live in GitManager.
 */

/** The host and owner of an `https://github.com/<owner>/<repo>` (or `*.ghe.com`) remote. */
export function parseGitHubHttpsRemote(
  url: string | null,
): { readonly host: string; readonly owner: string } | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && !host.endsWith(".ghe.com")) return null;
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const owner = segments[0];
  if (segments.length < 2 || owner === undefined || owner === "") return null;
  return { host, owner };
}

export interface PushLogin {
  readonly login: string;
  readonly active: boolean;
}

/** The held login named like the owner, in gh's own spelling. */
export function ownerLogin(logins: ReadonlyArray<PushLogin>, owner: string): PushLogin | undefined {
  return logins.find((entry) => entry.login.toLowerCase() === owner.toLowerCase());
}

/**
 * What to do about a push GitHub refused for credentials: the login it
 * refused (gh's active one, which is what git's gh helper serves), the
 * owner-named login when gh holds one, and the setup commands otherwise.
 */
export function pushAuthFixHint(input: {
  readonly owner: string;
  readonly logins: ReadonlyArray<PushLogin>;
  readonly hasCredentialHelper: boolean;
}): string {
  const refused = input.logins.find((entry) => entry.active)?.login;
  const parts = [
    refused === undefined
      ? "GitHub refused the push for the active gh login."
      : `GitHub refused the push for gh login "${refused}".`,
  ];
  const named = ownerLogin(input.logins, input.owner);
  if (named !== undefined && named.login !== refused)
    parts.push(
      `gh also holds "${named.login}", which matches the repository owner "${input.owner}"; check that login can write to the repository.`,
    );
  else if (named === undefined)
    parts.push(`gh holds no login named "${input.owner}"; add one with \`gh auth login\`.`);
  if (!input.hasCredentialHelper)
    parts.push("Git has no credential helper for github.com; run `gh auth setup-git`.");
  return parts.join(" ");
}

/** Whether git config names a credential helper (generic or for github.com over HTTPS). */
export function hasGitHubCredentialHelper(values: ReadonlyArray<string | null>): boolean {
  return values.some((value) => value !== null && value.trim() !== "");
}
