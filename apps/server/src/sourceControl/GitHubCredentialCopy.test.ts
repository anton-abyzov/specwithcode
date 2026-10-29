import type { EnvironmentId, GitHubSettings } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FleetTarget } from "../studioFleet.ts";
import {
  copyCredential,
  inspectGitHubToken,
  previewCopy,
  removeCopiedTokenPatch,
  storeCopiedTokenPatch,
  type CopySourceDeps,
} from "./GitHubCredentialCopy.ts";
import {
  helperName,
  readGitHubCredentialState,
  type CommandResult,
  type GitHubCredentialProbe,
} from "./gitHubCredentialState.ts";

const TOKEN = "gho_SECRETsecretSECRET0123456789";
const OTHER_TOKEN = "github_pat_HANDSAVED_0123456789";

const settingsOf = (patch: Partial<GitHubSettings> = {}): GitHubSettings => ({
  hosts: {},
  tokens: {},
  copiedTokens: {},
  copyHostSignIn: true,
  confirmCopySignIn: true,
  ...patch,
});

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, missing: false });
const ghStatus = (
  accounts: ReadonlyArray<{ login: string; active?: boolean; tokenSource?: string }>,
) =>
  JSON.stringify({
    hosts: {
      "github.com": accounts.map((account) => ({
        state: "success",
        active: account.active ?? true,
        host: "github.com",
        login: account.login,
        tokenSource: account.tokenSource ?? "keyring",
      })),
    },
  });
const probe = (
  status: string,
  helpers = "osxkeychain\n!/opt/homebrew/bin/gh auth git-credential\n!f() { echo password=hunter2; }; f\n",
): GitHubCredentialProbe => ({
  ghVersion: async () => ok("gh version 2.88.1 (2026-03-12)\n"),
  ghAuthStatus: async () => ok(status),
  gitConfig: async (args) =>
    args.includes("--get-all") ? ok(helpers) : ok("credential.https://github.com.helper\n"),
});

/** Plays the destination server: records what arrived and answers like the route. */
function makeSource(overrides: Partial<CopySourceDeps> = {}) {
  const sent: Array<{ target: unknown; body: unknown }> = [];
  const machines: Array<FleetTarget> = [
    {
      id: "ministorm",
      label: "ministorm",
      environmentId: "env-ministorm" as EnvironmentId,
      url: "https://ministorm.tail1234.ts.net",
      connectUrl: "https://ministorm-0123456789abcdef.connect.example",
      managementToken: "mgmt-token",
      scopes: {} as never,
    },
    {
      id: "faraway",
      label: "faraway",
      environmentId: "env-faraway" as EnvironmentId,
      url: "https://faraway-0123456789abcdef.connect.example",
      managementToken: "mgmt-token",
      scopes: {} as never,
    },
  ];
  const deps: CopySourceDeps = {
    hostEnabled: true,
    savedToken: async () => null,
    ghToken: async () => TOKEN,
    fetch: (async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === `Bearer ${TOKEN}` || auth === `Bearer ${OTHER_TOKEN}`
        ? new Response(JSON.stringify({ login: "octo" }), {
            headers: { "x-oauth-scopes": "repo, read:org, gist, workflow" },
          })
        : new Response("{}", { status: 401 });
    }) as typeof fetch,
    machines: async () => machines,
    send: async (target, body) => {
      sent.push({ target, body });
      return { status: 200, copiedAt: "2026-10-27T10:00:00.000Z" };
    },
    sourceLabel: "M4",
    ...overrides,
  };
  return { deps, sent };
}

describe("readGitHubCredentialState", () => {
  it("shows a worker already signed in to gh, and that SpecWithCode uses that login", async () => {
    const state = await readGitHubCredentialState({
      probe: probe(ghStatus([{ login: "octo" }])),
      env: {},
      settings: settingsOf(),
    });
    expect(state).toMatchObject({
      gh: { installed: true, version: "2.88.1", outdated: false },
      ghAccounts: [{ login: "octo", active: true, authenticated: true }],
      environmentVariables: [],
      saved: null,
      gitHubCredentialHelper: true,
      inUse: { source: "gh", login: "octo" },
    });
    // Helper names only: an inline helper's script, and the password in it, never appear.
    expect(state.credentialHelpers).toEqual(["osxkeychain", "gh", "custom command"]);
    expect(JSON.stringify(state)).not.toContain("hunter2");
  });

  it("names a copied token as what SpecWithCode uses, beside a different gh login", async () => {
    const copied = settingsOf({ tokens: { "github.com": TOKEN } });
    const settings = settingsOf({
      tokens: { "github.com": TOKEN },
      copiedTokens: (
        storeCopiedTokenPatch(copied, {
          token: TOKEN,
          login: "octo",
          from: "M4",
          at: "2026-10-27T10:00:00.000Z",
          replacedSaved: false,
        }).github as { copiedTokens: GitHubSettings["copiedTokens"] }
      ).copiedTokens,
    });
    const state = await readGitHubCredentialState({
      probe: probe(ghStatus([{ login: "work-account" }])),
      env: {},
      settings,
    });
    expect(state.ghAccounts.map((account) => account.login)).toEqual(["work-account"]);
    expect(state.saved).toEqual({
      copiedFrom: "M4",
      copiedAt: "2026-10-27T10:00:00.000Z",
      login: "octo",
    });
    expect(state.inUse).toEqual({ source: "copied", login: "octo" });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  it("reports a token variable by name, as gh does, ahead of gh's stored login", async () => {
    const state = await readGitHubCredentialState({
      probe: probe(
        ghStatus([
          { login: "bot", tokenSource: "GH_TOKEN" },
          { login: "octo", active: false },
        ]),
      ),
      env: { GH_TOKEN: TOKEN, PATH: "/usr/bin" },
      settings: settingsOf(),
    });
    expect(state.environmentVariables).toEqual(["GH_TOKEN"]);
    expect(state.ghAccounts.map((account) => account.login)).toEqual(["octo"]);
    expect(state.inUse).toEqual({ source: "env", login: "bot" });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  it("treats a token saved by hand after a copy as saved, not copied", async () => {
    const note = (
      storeCopiedTokenPatch(settingsOf(), {
        token: TOKEN,
        login: "octo",
        from: "M4",
        at: "2026-10-27T10:00:00.000Z",
        replacedSaved: false,
      }).github as { copiedTokens: GitHubSettings["copiedTokens"] }
    ).copiedTokens;
    const state = await readGitHubCredentialState({
      probe: probe(ghStatus([])),
      env: {},
      settings: settingsOf({ tokens: { "github.com": OTHER_TOKEN }, copiedTokens: note }),
    });
    expect(state.inUse).toEqual({ source: "saved", login: null });
    expect(state.saved?.copiedFrom).toBeNull();
  });

  it("reports a missing gh without failing", async () => {
    const state = await readGitHubCredentialState({
      probe: {
        ghVersion: async () => ({ code: null, stdout: "", missing: true }),
        ghAuthStatus: async () => ({ code: null, stdout: "", missing: true }),
        gitConfig: async () => ({ code: 1, stdout: "", missing: false }),
      },
      env: {},
      settings: settingsOf(),
    });
    expect(state.gh).toEqual({ installed: false, version: null, outdated: false });
    expect(state.inUse).toBeNull();
  });

  it("keeps helper names safe", () => {
    expect(helperName("store --file ~/.git-credentials")).toBe("store");
    expect(helperName("")).toBeNull();
    expect(helperName("!f() { echo password=x; }; f")).toBe("custom command");
  });
});

describe("previewCopy", () => {
  it("names the account, scopes and expiry without the token", async () => {
    const { deps } = makeSource();
    const preview = await previewCopy(deps, "env-ministorm");
    expect(preview).toEqual({
      available: true,
      reason: null,
      message: null,
      login: "octo",
      scopes: ["repo", "read:org", "gist", "workflow"],
      fineGrained: false,
      expiresAt: null,
      source: "gh",
      sourceLabel: "M4",
    });
    expect(JSON.stringify(preview)).not.toContain(TOKEN);
  });

  it("prefers a token saved in Settings over gh's", async () => {
    const { deps } = makeSource({ savedToken: async () => OTHER_TOKEN });
    expect((await previewCopy(deps, "env-ministorm")).source).toBe("saved");
  });

  it("says clearly when this machine has no sign-in to copy", async () => {
    const { deps } = makeSource({ ghToken: async () => null });
    expect(await previewCopy(deps, "env-ministorm")).toMatchObject({
      available: false,
      reason: "no-token",
      message: "M4 has no GitHub sign-in to copy. Sign in on M4 first, or use a code instead.",
    });
  });

  it("refuses a machine reachable only through Connect, and one without a link", async () => {
    const { deps } = makeSource();
    expect((await previewCopy(deps, "env-faraway")).reason).toBe("connect-only");
    expect((await previewCopy(deps, "env-unknown")).reason).toBe("no-link");
  });

  it("reports a token GitHub refuses", async () => {
    const { deps } = makeSource({ ghToken: async () => "gho_revoked" });
    expect((await previewCopy(deps, "env-ministorm")).reason).toBe("unverified");
  });
});

describe("copyCredential", () => {
  it("sends the token only to the destination's tailnet address and returns the login", async () => {
    const { deps, sent } = makeSource();
    const result = await copyCredential(deps, "env-ministorm");
    expect(result).toEqual({ login: "octo", copiedAt: "2026-10-27T10:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(sent).toHaveLength(1);
    const target = sent[0]!.target as Record<string, unknown>;
    expect(target.url).toBe("https://ministorm.tail1234.ts.net");
    expect(target).not.toHaveProperty("connectUrl");
    expect(sent[0]!.body).toEqual({ token: TOKEN, login: "octo", from: "M4", replace: false });
  });

  it("explains a refused or old destination without the token in the error", async () => {
    for (const [status, text] of [
      [403, "may not change its settings"],
      [404, "older SpecWithCode"],
      [409, "Choose to replace it"],
      [500, "could not store the sign-in"],
    ] as const) {
      const { deps } = makeSource({ send: async () => ({ status, copiedAt: null }) });
      const failure = await copyCredential(deps, "env-ministorm").catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(text);
      expect((failure as Error).message).not.toContain(TOKEN);
    }
  });

  it("copies nothing when github.com is turned off on this machine", async () => {
    const { deps, sent } = makeSource({
      hostEnabled: false,
      savedToken: async () => TOKEN,
    });
    expect(await previewCopy(deps, "env-ministorm")).toMatchObject({
      available: false,
      reason: "host-off",
    });
    await expect(copyCredential(deps, "env-ministorm")).rejects.toThrow("turned off");
    expect(sent).toHaveLength(0);
  });

  it("asks the destination to replace a token saved there only when told to", async () => {
    const { deps, sent } = makeSource();
    await copyCredential(deps, "env-ministorm", { replaceSaved: true });
    expect(sent[0]!.body).toMatchObject({ replace: true });
  });

  it("sends nothing when there is no token or no tailnet link", async () => {
    const { deps, sent } = makeSource({ ghToken: async () => null });
    await expect(copyCredential(deps, "env-ministorm")).rejects.toThrow("no GitHub sign-in");
    await expect(copyCredential(makeSource().deps, "env-faraway")).rejects.toThrow("tailnet");
    expect(sent).toHaveLength(0);
  });
});

describe("removing a copied sign-in", () => {
  const copied = (token: string) =>
    settingsOf({
      tokens: { "github.com": token },
      copiedTokens: (
        storeCopiedTokenPatch(settingsOf(), {
          token: TOKEN,
          login: "octo",
          from: "M4",
          at: "2026-10-27T10:00:00.000Z",
          replacedSaved: false,
        }).github as { copiedTokens: GitHubSettings["copiedTokens"] }
      ).copiedTokens,
      hosts: { "github.com": { enabled: true, account: "work-account" } },
    });

  it("deletes only the copied token and its note, never gh's login or host choices", async () => {
    const patch = removeCopiedTokenPatch(copied(TOKEN));
    expect(patch).toEqual({ github: { tokens: { "github.com": "" }, copiedTokens: {} } });
    expect(patch?.github).not.toHaveProperty("hosts");
    // gh still reports its own login afterwards: nothing here runs gh.
    const state = await readGitHubCredentialState({
      probe: probe(ghStatus([{ login: "work-account" }])),
      env: {},
      settings: settingsOf({ hosts: { "github.com": { enabled: true, account: "work-account" } } }),
    });
    expect(state.inUse).toEqual({ source: "gh", login: "work-account" });
  });

  it("brings back the token saved by hand that the copy replaced", () => {
    expect(removeCopiedTokenPatch(copied(TOKEN), OTHER_TOKEN)).toEqual({
      github: { tokens: { "github.com": OTHER_TOKEN }, copiedTokens: {} },
    });
  });

  it("keeps a token saved by hand after the copy", () => {
    expect(removeCopiedTokenPatch(copied(OTHER_TOKEN))).toEqual({
      github: { copiedTokens: {} },
    });
  });

  it("does nothing when nothing was copied", () => {
    expect(
      removeCopiedTokenPatch(settingsOf({ tokens: { "github.com": OTHER_TOKEN } })),
    ).toBeNull();
  });
});

describe("inspectGitHubToken", () => {
  it("reads a fine-grained token's expiry and marks it fine-grained", async () => {
    const facts = await inspectGitHubToken(
      (async () =>
        new Response(JSON.stringify({ login: "octo" }), {
          headers: { "github-authentication-token-expiration": "2027-01-01 00:00:00 UTC" },
        })) as unknown as typeof fetch,
      OTHER_TOKEN,
    );
    expect(facts).toEqual({
      login: "octo",
      scopes: [],
      fineGrained: true,
      expiresAt: "2027-01-01 00:00:00 UTC",
    });
  });
});
