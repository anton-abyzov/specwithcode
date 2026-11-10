import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { incrementRepositoryCandidates, taskFilesFrom } from "./incrementRepositories.ts";

describe("taskFilesFrom", () => {
  it("reads spec.md task rows and tasks.md Files lines", () => {
    expect(
      taskFilesFrom(
        [
          "### T-01 One",
          "- AC: AC-01 | Files: apps/web/a.tsx, `apps/server/b.ts` | Test: x",
          "### T-02 Two",
          "- AC: AC-02 | Files: none | Test: y",
          "**Files**: repositories/acme/api/src/x.ts (new), docs/y.md:12",
        ].join("\n"),
      ),
    ).toEqual([
      "apps/web/a.tsx",
      "apps/server/b.ts",
      "repositories/acme/api/src/x.ts",
      "docs/y.md",
    ]);
  });
});

describe("incrementRepositoryCandidates", () => {
  // Results are resolved for the host, so `/work` gains a drive on Windows.
  const at = (path: string) => NodePath.resolve(path);
  const checkouts = [
    { id: "app", path: "/work/root/repositories/acme/app" },
    { id: "site", path: "/work/site" },
  ];

  it("takes declared repositories as ids or paths relative to the root", () => {
    expect(
      incrementRepositoryCandidates({
        projectRoot: "/work/root",
        checkouts,
        sources: { declared: ["site", "repositories/acme/app", "."], files: ["ignored.ts"] },
        rootEntries: new Set(),
      }),
    ).toEqual([
      { path: at("/work/site"), id: "site" },
      { path: at("/work/root/repositories/acme/app"), id: "app" },
      { path: at("/work/root") },
    ]);
  });

  it("derives owners from task files when none are declared", () => {
    expect(
      incrementRepositoryCandidates({
        projectRoot: "/work/root",
        checkouts,
        sources: {
          declared: null,
          files: [
            "repositories/acme/app/src/a.ts",
            "repositories/acme/api/src/b.ts",
            "src/core/c.ts",
            "../site/index.html",
            "apps/web/d.tsx",
          ],
        },
        rootEntries: new Set(["repositories", "src"]),
      }),
    ).toEqual([
      { id: "app", path: at("/work/root/repositories/acme/app") },
      { path: at("/work/root/repositories/acme/api") },
      { path: at("/work/root") },
      { id: "site", path: at("/work/site") },
    ]);
  });
});
