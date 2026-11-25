/**
 * `gitHubCredential.starred`: has this machine's GitHub sign-in starred SpecWithCode?
 *
 * Read-only. The app never stars on anyone's behalf: the star prompt opens the repository in
 * the person's browser. This check only lets the prompt stay quiet for someone who already
 * starred. The repository is fixed here, not taken from the client, so the machine's credential
 * cannot be pointed at another repository. The answer carries no login and is not stored.
 */
export const SPECWITHCODE_REPOSITORY = "anton-abyzov/specwithcode";

const STARRED_URL = `https://api.github.com/user/starred/${SPECWITHCODE_REPOSITORY}`;
const TIMEOUT_MS = 10_000;

export interface GitHubStarredDeps {
  /** False when github.com is turned off in this machine's Settings. */
  readonly hostEnabled: boolean;
  readonly savedToken: () => Promise<string | null>;
  readonly ghToken: () => Promise<string | null>;
  readonly fetch: typeof globalThis.fetch;
}

/** True or false when GitHub answered; null when there is no sign-in or no clear answer. */
export async function readGitHubStarred(deps: GitHubStarredDeps): Promise<boolean | null> {
  if (!deps.hostEnabled) return null;
  const token =
    (await deps.savedToken().catch(() => null)) ?? (await deps.ghToken().catch(() => null));
  if (!token) return null;
  try {
    const response = await deps.fetch(STARRED_URL, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    // GitHub answers 204 when starred and 404 when not; a token without the scope also gets 404,
    // which only means the prompt may show, never that anything is done with the account.
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}
