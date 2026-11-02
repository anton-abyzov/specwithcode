// @effect-diagnostics nodeBuiltinImport:off - expected paths use this platform's separator.
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { makeFirstPassOfRun, quietRepeatedSkips, threadFolders } from "./ProjectRepositorySync.ts";

const skipped = {
  title: "Skipped repositories",
  message: "Skipped a: on fix/x, not main.",
  skipped: "Skipped a: on fix/x, not main.",
};

it("tells a project about the same skips once an hour", () => {
  const project = "project-quiet";
  expect(quietRepeatedSkips(project, skipped, 1_000)).toEqual(skipped);
  expect(quietRepeatedSkips(project, skipped, 2_000)).toBeNull();
  expect(quietRepeatedSkips(project, skipped, 1_000 + 60 * 60 * 1000)).toEqual(skipped);
});

it("still reports updates when only the skips repeat", () => {
  const project = "project-updates";
  quietRepeatedSkips(project, skipped, 1_000);
  const both = {
    title: "Updated repositories",
    message: `Updated from origin: b.\n${skipped.message}`,
    skipped: skipped.skipped,
  };
  expect(quietRepeatedSkips(project, both, 2_000)?.message).toBe("Updated from origin: b.");
});

it("tells again as soon as what was skipped changes", () => {
  const project = "project-changes";
  quietRepeatedSkips(project, skipped, 1_000);
  const other = { ...skipped, message: "Skipped b: x.", skipped: "Skipped b: x." };
  expect(quietRepeatedSkips(project, other, 2_000)).toEqual(other);
});

it("counts a running thread's saved repositories as in use", () => {
  const project = {
    workspaceRoot: "/work/app",
    workspaceSettings: {
      environment: {
        additionalFolders: ["/work/y"],
        repositories: [
          { id: "m", localPath: null },
          { id: "x", localPath: "/work/x" },
        ],
      },
    },
  } as never;
  expect(threadFolders(null, project)).toEqual([
    "/work/app",
    "/work/y",
    NodePath.join("/work/app", ".studio-repositories", "m"),
    "/work/x",
  ]);
  expect(threadFolders("/trees/a", project)).toEqual([
    "/trees/a",
    "/work/y",
    NodePath.join("/work/app", ".studio-repositories", "m"),
    "/work/x",
  ]);
  expect(threadFolders("/trees/a", null)).toEqual(["/trees/a"]);
});

it("syncs a run once across prepare, start and retries", () => {
  const firstPass = makeFirstPassOfRun();
  expect(firstPass("run-1")).toBe(true);
  expect(firstPass("run-1")).toBe(false);
  expect(firstPass("run-2")).toBe(true);
});
