// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { git } from "./folderFixture.testkit.ts";
import { scanFolder } from "./manifest.ts";

let base: string;
beforeEach(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-wt-gone-")));
});
afterEach(() => {
  NodeFS.rmSync(base, { recursive: true, force: true });
});

it("labels a registered worktree missing when a file replaced its parent folder", async () => {
  const main = NodePath.join(base, "main");
  NodeFS.mkdirSync(main);
  git(main, "init", "-q");
  NodeFS.writeFileSync(NodePath.join(main, "readme.txt"), "fixture");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "fixture");
  const parent = NodePath.join(base, "parent");
  git(main, "worktree", "add", "-q", "-b", "nested", NodePath.join(parent, "nested-wt"));
  NodeFS.rmSync(parent, { recursive: true, force: true });
  NodeFS.writeFileSync(parent, "a file where the folder was");
  const scan = await scanFolder(main);
  expect(scan.repositories[0]?.worktrees).toEqual([]);
  expect(scan.notices?.join(" ")).toContain(
    "1 missing worktree registration(s), not current folders: nested-wt",
  );
});
