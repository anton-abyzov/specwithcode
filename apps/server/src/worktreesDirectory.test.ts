import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk fixtures prove the legacy-root link rule.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { nodePath as NodePath } from "./nodePath.ts";
import {
  legacyStudioPathAlias,
  managedWorktreesDirectories,
  resolveWorktreesDirectory,
} from "./worktreesDirectory.ts";

const settings = { worktreesDirectory: "", previousWorktreesDirectories: [] };

const withHome = (run: (home: string) => void) => {
  const home = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worktrees-dir-")),
  );
  try {
    run(home);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

it("keeps worktrees recorded under a migrated legacy root managed", () =>
  withHome((home) => {
    const branded = NodePath.join(home, ".specwithcode");
    NodeFS.mkdirSync(NodePath.join(branded, "m4", "worktrees"), { recursive: true });
    NodeFS.symlinkSync(branded, NodePath.join(home, ".specweave-studio"));
    const defaultDir = NodePath.join(branded, "m4", "worktrees");
    const legacy = NodePath.join(home, ".specweave-studio", "m4", "worktrees");
    assert.strictEqual(legacyStudioPathAlias(defaultDir, NodePath), legacy);
    assert.deepStrictEqual(managedWorktreesDirectories(settings, defaultDir, NodePath), [
      defaultDir,
      legacy,
    ]);
  }));

it("never claims a real legacy root beside a fresh branded profile", () =>
  withHome((home) => {
    const defaultDir = NodePath.join(home, ".specwithcode", "worktrees");
    NodeFS.mkdirSync(defaultDir, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, ".specweave-studio", "worktrees"), { recursive: true });
    assert.isNull(legacyStudioPathAlias(defaultDir, NodePath));
    assert.deepStrictEqual(managedWorktreesDirectories(settings, defaultDir, NodePath), [
      defaultDir,
    ]);
    assert.isNull(legacyStudioPathAlias("/srv/worktrees", NodePath));
  }));

it("resolves modes without moving or reinterpreting saved legacy roots", () => {
  assert.equal(resolveWorktreesDirectory("/old", "/managed", NodePath), "/old");
  assert.equal(
    resolveWorktreesDirectory("/old", "/managed", NodePath, "managed", "/repo"),
    "/managed",
  );
  assert.equal(
    resolveWorktreesDirectory("/old", "/managed", NodePath, "project", "/repo"),
    "/repo/.specwithcode/worktrees",
  );
  assert.isNull(resolveWorktreesDirectory("", "/managed", NodePath, "custom", "/repo"));
  assert.isNull(resolveWorktreesDirectory("relative", "/managed", NodePath, "custom", "/repo"));
  assert.isNull(resolveWorktreesDirectory("/", "/managed", NodePath, "custom", "/repo"));
  assert.isNull(resolveWorktreesDirectory("", "/managed", NodePath, "project"));
});
