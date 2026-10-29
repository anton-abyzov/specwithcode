import type {
  GitHubCredentialCopyPreview,
  GitHubCredentialState,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeToken, planGitHubCredential } from "./GitHubCredentialCard.logic";

const state = (patch: Partial<GitHubCredentialState> = {}): GitHubCredentialState => ({
  host: "github.com",
  hostEnabled: true,
  gh: { installed: true, version: "2.88.1", outdated: false },
  ghAccounts: [],
  environmentVariables: [],
  saved: null,
  credentialHelpers: [],
  gitHubCredentialHelper: false,
  inUse: null,
  ...patch,
});
const preview = (
  patch: Partial<GitHubCredentialCopyPreview> = {},
): GitHubCredentialCopyPreview => ({
  available: true,
  reason: null,
  message: null,
  login: "octo",
  scopes: ["repo", "read:org"],
  fineGrained: false,
  expiresAt: null,
  source: "gh",
  sourceLabel: "M4",
  ...patch,
});
const plan = (
  input: Partial<Parameters<typeof planGitHubCredential>[0]> & { state?: GitHubCredentialState },
) =>
  planGitHubCredential({
    state: state(),
    copySupported: true,
    preview: preview(),
    copyByDefault: true,
    deviceCodeSupported: true,
    ...input,
  });

describe("planGitHubCredential", () => {
  it("copies by default on a machine with no login, with a code as the other way", () => {
    expect(plan({})).toMatchObject({ copy: "primary", deviceCode: "secondary" });
  });

  it("puts the code first when the setting is off", () => {
    expect(plan({ copyByDefault: false })).toMatchObject({
      copy: "secondary",
      deviceCode: "primary",
    });
  });

  it("falls back to the code when this machine has no token or the other is too old", () => {
    expect(
      plan({ preview: preview({ available: false, reason: "no-token", login: null }) }),
    ).toMatchObject({ copy: "none", deviceCode: "primary" });
    expect(plan({ copySupported: false, preview: null })).toMatchObject({
      copy: "none",
      deviceCode: "primary",
    });
  });

  it("does nothing by default when the machine is already signed in as the same account", () => {
    expect(
      plan({
        state: state({
          inUse: { source: "gh", login: "octo" },
          ghAccounts: [{ login: "octo", active: true, authenticated: true }],
        }),
      }),
    ).toEqual({
      copy: "none",
      deviceCode: "none",
      sameAccount: true,
      otherGhLogin: null,
      replacesSaved: false,
    });
  });

  it("offers a different account's copy only as a secondary choice, never a code", () => {
    expect(
      plan({
        state: state({
          inUse: { source: "gh", login: "work-account" },
          ghAccounts: [{ login: "work-account", active: true, authenticated: true }],
        }),
      }),
    ).toMatchObject({ copy: "secondary", deviceCode: "none", sameAccount: false });
  });

  it("keeps a token variable in place and offers no code", () => {
    expect(
      plan({
        state: state({
          inUse: { source: "env", login: "bot" },
          environmentVariables: ["GH_TOKEN"],
        }),
      }),
    ).toMatchObject({ copy: "secondary", deviceCode: "none" });
  });

  it("never offers a code while gh holds a github.com login, even a broken one", () => {
    const broken = state({ ghAccounts: [{ login: "old", active: true, authenticated: false }] });
    expect(plan({ state: broken })).toMatchObject({ copy: "primary", deviceCode: "none" });
    expect(plan({ state: broken, copySupported: false, preview: null })).toMatchObject({
      copy: "none",
      deviceCode: "none",
    });
  });

  it("lets a copied login give way to gh's different one", () => {
    expect(
      plan({
        state: state({
          inUse: { source: "copied", login: "octo" },
          ghAccounts: [{ login: "work-account", active: true, authenticated: true }],
        }),
      }),
    ).toMatchObject({ copy: "none", otherGhLogin: "work-account" });
  });

  it("offers a copy over a token saved by hand only as a replacement, and not for its own account", () => {
    expect(
      plan({ state: state({ inUse: { source: "saved", login: "pat-owner" } }) }),
    ).toMatchObject({
      copy: "secondary",
      deviceCode: "none",
      replacesSaved: true,
    });
    expect(plan({ state: state({ inUse: { source: "saved", login: "octo" } }) })).toMatchObject({
      copy: "none",
      sameAccount: true,
    });
  });

  it("does not promise gh's login when a token variable would take over", () => {
    expect(
      plan({
        state: state({
          inUse: { source: "copied", login: "octo" },
          environmentVariables: ["GITHUB_TOKEN"],
          ghAccounts: [{ login: "work-account", active: true, authenticated: true }],
        }),
      }).otherGhLogin,
    ).toBeNull();
  });

  it("offers no code where gh is missing or too old", () => {
    expect(
      plan({ state: state({ gh: { installed: false, version: null, outdated: false } }) }),
    ).toMatchObject({ copy: "primary", deviceCode: "none" });
    expect(
      plan({
        copyByDefault: false,
        state: state({ gh: { installed: true, version: null, outdated: true } }),
      }),
    ).toMatchObject({ copy: "primary", deviceCode: "none" });
  });
});

describe("describeToken", () => {
  it("names scopes and expiry", () => {
    expect(describeToken(preview())).toBe("scopes repo, read:org; does not expire");
    expect(describeToken(preview({ fineGrained: true, scopes: [], expiresAt: "2027-01-01" }))).toBe(
      "a fine-grained token; expires 2027-01-01",
    );
  });
});
