import { describe, expect, it } from "vite-plus/test";

import { copyRepositoryText, summarizeCopyRepositories } from "./projectRepositories";

const repo = (path: string, name: string) => ({
  path,
  name,
  key: `github.com/${name}`,
  remoteUrl: `git@github.com:${name}.git`,
});
const api = repo("repositories/acme/api", "acme/api");
const web = repo("apps/web", "acme/web");

describe("copyRepositoryText", () => {
  it("says the copy has everything when every checkout is there", () => {
    const summary = summarizeCopyRepositories(
      [api, web],
      [
        { path: api.path, status: "present", detail: null },
        { path: web.path, status: "present", detail: null },
      ],
    );
    expect(copyRepositoryText(summary)).toBe("Has all 2 of the project's repositories.");
  });

  it("names missing checkouts and what is in the way of the others", () => {
    const summary = summarizeCopyRepositories(
      [api, web, repo("tools/cli", "acme/cli")],
      [
        { path: api.path, status: "missing", detail: null },
        { path: web.path, status: "different", detail: "The checkout there is other/web." },
        { path: "tools/cli", status: "cloned", detail: null },
      ],
    );
    expect(copyRepositoryText(summary)).toBe(
      "Cloned acme/cli. Missing acme/api. A worker there clones it when its task needs it, or clone it now. acme/web: The checkout there is other/web.",
    );
  });

  it("tells two checkouts of one repository apart by folder", () => {
    const summary = summarizeCopyRepositories(
      [api, { ...api, path: "old/api" }],
      [
        { path: api.path, status: "missing", detail: null },
        { path: "old/api", status: "missing", detail: null },
      ],
    );
    expect(summary.missing).toEqual(["acme/api (repositories/acme/api)", "acme/api (old/api)"]);
  });
});
