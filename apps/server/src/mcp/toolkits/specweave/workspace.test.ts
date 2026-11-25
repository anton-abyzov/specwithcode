// @effect-diagnostics nodeBuiltinImport:off - Scratch folders, links and real paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { isInside, resolveCallerWorkspace, workspaceHasSpecweave } from "./workspace.ts";

const made: Array<string> = [];
/** A `.specweave/` the CLI can open: `--workspace` reads its config.json first. */
const initSpecweave = (root: string) => {
  NodeFS.mkdirSync(NodePath.join(root, ".specweave"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, ".specweave", "config.json"), "{}\n");
};
const folder = (withSpecweave = true) => {
  const path = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-ws-")));
  if (withSpecweave) initSpecweave(path);
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

  it("refuses a .specweave link that leads outside the worktree", async () => {
    const worktree = folder(false);
    const outside = folder();
    NodeFS.symlinkSync(NodePath.join(outside, ".specweave"), NodePath.join(worktree, ".specweave"));
    expect(await resolveCallerWorkspace({ worktreePath: worktree })).toMatchObject({
      ok: false,
      reason: "outside",
    });
    expect(await workspaceHasSpecweave({ worktreePath: worktree })).toBe(false);
    // A link that stays inside the worktree is fine.
    const inside = folder(false);
    NodeFS.mkdirSync(NodePath.join(inside, "real-specweave"));
    NodeFS.writeFileSync(NodePath.join(inside, "real-specweave", "config.json"), "{}\n");
    NodeFS.symlinkSync(
      NodePath.join(inside, "real-specweave"),
      NodePath.join(inside, ".specweave"),
    );
    expect(await resolveCallerWorkspace({ worktreePath: inside })).toMatchObject({ ok: true });
  });

  it("accepts a nested folder that holds .specweave/", async () => {
    const worktree = folder(false);
    initSpecweave(NodePath.join(worktree, "repo"));
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

  it("refuses a .specweave/ without config.json, which the CLI cannot open", async () => {
    const worktree = folder(false);
    NodeFS.mkdirSync(NodePath.join(worktree, ".specweave"));
    expect(await resolveCallerWorkspace({ worktreePath: worktree })).toMatchObject({
      ok: false,
      reason: "no-specweave",
    });
    expect(await workspaceHasSpecweave({ worktreePath: worktree })).toBe(false);
  });

  it("refuses a config.json link that leads outside the worktree", async () => {
    const worktree = folder(false);
    const elsewhere = folder();
    NodeFS.mkdirSync(NodePath.join(worktree, ".specweave"));
    NodeFS.symlinkSync(
      NodePath.join(elsewhere, ".specweave", "config.json"),
      NodePath.join(worktree, ".specweave", "config.json"),
    );
    expect(await resolveCallerWorkspace({ worktreePath: worktree })).toMatchObject({
      ok: false,
      reason: "no-specweave",
    });
  });

  it("accepts a child folder whose name starts with ..", async () => {
    const worktree = folder();
    initSpecweave(NodePath.join(worktree, "..cache"));
    expect(
      await resolveCallerWorkspace({ worktreePath: worktree, folder: "..cache" }),
    ).toMatchObject({
      ok: true,
      specweaveRoot: NodePath.join(worktree, "..cache"),
    });
  });
});

describe("isInside", () => {
  it("treats the folder itself and its children as inside, siblings as outside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/a/b/..c")).toBe(true);
    expect(isInside("/a/b", "/a/c")).toBe(false);
  });
});
