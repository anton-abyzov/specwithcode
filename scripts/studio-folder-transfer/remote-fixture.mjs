import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

const git = (cwd, ...args) =>
  execFileSync(
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
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mode) await fs.chmod(file, mode);
};

/** Shallow clone real current source without changing it; add mutations only here. */
export async function makeRemoteFixture(base, sourceRepository) {
  const root = path.join(base, "specweave-umb");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  git(root, "init", "-q");
  await write(
    root,
    ".gitignore",
    "repositories/\nlegacy projects/\nworktrees/\n.env*\nnode_modules/\nevidence/\n",
  );
  await write(root, ".specweave/config.json", JSON.stringify({ umbrella: { enabled: true } }));
  await write(root, "README.md", "# Disposable umbrella transfer acceptance\n");
  await write(root, "scripts/check.sh", "#!/bin/sh\nexit 0\n", 0o755);
  await fs.symlink("README.md", path.join(root, "readme-link"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "umbrella fixture");
  const nested = path.join(root, "repositories/anton-abyzov/specweave");
  await fs.mkdir(path.dirname(nested), { recursive: true });
  const sourceHead = git(sourceRepository, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--no-local", "--depth", "1", sourceRepository, nested);
  assertHead(nested, sourceHead);
  await fs.appendFile(path.join(nested, "README.md"), "\nTransfer acceptance stash.\n");
  git(nested, "stash", "push", "-qm", "transfer acceptance stash");
  await fs.appendFile(path.join(nested, "README.md"), "\nTransfer acceptance dirty work.\n");
  await write(nested, "copy-untracked.txt", "unfinished work must survive\n");
  await write(root, "evidence/unfinished-report.txt", "ignored project data survives\n");
  await write(root, ".env.local", "SYNTHETIC_TRANSFER_TEST=must-not-arrive\n");
  await write(root, "node_modules/rebuildable-placeholder.txt", "must-not-arrive\n");
  await write(root, "unfinished.txt", "untracked umbrella work survives\n");
  await fs.mkdir(path.join(root, "worktrees"), { recursive: true });
  git(
    nested,
    "worktree",
    "add",
    "-qb",
    "copy-acceptance-linked",
    path.join(root, "worktrees/specweave-wip"),
  );
  const custom = path.join(root, "legacy projects/loose group/service");
  await fs.mkdir(custom, { recursive: true });
  git(custom, "init", "-q");
  await write(custom, "service.txt", "arbitrary nested repository\n");
  git(custom, "add", "-A");
  git(custom, "commit", "-qm", "custom layout fixture");
  await write(custom, "service.txt", "dirty arbitrary nested repository\n");
  return { root, sourceHead, sourceRepository, nestedPath: path.relative(root, nested) };
}

function assertHead(repository, expected) {
  if (git(repository, "rev-parse", "HEAD") !== expected)
    throw new Error(
      "Real source HEAD changed while creating fixture; retry from a stable snapshot.",
    );
}
