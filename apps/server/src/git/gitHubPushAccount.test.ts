import { describe, expect, it } from "@effect/vitest";

import {
  hasGitHubCredentialHelper,
  ownerLogin,
  parseGitHubHttpsRemote,
  pushAuthFixHint,
} from "./gitHubPushAccount.ts";

describe("parseGitHubHttpsRemote", () => {
  it("reads host and owner from https GitHub remotes", () => {
    expect(parseGitHubHttpsRemote("https://github.com/anton-abyzov/specweave-umb.git")).toEqual({
      host: "github.com",
      owner: "anton-abyzov",
    });
    expect(parseGitHubHttpsRemote("https://acme.ghe.com/Acme/repo")).toEqual({
      host: "acme.ghe.com",
      owner: "Acme",
    });
  });

  it("rejects SSH, other hosts and malformed values", () => {
    expect(parseGitHubHttpsRemote("git@github.com:anton-abyzov/repo.git")).toBeNull();
    expect(parseGitHubHttpsRemote("ssh://git@github.com/anton-abyzov/repo.git")).toBeNull();
    expect(parseGitHubHttpsRemote("https://gitlab.com/anton-abyzov/repo.git")).toBeNull();
    expect(parseGitHubHttpsRemote("https://github.com/anton-abyzov")).toBeNull();
    expect(parseGitHubHttpsRemote("not a url")).toBeNull();
    expect(parseGitHubHttpsRemote(null)).toBeNull();
  });
});

describe("pushAuthFixHint", () => {
  const logins = [
    { login: "abycrash", active: true },
    { login: "anton-abyzov", active: false },
  ];

  it("names the refused login and the owner-named one", () => {
    const hint = pushAuthFixHint({
      owner: "anton-abyzov",
      logins,
      hasCredentialHelper: true,
    });
    expect(hint).toContain('gh login "abycrash"');
    expect(hint).toContain('"anton-abyzov"');
    expect(hint).not.toContain("gh auth switch");
  });

  it("says to sign in when no login matches the owner", () => {
    const hint = pushAuthFixHint({
      owner: "some-org",
      logins,
      hasCredentialHelper: true,
    });
    expect(hint).toContain("gh auth login");
  });

  it("says to set up git when no credential helper is configured", () => {
    const hint = pushAuthFixHint({
      owner: "anton-abyzov",
      logins,
      hasCredentialHelper: false,
    });
    expect(hint).toContain("gh auth setup-git");
  });

  it("matches the owner case-insensitively in gh's spelling", () => {
    expect(ownerLogin(logins, "ANTON-ABYZOV")?.login).toBe("anton-abyzov");
  });
});

describe("hasGitHubCredentialHelper", () => {
  it("needs one non-empty value", () => {
    expect(hasGitHubCredentialHelper([null, ""])).toBe(false);
    expect(hasGitHubCredentialHelper([null, "!gh auth git-credential"])).toBe(true);
  });
});
