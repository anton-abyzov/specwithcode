// @effect-diagnostics nodeBuiltinImport:off - Scratch folders, links and real paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { isInside, resolveCallerWorkspace, workspaceHasSpecweave } from "./workspace.ts";

const made: Array<string> = [];
const folder = (withSpecweave = true) => {
  const path = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-ws-")));
  if (withSpecweave) NodeFS.mkdirSync(NodePath.join(path, ".specweave"));
  made.push(path);
  return path;
};
afterEach(() => {
  for (const path of made.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

describe("resolveCallerWorkspace", () => {
  it("runs in the thread's worktree, never the project folder, when it has one", async () => {
    const project = folder();
    const worktree = folder();
    const resolved = await resolveCallerWorkspace({ worktreePath: worktree, projectRoot: project });
    expect(resolved).toEqual({
      ok: true,
      workspace: worktree,
      specweaveRoot: worktree,
      kind: "worktree",
    });
  });

  it("uses the project folder for a thread without a worktree", async () => {
    const project = folder();
    const resolved = await resolveCallerWorkspace({ worktreePath: null, projectRoot: project });
    expect(resolved).toMatchObject({ ok: true, workspace: project, kind: "project" });
  });

  it("refuses a recorded worktree that is missing instead of falling back to the project", async () => {
    const project = folder();
    const resolved = await resolveCallerWorkspace({
      worktreePath: NodePath.join(project, "gone"),
      projectRoot: project,
    });
    expect(resolved).toMatchObject({ ok: false, reason: "no-workspace" });
    expect(
      await workspaceHasSpecweave({
        worktreePath: NodePath.join(project, "gone"),
        projectRoot: project,
      }),
    ).toBe(false);
  });

  it("refuses a folder outside the workspace, by .. or by a link", async () => {
    const worktree = folder();
    const outside = folder();
    expect(
      await resolveCallerWorkspace({ worktreePath: worktree, projectRoot: null, folder: ".." }),
    ).toMatchObject({
      ok: false,
      reason: "outside",
    });
    expect(
      await resolveCallerWorkspace({ worktreePath: worktree, projectRoot: null, folder: outside }),
    ).toMatchObject({
      ok: false,
      reason: "outside",
    });
    NodeFS.symlinkSync(outside, NodePath.join(worktree, "link"));
    expect(
      await resolveCallerWorkspace({ worktreePath: worktree, projectRoot: null, folder: "link" }),
    ).toMatchObject({
      ok: false,
      reason: "outside",
    });
  });

  it("accepts a nested folder that holds .specweave/", async () => {
    const worktree = folder(false);
    NodeFS.mkdirSync(NodePath.join(worktree, "repo", ".specweave"), { recursive: true });
    expect(
      await resolveCallerWorkspace({ worktreePath: worktree, projectRoot: null, folder: "repo" }),
    ).toMatchObject({
      ok: true,
      workspace: worktree,
      specweaveRoot: NodePath.join(worktree, "repo"),
    });
    // The workspace itself has none, so the tools are not offered there.
    expect(await workspaceHasSpecweave({ worktreePath: worktree, projectRoot: null })).toBe(false);
  });

  it("refuses a workspace without .specweave/ and a thread with no folder here", async () => {
    expect(
      await resolveCallerWorkspace({ worktreePath: folder(false), projectRoot: null }),
    ).toMatchObject({
      ok: false,
      reason: "no-specweave",
    });
    expect(await resolveCallerWorkspace({ worktreePath: null, projectRoot: null })).toMatchObject({
      ok: false,
      reason: "no-workspace",
    });
  });
});

describe("isInside", () => {
  it("treats the folder itself and its children as inside, siblings as outside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});
