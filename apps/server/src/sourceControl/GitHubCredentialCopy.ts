/**
 * Copying this machine's GitHub sign-in to a fleet machine. The source reads
 * its token (one saved in Settings first, then `gh auth token`), checks it with
 * GitHub for the account, scopes and expiry, and posts it to the destination
 * server over the tailnet with that machine's management token. Connect
 * addresses are never used for it. The destination keeps it in its secret
 * store as its saved Settings token, with a non-secret note of where it came
 * from; nothing on either machine's gh, git config or credential helpers
 * changes. Results and errors carry the login at most, never the token.
 */
import type {
  GitHubCredentialCopyPreview,
  GitHubCredentialCopyResult,
  GitHubSettings,
  ServerSettingsPatch,
} from "@specweave-studio/contracts";

import type { FleetTarget } from "../studioFleet.ts";
import { GITHUB_HOST, copiedNote, tokenFingerprint } from "./gitHubCredentialState.ts";
import { parseFleetOrigin } from "../fleet/fleetOrigin.ts";

export const GITHUB_CREDENTIAL_PATH = "/api/studio/github-credential";

export class GitHubCredentialCopyFailure extends Error {}

export interface TokenFacts {
  readonly login: string;
  readonly scopes: ReadonlyArray<string>;
  readonly fineGrained: boolean;
  readonly expiresAt: string | null;
}

/** Asks GitHub who a token signs in as. Null when GitHub refuses it or cannot be reached. */
export async function inspectGitHubToken(
  fetcher: typeof fetch,
  token: string,
): Promise<TokenFacts | null> {
  try {
    const response = await fetcher("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "SpecWithCode",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await response.json()) as { login?: unknown };
    if (typeof body.login !== "string" || body.login.trim() === "") return null;
    const scopesHeader = response.headers.get("x-oauth-scopes");
    // Classic and OAuth tokens list their scopes; fine-grained tokens send no such header.
    const scopes = (scopesHeader ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean)
      .slice(0, 50);
    const expiry = response.headers.get("github-authentication-token-expiration")?.trim();
    return {
      login: body.login.trim().slice(0, 255),
      scopes,
      fineGrained: scopesHeader === null,
      expiresAt: expiry ? expiry.slice(0, 64) : null,
    };
  } catch {
    return null;
  }
}

export interface CopySourceDeps {
  /** github.com is on in this machine's Settings; when off, nothing is read or sent. */
  readonly hostEnabled: boolean;
  readonly savedToken: () => Promise<string | null>;
  /** `gh auth token --hostname github.com`, or null when gh has none. */
  readonly ghToken: () => Promise<string | null>;
  readonly fetch: typeof fetch;
  readonly machines: () => Promise<ReadonlyArray<FleetTarget>>;
  /** Posts to the destination with its management token; resolves to the HTTP status. */
  readonly send: (
    target: CopyTarget,
    body: {
      readonly token: string;
      readonly login: string;
      readonly from: string;
      readonly replace: boolean;
    },
  ) => Promise<{ readonly status: number; readonly copiedAt: string | null }>;
  readonly sourceLabel: string;
}

export type CopyTarget = Pick<FleetTarget, "id" | "url" | "environmentId" | "label"> & {
  readonly managementToken: string;
};

/** The destination as a tailnet-only target: a token never goes over a Connect address. */
export function tailnetTarget(machine: FleetTarget): CopyTarget | "no-link" | "connect-only" {
  if (!machine.managementToken) return "no-link";
  if (parseFleetOrigin(machine.url)?.transport !== "tailnet") return "connect-only";
  return {
    id: machine.id,
    url: machine.url,
    environmentId: machine.environmentId,
    label: machine.label,
    managementToken: machine.managementToken,
  };
}

async function sourceToken(deps: CopySourceDeps) {
  const saved = (await deps.savedToken().catch(() => null))?.trim();
  if (saved) return { token: saved, source: "saved" as const };
  const gh = (await deps.ghToken().catch(() => null))?.trim();
  return gh ? { token: gh, source: "gh" as const } : null;
}

async function findTarget(deps: CopySourceDeps, environmentId: string) {
  const machines = await deps.machines().catch(() => []);
  const machine = machines.find((entry) => entry.environmentId === environmentId);
  return machine ? tailnetTarget(machine) : ("no-link" as const);
}

const UNAVAILABLE = {
  "no-token": (source: string) =>
    `${source} has no GitHub sign-in to copy. Sign in on ${source} first, or use a code instead.`,
  "host-off": (source: string) =>
    `GitHub (github.com) is turned off in ${source}'s Settings, so its sign-in is not copied. Turn it on in Source Control, or use a code instead.`,
  unverified: (source: string) =>
    `GitHub did not accept ${source}'s sign-in. Sign in again on ${source}, or use a code instead.`,
  "no-link": (source: string) =>
    `${source} has no management link to that machine, so it cannot copy its sign-in there. Use a code instead.`,
  "connect-only": (source: string) =>
    `${source} reaches that machine only through SpecWithCode Connect, and a GitHub sign-in is copied over the tailnet only. Use a code instead.`,
} as const;

export async function previewCopy(
  deps: CopySourceDeps,
  targetEnvironmentId: string,
): Promise<GitHubCredentialCopyPreview> {
  const empty = {
    login: null,
    scopes: [],
    fineGrained: false,
    expiresAt: null,
    source: null,
    sourceLabel: deps.sourceLabel,
  };
  const unavailable = (reason: keyof typeof UNAVAILABLE) => ({
    ...empty,
    available: false,
    reason,
    message: UNAVAILABLE[reason](deps.sourceLabel),
  });
  if (!deps.hostEnabled) return unavailable("host-off");
  const target = await findTarget(deps, targetEnvironmentId);
  if (typeof target === "string") return unavailable(target);
  const found = await sourceToken(deps);
  if (!found) return unavailable("no-token");
  const facts = await inspectGitHubToken(deps.fetch, found.token);
  if (!facts) return unavailable("unverified");
  return {
    ...empty,
    available: true,
    reason: null,
    message: null,
    login: facts.login,
    scopes: [...facts.scopes],
    fineGrained: facts.fineGrained,
    expiresAt: facts.expiresAt,
    source: found.source,
  };
}

export async function copyCredential(
  deps: CopySourceDeps,
  targetEnvironmentId: string,
  options: { readonly replaceSaved?: boolean } = {},
): Promise<GitHubCredentialCopyResult> {
  if (!deps.hostEnabled)
    throw new GitHubCredentialCopyFailure(UNAVAILABLE["host-off"](deps.sourceLabel));
  const target = await findTarget(deps, targetEnvironmentId);
  if (typeof target === "string")
    throw new GitHubCredentialCopyFailure(UNAVAILABLE[target](deps.sourceLabel));
  const found = await sourceToken(deps);
  if (!found) throw new GitHubCredentialCopyFailure(UNAVAILABLE["no-token"](deps.sourceLabel));
  const facts = await inspectGitHubToken(deps.fetch, found.token);
  if (!facts) throw new GitHubCredentialCopyFailure(UNAVAILABLE.unverified(deps.sourceLabel));
  const reply = await deps
    .send(target, {
      token: found.token,
      login: facts.login,
      from: deps.sourceLabel,
      replace: options.replaceSaved === true,
    })
    .catch(() => null);
  if (reply === null)
    throw new GitHubCredentialCopyFailure(`${target.label} did not answer over the tailnet.`);
  if (reply.status === 401 || reply.status === 403)
    throw new GitHubCredentialCopyFailure(
      `${deps.sourceLabel}'s link to ${target.label} may not change its settings. Use a code instead.`,
    );
  if (reply.status === 409)
    throw new GitHubCredentialCopyFailure(
      `${target.label} uses a GitHub token saved in its Settings. Choose to replace it to use ${deps.sourceLabel}'s sign-in instead.`,
    );
  if (reply.status === 404)
    throw new GitHubCredentialCopyFailure(
      `${target.label} runs an older SpecWithCode that cannot receive a sign-in. Update it, or use a code instead.`,
    );
  if (reply.status < 200 || reply.status >= 300 || reply.copiedAt === null)
    throw new GitHubCredentialCopyFailure(`${target.label} could not store the sign-in.`);
  return { login: facts.login, copiedAt: reply.copiedAt };
}

/** The settings patch that stores a copied token and its note, replacing any earlier note. */
export function storeCopiedTokenPatch(
  current: GitHubSettings,
  input: {
    readonly token: string;
    readonly login: string;
    readonly from: string;
    readonly at: string;
    /** A token saved by hand was set aside, so Remove restores it. */
    readonly replacedSaved: boolean;
  },
): ServerSettingsPatch {
  return {
    github: {
      tokens: { [GITHUB_HOST]: input.token },
      copiedTokens: {
        ...current.copiedTokens,
        [GITHUB_HOST]: {
          from: input.from,
          at: input.at,
          login: input.login,
          fingerprint: tokenFingerprint(input.token),
          ...(input.replacedSaved ? { replacedSaved: true } : {}),
        },
      },
    },
  };
}

/**
 * Removes only what a copy stored: the saved token when it is still the copied one, and the
 * note. A token saved by hand that the copy replaced (`previous`) comes back; one saved by
 * hand afterwards stays. gh's logins are never touched.
 */
export function removeCopiedTokenPatch(
  current: GitHubSettings,
  previous: string | null = null,
): ServerSettingsPatch | null {
  if (current.copiedTokens[GITHUB_HOST] === undefined) return null;
  const { [GITHUB_HOST]: _removed, ...rest } = current.copiedTokens;
  return {
    github: {
      ...(copiedNote(current) ? { tokens: { [GITHUB_HOST]: previous?.trim() ?? "" } } : {}),
      copiedTokens: rest,
    },
  };
}

/** Where a token saved by hand waits while a copy replaces it. */
export const REPLACED_TOKEN_SECRET = "github-replaced-token-github-com";
