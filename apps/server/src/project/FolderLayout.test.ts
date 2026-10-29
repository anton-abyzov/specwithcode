// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { NESTED_DEPTH, planningImpact, readFolderLayout } from "./FolderLayout.ts";

let root = "";
const at = (...parts: string[]) => NodePath.join(root, ...parts);
const checkout = async (...parts: string[]) =>
  NodeFSP.mkdir(at(...parts, ".git"), { recursive: true });
const increments = async (folder: string, ...ids: string[]) => {
  await NodeFSP.mkdir(NodePath.join(folder, ".specweave"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(folder, ".specweave/config.json"), "{}");
  for (const id of ids)
    await NodeFSP.mkdir(NodePath.join(folder, ".specweave/increments", id), { recursive: true });
};

beforeEach(async () => {
  root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-folder-layout-")),
  );
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("readFolderLayout", () => {
  it("reads a plain single Git folder", async () => {
    await checkout("app");
    await NodeFSP.mkdir(at("app/src/deep"), { recursive: true });
    expect(await readFolderLayout(at("app"))).toEqual({
      kind: "single",
      rootIsRepository: true,
      repositories: [],
      repositoryCount: 0,
      truncated: false,
      separateClones: false,
    });
  });

  it("reads the recommended repositories/<owner>/<repo> umbrella", async () => {
    await increments(root);
    await checkout("repositories/acme/api");
    await checkout("repositories/acme/web");
    await checkout("repositories/other/tool");
    // Inside a checkout nothing more is searched, even another checkout.
    await checkout("repositories/acme/api/packages/inner");
    const layout = await readFolderLayout(root);
    expect(layout).toMatchObject({
      kind: "umbrella",
      rootIsRepository: false,
      repositoryCount: 3,
      separateClones: true,
    });
    expect(layout?.repositories).toEqual([
      "repositories/acme/api",
      "repositories/acme/web",
      "repositories/other/tool",
    ]);
  });

  it("reads nested repositories under arbitrary names, worktree .git files and inside symlinks", async () => {
    await checkout("services/billing");
    await checkout("frontend");
    await NodeFSP.mkdir(at("wt/feature"), { recursive: true });
    await NodeFSP.writeFile(at("wt/feature/.git"), "gitdir: /elsewhere/.git/worktrees/feature\n");
    await NodeFSP.symlink(at("services/billing"), at("billing-link"));
    // Skipped: dependencies, dot folders, and a symlink leaving the folder.
    await checkout("node_modules/pkg");
    await checkout(".cache/repo");
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-outside-"));
    await NodeFSP.mkdir(NodePath.join(outside, ".git"));
    await NodeFSP.symlink(outside, at("outside-link"));
    const layout = await readFolderLayout(root);
    await NodeFSP.rm(outside, { recursive: true, force: true });
    expect(layout?.kind).toBe("nested");
    // billing-link resolves to services/billing and is listed once.
    expect(layout?.repositories).toEqual(["frontend", "services/billing", "wt/feature"]);
    expect(layout?.separateClones).toBe(true);
  });

  it("does not count submodules or worktrees as separate clones", async () => {
    await checkout("");
    await NodeFSP.mkdir(at("libs/lib"), { recursive: true });
    await NodeFSP.writeFile(at("libs/lib/.git"), "gitdir: ../../.git/modules/lib\n");
    expect(await readFolderLayout(root)).toMatchObject({
      kind: "nested",
      rootIsRepository: true,
      repositories: ["libs/lib"],
      separateClones: false,
    });
  });

  it("lists a checkout once when a symlinked parent folder also reaches it", async () => {
    await checkout("repositories/acme/api");
    await NodeFSP.symlink(at("repositories"), at("alias"));
    const layout = await readFolderLayout(root);
    expect(layout?.repositories).toEqual(["repositories/acme/api"]);
    expect(layout?.kind).toBe("umbrella");
  });

  it("stops at the depth limit and reports a plain folder", async () => {
    await checkout(...Array.from({ length: NESTED_DEPTH + 1 }, (_, n) => `d${n}`));
    expect(await readFolderLayout(root)).toMatchObject({ kind: "plain", repositoryCount: 0 });
  });

  it("returns null for a missing folder", async () => {
    expect(await readFolderLayout(at("missing"))).toBeNull();
  });
});

describe("planningImpact", () => {
  it("needs nothing when neither folder has increments", async () => {
    await checkout("a");
    await checkout("b");
    expect(await planningImpact(at("a"), at("b"), [])).toMatchObject({
      currentRoot: null,
      targetRoot: null,
      changes: false,
    });
  });

  it("keeps the umbrella's increments when a member repository moves up to the umbrella", async () => {
    await increments(root, "0001-one", "0002-two");
    await checkout("repositories/acme/api");
    const impact = await planningImpact(at("repositories/acme/api"), root, ["0002-two"]);
    expect(impact).toMatchObject({
      currentRoot: root,
      targetRoot: root,
      currentIncrements: 2,
      brokenLinks: [],
      changes: false,
    });
  });

  it("reports lost increments and links for a folder outside the planning root", async () => {
    await NodeFSP.mkdir(at("umb"));
    await increments(at("umb"), "0001-one", "0002-two");
    await checkout("elsewhere");
    const impact = await planningImpact(at("umb"), at("elsewhere"), ["0002-two", "0002-two"]);
    expect(impact).toEqual({
      currentRoot: at("umb"),
      currentIncrements: 2,
      targetRoot: null,
      targetIncrements: 0,
      brokenLinks: ["0002-two"],
      changes: true,
    });
  });

  it("needs no confirmation for a clone that holds every current increment", async () => {
    await NodeFSP.mkdir(at("old"));
    await NodeFSP.mkdir(at("clone"));
    await increments(at("old"), "0001-one", "0002-two");
    await increments(at("clone"), "0001-one", "0002-two", "0003-three");
    const impact = await planningImpact(at("old"), at("clone"), ["0002-two"]);
    expect(impact.brokenLinks).toEqual([]);
    expect(impact.changes).toBe(false);
  });

  it("names links the new planning root lacks", async () => {
    await NodeFSP.mkdir(at("old"));
    await NodeFSP.mkdir(at("new"));
    await increments(at("old"), "0001-one", "0002-two");
    await increments(at("new"), "0001-one");
    const impact = await planningImpact(at("old"), at("new"), ["0001-one", "0002-two"]);
    expect(impact.brokenLinks).toEqual(["0002-two"]);
    expect(impact.targetIncrements).toBe(1);
    expect(impact.changes).toBe(true);
  });
});
