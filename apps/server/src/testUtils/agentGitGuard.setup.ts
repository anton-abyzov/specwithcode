// @effect-diagnostics nodeBuiltinImport:off - vitest runs this setup outside any Effect runtime.
// A SpecWithCode agent thread puts its git guard first on PATH. The guard
// refuses some worktree creation the suite does on purpose, such as a path
// with a newline in it. The suite's temporary repositories are not an agent's
// manual worktrees, so the test process drops the guard and runs the real
// git, as CI does. Agent shells keep the guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const GUARD_MARKER = "Written by SpecWithCode for threads";

const isAgentGitGuard = (directory: string) =>
  ["git", "git.cmd"].some((name) => {
    try {
      return NodeFS.readFileSync(NodePath.join(directory, name), "utf8").includes(GUARD_MARKER);
    } catch {
      return false;
    }
  });

const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const pathValue = process.env[pathKey];
if (pathValue !== undefined) {
  process.env[pathKey] = pathValue
    .split(NodePath.delimiter)
    .filter((entry) => entry.length === 0 || !isAgentGitGuard(entry))
    .join(NodePath.delimiter);
}
