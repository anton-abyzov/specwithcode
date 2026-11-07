import { describe, expect, it } from "vite-plus/test";

import {
  checkoutPathError,
  entryMatchesFolder,
  entryMatchesRepository,
  environmentFieldErrorCount,
  originUpdateFor,
  repositoryShortName,
  repositoryUrlError,
} from "./projectEnvironmentDraft";

const oldUrl = "https://github.com/anton-abyzov/specwithcode-dev.git";
const newUrl = "https://github.com/anton-abyzov/specwithcode.git";
const entry = { id: "repo", url: oldUrl, localPath: "/Users/me/specwithcode-dev" };

describe("checkoutPathError", () => {
  it("accepts an empty path (managed) and an absolute folder", () => {
    expect(checkoutPathError(null)).toBeNull();
    expect(checkoutPathError("")).toBeNull();
    expect(checkoutPathError("/Users/me/code")).toBeNull();
    expect(checkoutPathError("C:\\code\\repo")).toBeNull();
  });

  it("says a URL is not a folder and offers it as the repository URL", () => {
    expect(checkoutPathError(newUrl)).toEqual({
      message: "This is a folder path, not a URL.",
      url: newUrl,
    });
    expect(checkoutPathError("git@github.com:anton-abyzov/specwithcode.git")?.url).toBe(
      "git@github.com:anton-abyzov/specwithcode.git",
    );
    // A URL that could never be an entry is still flagged, without the offer.
    expect(checkoutPathError("https://user:token@github.com/a/b.git")).toEqual({
      message: "This is a folder path, not a URL.",
    });
  });

  it("asks for an absolute path", () => {
    expect(checkoutPathError("code/repo")?.message).toBe("Use an absolute folder path.");
    expect(checkoutPathError("~/code")?.message).toContain("~ is not expanded");
  });
});

describe("repositoryUrlError", () => {
  it("accepts a renamed URL for the same entry", () => {
    expect(repositoryUrlError(newUrl, [entry], "repo")).toBeNull();
  });

  it("refuses an invalid or duplicate URL", () => {
    expect(repositoryUrlError("not a url", [entry], "repo")).toContain("credential-free");
    expect(
      repositoryUrlError(newUrl, [entry, { id: "other", url: newUrl, localPath: null }], "repo"),
    ).toBe("Another entry already uses this repository.");
  });
});

describe("originUpdateFor", () => {
  it("offers the checkout's origin only for a mismatch with a different repository", () => {
    expect(originUpdateFor(entry, { status: "mismatch", origin: newUrl })).toBe(newUrl);
    expect(originUpdateFor(entry, { status: "ready" })).toBeNull();
    expect(originUpdateFor(entry, { status: "mismatch" })).toBeNull();
    expect(originUpdateFor(entry, { status: "mismatch", origin: oldUrl })).toBeNull();
    expect(originUpdateFor(entry, undefined)).toBeNull();
  });
});

describe("entry helpers", () => {
  it("counts entries that cannot be saved", () => {
    expect(
      environmentFieldErrorCount({
        additionalFolders: [],
        repositories: [entry, { ...entry, id: "typed-url", localPath: newUrl }],
      }),
    ).toBe(1);
  });

  it("matches a save error to its entry", () => {
    const repository = { kind: "repository" as const, path: newUrl, repositoryId: "repo" };
    expect(entryMatchesRepository(repository, "repo")).toBe(true);
    expect(entryMatchesRepository(repository, "other")).toBe(false);
    expect(entryMatchesFolder({ kind: "folder", path: "/a" }, "/a")).toBe(true);
  });

  it("names the repository on the update button", () => {
    expect(repositoryShortName(newUrl)).toBe("specwithcode.git");
    expect(repositoryShortName("git@github.com:org/repo.git")).toBe("repo.git");
  });
});
