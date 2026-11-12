// An umbrella on disk, with real Git: a root repository that ignores `repositories/`,
// and child clones under it. Nothing is saved in any project's Environment.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull === "\\\\.\\nul" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function repository(folder, files = { "README.md": `${path.basename(folder)}\n` }) {
  fs.mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "fixture");
  return folder;
}

/**
 * `<base>/umbrella` with `repositories/acme/api` (on `main`, with a `release` branch) and
 * `repositories/acme/web` (no branch checked out; its origin's default branch is `main`),
 * plus `extra` more clones named `repositories/acme/extra-N`.
 */
export function makeUmbrella({ extra = 0 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "umbrella-worktrees-")));
  const root = repository(path.join(base, "umbrella"), {
    ".gitignore": "repositories/\n",
    "AGENTS.md": "# Umbrella\n",
  });
  const api = repository(path.join(root, "repositories", "acme", "api"));
  git(api, "branch", "release");
  const web = repository(path.join(root, "repositories", "acme", "web"));
  const origin = path.join(base, "web-origin.git");
  git(base, "clone", "-q", "--bare", web, origin);
  git(web, "remote", "add", "origin", origin);
  git(web, "fetch", "-q", "origin");
  git(web, "remote", "set-head", "origin", "main");
  git(web, "checkout", "-q", "--detach");
  const extras = Array.from({ length: extra }, (_, index) =>
    repository(path.join(root, "repositories", "acme", `extra-${index + 1}`)),
  );
  return {
    base,
    root,
    api,
    web,
    extras,
    worktrees: path.join(base, "worktrees"),
    remove: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** An increment in the umbrella's `.specweave` that declares the repositories it changes. */
export function addIncrement(root, id, repositories) {
  const folder = path.join(root, ".specweave", "increments", id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "metadata.json"),
    JSON.stringify({ id, status: "active", repositories }),
  );
  fs.writeFileSync(path.join(folder, "spec.md"), `# ${id}\n`);
  return { root, incrementId: id };
}
