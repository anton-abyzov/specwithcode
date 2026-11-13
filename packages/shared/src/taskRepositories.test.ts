import { describe, expect, it } from "vite-plus/test";

import {
  repositoriesNamedInTask,
  TASK_REPOSITORIES_MAX,
  taskRepositoryNames,
} from "./taskRepositories.ts";

const umbrella = [
  { relativePath: "repositories/anton-abyzov/specweave", name: "specweave" },
  { relativePath: "repositories/anton-abyzov/specwithcode", name: "specwithcode" },
  { relativePath: "repositories/anton-abyzov/specwithcode-dev", name: "specwithcode-dev" },
  { relativePath: "repositories/anton-abyzov/vskill", name: "vskill" },
  { relativePath: "repositories/anton-abyzov/vskill-platform", name: "vskill-platform" },
];
const picked = (text: string, repositories = umbrella) =>
  repositoriesNamedInTask(text, repositories).picked.map((mention) => mention.relativePath);

describe("repositoriesNamedInTask", () => {
  it("picks a repository named by a file under it, with that file as evidence", () => {
    const pick = repositoriesNamedInTask(
      "Fix the install flag in repositories/anton-abyzov/vskill/src/cli.ts.",
      umbrella,
    );
    expect(pick.picked).toEqual([
      {
        relativePath: "repositories/anton-abyzov/vskill",
        name: "vskill",
        evidence: "repositories/anton-abyzov/vskill/src/cli.ts",
      },
    ]);
  });

  it("lets the longest path win", () => {
    expect(picked("Edit repositories/anton-abyzov/specwithcode-dev/apps/web/x.ts")).toEqual([
      "repositories/anton-abyzov/specwithcode-dev",
    ]);
    expect(
      picked(
        "Files: repositories/anton-abyzov/vskill-platform/a.ts, repositories/anton-abyzov/vskill/b.ts",
      ),
    ).toEqual(["repositories/anton-abyzov/vskill-platform", "repositories/anton-abyzov/vskill"]);
  });

  it("reads absolute paths from any machine and Windows separators", () => {
    expect(
      picked("See /Users/someone/Projects/umb/repositories/anton-abyzov/specweave/src/cli.ts"),
    ).toEqual(["repositories/anton-abyzov/specweave"]);
    expect(picked("C:\\work\\umb\\repositories\\anton-abyzov\\vskill\\src\\a.ts")).toEqual([
      "repositories/anton-abyzov/vskill",
    ]);
    // A multi-segment path counts after any folder, a variable or `../`.
    expect(picked("Edit specweave-umb/repositories/anton-abyzov/vskill/a.ts")).toEqual([
      "repositories/anton-abyzov/vskill",
    ]);
    expect(picked("cd $UMB/repositories/anton-abyzov/specweave && npm test")).toEqual([
      "repositories/anton-abyzov/specweave",
    ]);
  });

  it("counts a repository path on its own, quoted or at the end of a sentence", () => {
    expect(picked("Work in repositories/anton-abyzov/vskill.")).toEqual([
      "repositories/anton-abyzov/vskill",
    ]);
    expect(picked('{"repository":"repositories/anton-abyzov/vskill"}')).toEqual([
      "repositories/anton-abyzov/vskill",
    ]);
  });

  it("never counts bare words, other files with the same stem, or URLs", () => {
    expect(picked("SpecWithCode and specweave need vskill to ship.")).toEqual([]);
    expect(picked("Compare repositories/anton-abyzov/vskill.ts")).toEqual([]);
    expect(
      picked("Review https://github.com/x/repositories/anton-abyzov/vskill/pull/12 please"),
    ).toEqual([]);
  });

  it("counts a unique name in backticks, never a shared one", () => {
    expect(picked("Bump `vskill-platform` to the new schema")).toEqual([
      "repositories/anton-abyzov/vskill-platform",
    ]);
    const twins = [
      { relativePath: "a/app", name: "app" },
      { relativePath: "b/app", name: "app" },
    ];
    expect(picked("Fix `app`", twins)).toEqual([]);
  });

  it("needs a file under, or backticks around, a one-segment path", () => {
    const nested = [
      { relativePath: "api", name: "api" },
      { relativePath: "web", name: "web" },
    ];
    expect(picked("The api is slow and the web too", nested)).toEqual([]);
    // A path inside another folder, a route, a package and a link without a scheme.
    expect(picked("In web, fix src/api/client.ts", nested)).toEqual([]);
    expect(picked("The /api/users endpoint 500s", nested)).toEqual([]);
    expect(picked("bump @acme/web/foo", nested)).toEqual([]);
    expect(picked("See github.com/acme/api/pull/12", nested)).toEqual([]);
    expect(picked("git clone git@github.com:api/tool.git", nested)).toEqual([]);
    // From the project folder, an absolute path, or an option.
    expect(picked("Run ./api/scripts/x.sh", nested)).toEqual(["api"]);
    expect(picked("Open /Users/sam/proj/web/src/a.tsx", nested)).toEqual(["web"]);
    expect(picked("pnpm --dir=api/src test", nested)).toEqual(["api"]);
    expect(picked("Fix api/src/server.ts then `web`", nested)).toEqual(["api", "web"]);
  });

  it("orders by first mention and treats a long list as an inventory", () => {
    const list = umbrella.map((repository) => `- ${repository.relativePath}`).join("\n");
    const pick = repositoriesNamedInTask(list, umbrella);
    expect(pick.named).toHaveLength(umbrella.length);
    expect(umbrella.length).toBeGreaterThan(TASK_REPOSITORIES_MAX);
    expect(pick.picked).toEqual([]);
    expect(
      picked(
        "First repositories/anton-abyzov/vskill/a.ts then repositories/anton-abyzov/specweave/b.ts",
      ),
    ).toEqual(["repositories/anton-abyzov/vskill", "repositories/anton-abyzov/specweave"]);
  });

  it("names nothing for empty text or no repositories, and never the project folder", () => {
    expect(picked("")).toEqual([]);
    expect(picked("repositories/anton-abyzov/vskill/a.ts", [])).toEqual([]);
    expect(picked("./src/a.ts", [{ relativePath: ".", name: "umb" }])).toEqual([]);
    expect(
      picked("Fix /elsewhere/site/a.ts", [{ relativePath: "/elsewhere/site", name: "site" }]),
    ).toEqual([]);
  });
});

describe("taskRepositoryNames", () => {
  const mention = (name: string) => ({ relativePath: name, name, evidence: name });
  it("joins names for a sentence", () => {
    expect(taskRepositoryNames([mention("a")])).toBe("a");
    expect(taskRepositoryNames([mention("a"), mention("b")])).toBe("a and b");
    expect(taskRepositoryNames([mention("a"), mention("b"), mention("c")])).toBe("a, b and c");
    expect(taskRepositoryNames(["a", "b", "c", "d"].map(mention))).toBe("a, b and 2 more");
  });
});
