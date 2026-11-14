// @effect-diagnostics nodeBuiltinImport:off - disposable real Git repositories for handoff tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Shared by the handoff Git tests: real repositories, origins and clones in a temporary folder. */
export const operationId = "019a0000-0000-7000-8000-000000000001";
export const temporary: Array<string> = [];
export const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Handoff Test",
      "-c",
      "user.email=handoff@example.invalid",
      "-c",
      "protocol.file.allow=always",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
export const write = (path: string, value: string) => NodeFS.writeFileSync(path, value);
export const commit = (cwd: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "fixture checkpoint");
};

export function fixture(submodule = false) {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-handoff-git-")),
  );
  temporary.push(base);
  const source = NodePath.join(base, "source"),
    destination = NodePath.join(base, "destination"),
    outputs = NodePath.join(base, "outputs");
  const rootRemote = NodePath.join(base, "root.git"),
    nestedRemote = NodePath.join(base, "nested.git");
  NodeFS.mkdirSync(source);
  NodeFS.mkdirSync(outputs);
  git(base, "init", "--bare", "--initial-branch=main", rootRemote);
  git(base, "init", "--bare", "--initial-branch=main", nestedRemote);
  git(source, "init", "--initial-branch=main");
  git(source, "remote", "add", "origin", rootRemote);
  write(NodePath.join(source, ".gitignore"), submodule ? "" : "/repositories/\n");
  write(NodePath.join(source, "root.ts"), "export const value = 1;\n");
  commit(source);
  const seed = NodePath.join(base, "nested-seed");
  NodeFS.mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  git(seed, "remote", "add", "origin", nestedRemote);
  write(NodePath.join(seed, "feature.ts"), "export const answer = 1;\n");
  commit(seed);
  git(seed, "push", "-u", "origin", "main");
  if (submodule) {
    git(source, "submodule", "add", nestedRemote, "repositories/nested");
    commit(source);
  } else {
    NodeFS.mkdirSync(NodePath.join(source, "repositories"));
    git(base, "clone", nestedRemote, NodePath.join(source, "repositories/nested"));
  }
  git(source, "push", "-u", "origin", "main");
  git(base, "clone", rootRemote, destination);
  if (submodule) git(destination, "submodule", "update", "--init");
  else {
    NodeFS.mkdirSync(NodePath.join(destination, "repositories"));
    git(base, "clone", nestedRemote, NodePath.join(destination, "repositories/nested"));
  }
  return {
    base,
    source,
    destination,
    outputs,
    rootRemote,
    nestedRemote,
    sourceNested: NodePath.join(source, "repositories/nested"),
    destinationNested: NodePath.join(destination, "repositories/nested"),
    submodule,
  };
}
export function changeCode(f: ReturnType<typeof fixture>) {
  write(NodePath.join(f.sourceNested, "feature.ts"), "export const answer = 42;\n");
  commit(f.sourceNested);
  write(NodePath.join(f.source, "root.ts"), "export const value = 42;\n");
  commit(f.source);
}
export function snapshot(cwd: string) {
  return {
    head: git(cwd, "rev-parse", "HEAD"),
    branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    index: git(cwd, "ls-files", "--stage"),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
    refs: git(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
    config: git(cwd, "config", "--local", "--list"),
  };
}
export type HandoffFixture = ReturnType<typeof fixture>;
