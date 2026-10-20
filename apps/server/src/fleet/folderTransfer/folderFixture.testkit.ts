// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * A small umbrella with every shape the real EasyChamp folder has: a root
 * repository whose `repositories/` folder is ignored and holds nested
 * repositories, a linked worktree, dirty and stashed work, local branches,
 * directory and file links (one pointing outside), ignored project data,
 * rebuildable dependencies, a secret file, an executable and a multi-chunk file.
 */
export const git = (cwd: string, ...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "-c",
      "user.name=Folder Copy Test",
      "-c",
      "user.email=folder-copy@example.invalid",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} (exit ${result.status ?? result.signal}): ${`${result.stderr}${result.stdout}`.trim()}`,
    );
  return result.stdout.trim();
};

export const write = (file: string, content: string | Buffer, mode?: number) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
  if (mode !== undefined) NodeFS.chmodSync(file, mode);
};

function initRepository(directory: string, origin: string, files: Record<string, string>) {
  NodeFS.mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  git(directory, "remote", "add", "origin", origin);
  for (const [name, content] of Object.entries(files))
    write(NodePath.join(directory, name), content);
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "initial");
}

export interface UmbrellaFixture {
  readonly root: string;
  readonly origins: string;
  readonly bigFileBytes: number;
}

/** Builds the umbrella under `base/<name>` with bare origins under `base/origins`. */
export function makeUmbrella(base: string, name = "umbrella"): UmbrellaFixture {
  const root = NodePath.join(base, name);
  const origins = NodePath.join(base, "origins");
  NodeFS.mkdirSync(origins, { recursive: true });
  const bare = (id: string) => {
    const location = NodePath.join(origins, `${id}.git`);
    if (!NodeFS.existsSync(location)) git(origins, "init", "-q", "--bare", location);
    return location;
  };
  initRepository(root, bare("umbrella"), {
    "README.md": "# Umbrella\n",
    ".gitignore": "repositories/\nnode_modules/\nwork/\n.env\n.specweave/increments/*/evidence/\n",
    "scripts/run.sh": "#!/bin/sh\necho run\n",
    "docs/guide.md": "guide v1\n",
    "skills/appstore/SKILL.md": "skill\n",
  });
  // Set the bit in the index too: Git ignores working-tree modes when the
  // filesystem's core.fileMode probe says it cannot trust them.
  NodeFS.chmodSync(NodePath.join(root, "scripts/run.sh"), 0o755);
  git(root, "update-index", "--chmod=+x", "scripts/run.sh");
  git(root, "commit", "-q", "-m", "executable");
  git(root, "push", "-q", "origin", "main");
  // Links: a tracked directory link inside the folder, a file link, one pointing outside.
  NodeFS.mkdirSync(NodePath.join(root, ".cursor/skills"), { recursive: true });
  NodeFS.symlinkSync("../../skills/appstore", NodePath.join(root, ".cursor/skills/appstore"));
  NodeFS.symlinkSync("README.md", NodePath.join(root, "README.link.md"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "links");
  NodeFS.symlinkSync("/tmp", NodePath.join(root, "outside-link"));
  // Dirty umbrella: one modified tracked file and one untracked file.
  write(NodePath.join(root, "docs/guide.md"), "guide v2 (uncommitted)\n");
  write(NodePath.join(root, "notes/todo.md"), "untracked todo\n");
  // Ignored project data, rebuildable output and a secret.
  write(NodePath.join(root, "work/session.log"), "work data\n");
  write(NodePath.join(root, ".specweave/increments/0001-x/evidence/run.txt"), "evidence\n");
  write(NodePath.join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  write(NodePath.join(root, ".env"), "API_TOKEN=fixture-not-a-secret\n");
  // A file over one 8 MiB chunk, and a duplicate of a small file elsewhere.
  const bigFileBytes = 9 * 1024 * 1024 + 123;
  const big = Buffer.alloc(bigFileBytes);
  for (let index = 0; index < big.length; index += 4096) big.writeUInt32LE(index, index);
  write(NodePath.join(root, "work/big.bin"), big);
  write(NodePath.join(root, "work/copy-of-readme.md"), "# Umbrella\n");

  // Nested repositories under the ignored repositories/ folder.
  const serviceA = NodePath.join(root, "repositories/svc-a");
  initRepository(serviceA, bare("svc-a"), { "src/a.ts": "export const a = 1;\n" });
  git(serviceA, "push", "-q", "origin", "main");
  git(serviceA, "branch", "feature");
  const serviceB = NodePath.join(root, "repositories/svc-b");
  initRepository(serviceB, bare("svc-b"), { "src/b.ts": "export const b = 1;\n" });
  git(serviceB, "push", "-q", "origin", "main");
  git(serviceB, "checkout", "-q", "-b", "local-only");
  write(NodePath.join(serviceB, "src/local.ts"), "local\n");
  git(serviceB, "add", "-A");
  git(serviceB, "commit", "-q", "-m", "local branch commit");
  git(serviceB, "checkout", "-q", "main");
  write(NodePath.join(serviceB, "src/b.ts"), "export const b = 2; // stashed\n");
  git(serviceB, "stash", "push", "-q", "-m", "fixture stash");
  write(NodePath.join(serviceB, "src/b.ts"), "export const b = 3; // dirty\n");
  write(NodePath.join(serviceB, "scratch.txt"), "untracked in svc-b\n");
  // A linked worktree of svc-a beside it, with its own dirty file.
  git(
    serviceA,
    "worktree",
    "add",
    "-q",
    NodePath.join(root, "repositories/svc-a-wt-feature"),
    "feature",
  );
  write(
    NodePath.join(root, "repositories/svc-a-wt-feature/src/a.ts"),
    "export const a = 2; // wt\n",
  );
  return { root, origins, bigFileBytes };
}
