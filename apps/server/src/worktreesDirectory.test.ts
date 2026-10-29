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

it.each([
  {
    label: "POSIX",
    path: NodePath.posix,
    old: "/old",
    managed: "/managed",
    repo: "/repo",
    project: "/repo/.specwithcode/worktrees",
    root: "/",
  },
  {
    label: "Windows",
    path: NodePath.win32,
    old: "C:\\old",
    managed: "C:\\managed",
    repo: "C:\\repo",
    project: "C:\\repo\\.specwithcode\\worktrees",
    root: "C:\\",
  },
])(
  "resolves $label modes without moving or reinterpreting saved legacy roots",
  ({ path, old, managed, repo, project, root }) => {
    assert.equal(resolveWorktreesDirectory(old, managed, path), old);
    assert.equal(resolveWorktreesDirectory(old, managed, path, "managed", repo), managed);
    assert.equal(resolveWorktreesDirectory(old, managed, path, "project", repo), project);
    assert.isNull(resolveWorktreesDirectory("", managed, path, "custom", repo));
    assert.isNull(resolveWorktreesDirectory("relative", managed, path, "custom", repo));
    assert.isNull(resolveWorktreesDirectory(root, managed, path, "custom", repo));
    assert.isNull(resolveWorktreesDirectory("", managed, path, "project"));
  },
);

it("resolves modes without moving or reinterpreting saved legacy roots", () =>
  withHome((home) => {
    const old = NodePath.join(home, "old");
    const managed = NodePath.join(home, "managed");
    const repository = NodePath.join(home, "repo");
    assert.equal(resolveWorktreesDirectory(old, managed, NodePath), old);
    assert.equal(resolveWorktreesDirectory(old, managed, NodePath, "managed", repository), managed);
    assert.equal(
      resolveWorktreesDirectory(old, managed, NodePath, "project", repository),
      NodePath.join(repository, ".specwithcode", "worktrees"),
    );
    assert.isNull(resolveWorktreesDirectory("", managed, NodePath, "custom", repository));
    assert.isNull(resolveWorktreesDirectory("relative", managed, NodePath, "custom", repository));
    assert.isNull(
      resolveWorktreesDirectory(NodePath.resolve("/"), managed, NodePath, "custom", repository),
    );
    assert.isNull(resolveWorktreesDirectory("", managed, NodePath, "project"));
  }));
