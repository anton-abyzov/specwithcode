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
  it("reads the thread's registered worktree", async () => {
    const worktree = folder();
    const resolved = await resolveCallerWorkspace({ worktreePath: worktree });
    expect(resolved).toEqual({ ok: true, workspace: worktree, specweaveRoot: worktree });
  });

  it("refuses a thread without a worktree of its own", async () => {
    expect(await resolveCallerWorkspace({ worktreePath: null })).toMatchObject({
      ok: false,
      reason: "no-worktree",
    });
    expect(await workspaceHasSpecweave({ worktreePath: null })).toBe(false);
  });

  it("refuses a recorded worktree that is missing instead of falling back to the project", async () => {
    const project = folder();
    const resolved = await resolveCallerWorkspace({ worktreePath: NodePath.join(project, "gone") });
    expect(resolved).toMatchObject({ ok: false, reason: "no-worktree" });
    expect(await workspaceHasSpecweave({ worktreePath: NodePath.join(project, "gone") })).toBe(
      false,
    );
  });

  it("refuses a folder outside the workspace, by .. or by a link", async () => {
    const worktree = folder();
    const outside = folder();
    expect(await resolveCallerWorkspace({ worktreePath: worktree, folder: ".." })).toMatchObject({
      ok: false,
      reason: "outside",
    });
    expect(await resolveCallerWorkspace({ worktreePath: worktree, folder: outside })).toMatchObject(
      {
        ok: false,
        reason: "outside",
      },
    );
    NodeFS.symlinkSync(outside, NodePath.join(worktree, "link"));
    expect(await resolveCallerWorkspace({ worktreePath: worktree, folder: "link" })).toMatchObject({
      ok: false,
      reason: "outside",
    });
  });

  it("accepts a nested folder that holds .specweave/", async () => {
    const worktree = folder(false);
    NodeFS.mkdirSync(NodePath.join(worktree, "repo", ".specweave"), { recursive: true });
    expect(await resolveCallerWorkspace({ worktreePath: worktree, folder: "repo" })).toMatchObject({
      ok: true,
      workspace: worktree,
      specweaveRoot: NodePath.join(worktree, "repo"),
    });
    // The workspace itself has none, so the tools are not offered there.
    expect(await workspaceHasSpecweave({ worktreePath: worktree })).toBe(false);
  });

  it("refuses a worktree without .specweave/", async () => {
    expect(await resolveCallerWorkspace({ worktreePath: folder(false) })).toMatchObject({
      ok: false,
      reason: "no-specweave",
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
