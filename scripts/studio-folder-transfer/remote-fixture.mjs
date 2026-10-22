import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "user.name=Transfer acceptance",
      "-c",
      "user.email=transfer@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.defaultBranch=main",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();

const write = async (root, relative, content, mode) => {
  const file = NodePath.join(root, relative);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, content);
  if (mode) await NodeFSP.chmod(file, mode);
};

/** Shallow clone real current source without changing it; add mutations only here. */
export async function makeRemoteFixture(base, sourceRepository) {
  const root = NodePath.join(base, "specweave-umb");
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  git(root, "init", "-q");
  await write(
    root,
    ".gitignore",
    "repositories/\nlegacy projects/\nworktrees/\n.env*\nnode_modules/\nevidence/\nnotes/\n",
  );
  await write(root, ".specweave/config.json", JSON.stringify({ umbrella: { enabled: true } }));
  await write(root, "README.md", "# Disposable umbrella transfer acceptance\n");
  await write(root, "scripts/check.sh", "#!/bin/sh\nexit 0\n", 0o755);
  await NodeFSP.symlink("README.md", NodePath.join(root, "readme-link"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "umbrella fixture");
  const nested = NodePath.join(root, "repositories/anton-abyzov/specweave");
  await NodeFSP.mkdir(NodePath.dirname(nested), { recursive: true });
  const sourceHead = git(sourceRepository, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--no-local", "--depth", "1", sourceRepository, nested);
  assertHead(nested, sourceHead);
  await NodeFSP.appendFile(NodePath.join(nested, "README.md"), "\nTransfer acceptance stash.\n");
  git(nested, "stash", "push", "-qm", "transfer acceptance stash");
  await NodeFSP.appendFile(NodePath.join(nested, "README.md"), "\nSecond transfer stash.\n");
  git(nested, "stash", "push", "-qm", "second transfer stash");
  git(nested, "commit", "--allow-empty", "-qm", "unfinished branch ahead of origin");
  await NodeFSP.appendFile(
    NodePath.join(nested, "README.md"),
    "\nTransfer acceptance staged work.\n",
  );
  git(nested, "add", "README.md");
  await NodeFSP.appendFile(
    NodePath.join(nested, "README.md"),
    "\nTransfer acceptance dirty work.\n",
  );
  await write(nested, "copy-untracked.txt", "unfinished work must survive\n");
  await write(root, "evidence/unfinished-report.txt", "ignored project data survives\n");
  await write(root, ".env.local", "SYNTHETIC_TRANSFER_TEST=must-not-arrive\n");
  await write(root, ".DS_Store", "rebuildable Finder metadata must not arrive\n");
  await write(root, "node_modules/rebuildable-placeholder.txt", "must-not-arrive\n");
  await write(root, "unfinished.txt", "untracked umbrella work survives\n");
  await NodeFSP.mkdir(NodePath.join(root, "worktrees"), { recursive: true });
  git(
    nested,
    "worktree",
    "add",
    "-qb",
    "copy-acceptance-linked",
    NodePath.join(root, "worktrees/specweave-wip"),
  );
  const linked = NodePath.join(root, "worktrees/specweave-wip");
  await NodeFSP.appendFile(NodePath.join(linked, "README.md"), "\nLinked worktree staged work.\n");
  git(linked, "add", "README.md");
  git(linked, "update-index", "--split-index");
  await NodeFSP.appendFile(
    NodePath.join(linked, "README.md"),
    "\nLinked worktree unstaged work.\n",
  );
  await write(linked, "linked-untracked.txt", "unfinished linked work\n");
  await write(linked, ".DS_Store", "rebuildable Finder metadata must not arrive\n");
  for (const name of ["keep", "take", "both"])
    await write(root, `notes/${name}.md`, `Source ${name}\n`);
  const custom = NodePath.join(root, "legacy projects/loose group/service");
  await NodeFSP.mkdir(custom, { recursive: true });
  git(custom, "init", "-q");
  await write(custom, "service.txt", "arbitrary nested repository\n");
  git(custom, "add", "-A");
  git(custom, "commit", "-qm", "custom layout fixture");
  await write(custom, "service.txt", "dirty arbitrary nested repository\n");
  return { root, sourceHead, sourceRepository, nestedPath: NodePath.relative(root, nested) };
}

function assertHead(repository, expected) {
  if (git(repository, "rev-parse", "HEAD") !== expected)
    throw new Error(
      "Real source HEAD changed while creating fixture; retry from a stable snapshot.",
    );
}
