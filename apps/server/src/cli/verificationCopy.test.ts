// @effect-diagnostics nodeBuiltinImport:off - a real git repository, a real clone of it and a recorded install command.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  ensureVerificationCopy,
  installPlan,
  repositoryName,
  VERIFICATION_INSTALL_COMMAND_ENV,
  VerificationCopyError,
} from "./verificationCopy.ts";

let root: string;
let source: string;
let home: string;
let installLog: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const write = (file: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(source, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(source, file), content);
};

const commit = (message: string) => {
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", message);
  return git(source, "rev-parse", "HEAD");
};

const installs = () =>
  NodeFS.existsSync(installLog)
    ? NodeFS.readFileSync(installLog, "utf8").split("\n").filter(Boolean).length
    : 0;

const copyOf = (ref?: string, exclusive?: <A>(work: () => A) => A) =>
  ensureVerificationCopy({ source, ref, home, env, ...(exclusive ? { exclusive } : {}) });

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "verify-copy-")));
  source = NodePath.join(root, "checkout");
  home = NodePath.join(root, "home");
  installLog = NodePath.join(root, "installs.log");
  NodeFS.mkdirSync(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "remote", "add", "origin", "https://example.com/acme/widgets.git");
  write("package.json", JSON.stringify({ name: "widgets", packageManager: "pnpm@11.10.0" }));
  write("pnpm-lock.yaml", "lockfileVersion: 1\n");
  write(".gitignore", "node_modules\n");
  write("src/index.ts", "export const one = 1;\n");
  write(".repos/reference/readme.md", "vendored\n");
  commit("first");
  // Stands in for `pnpm install`: records each run and leaves an ignored folder.
  const install = NodePath.join(root, "install.cjs");
  NodeFS.writeFileSync(
    install,
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(installLog)}, process.cwd() + "\\n");
fs.mkdirSync("node_modules", { recursive: true });
`,
  );
  env = {
    ...process.env,
    [VERIFICATION_INSTALL_COMMAND_ENV]: `"${process.execPath}" "${install}"`,
  };
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("verification copy", () => {
  it("creates one copy per repository at the requested commit, without .repos, and installs once", () => {
    const head = git(source, "rev-parse", "HEAD");
    const first = copyOf();
    assert.strictEqual(first.path, NodePath.join(home, "verify", "widgets"));
    assert.deepStrictEqual(
      { created: first.created, moved: first.moved, installed: first.installed },
      { created: true, moved: true, installed: true },
    );
    assert.strictEqual(first.commit, head);
    assert.strictEqual(git(first.path, "rev-parse", "HEAD"), head);
    // Detached: the copy has no branch of its own to drift.
    assert.strictEqual(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.isTrue(NodeFS.existsSync(NodePath.join(first.path, "src", "index.ts")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(first.path, ".repos")));
    assert.strictEqual(
      git(first.path, "remote", "get-url", "origin"),
      "https://example.com/acme/widgets.git",
    );
    assert.strictEqual(installs(), 1);

    const again = copyOf();
    assert.strictEqual(again.path, first.path);
    assert.deepStrictEqual(
      { created: again.created, moved: again.moved, installed: again.installed },
      { created: false, moved: false, installed: false },
    );
    assert.strictEqual(installs(), 1);
  });

  it("moves to a new commit without reinstalling while the lockfile is unchanged", () => {
    copyOf();
    write("src/index.ts", "export const one = 2;\n");
    const next = commit("second");
    const moved = copyOf();
    assert.deepStrictEqual(
      { commit: moved.commit, moved: moved.moved, installed: moved.installed },
      { commit: next, moved: true, installed: false },
    );
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(moved.path, "src", "index.ts"), "utf8"),
      "export const one = 2;\n",
    );
    assert.strictEqual(installs(), 1);
  });

  it("reinstalls when the lockfile changed", () => {
    copyOf();
    write("pnpm-lock.yaml", "lockfileVersion: 2\n");
    commit("bump");
    const moved = copyOf();
    assert.isTrue(moved.installed);
    assert.strictEqual(installs(), 2);
    // Back on the first commit the lockfile differs again.
    const back = copyOf("HEAD~1");
    assert.isTrue(back.installed);
    assert.strictEqual(installs(), 3);
  });

  it("checks out a branch by name and a commit that was never pushed", () => {
    copyOf();
    git(source, "checkout", "--quiet", "-b", "feature");
    write("src/feature.ts", "export const feature = true;\n");
    const feature = commit("feature");
    git(source, "checkout", "--quiet", "main");
    assert.strictEqual(copyOf("feature").commit, feature);
    // A commit no branch points at any more.
    git(source, "checkout", "--quiet", "--detach");
    write("src/loose.ts", "export const loose = true;\n");
    const loose = commit("loose");
    git(source, "checkout", "--quiet", "main");
    const result = copyOf(loose);
    assert.strictEqual(git(result.path, "rev-parse", "HEAD"), loose);
    assert.isTrue(NodeFS.existsSync(NodePath.join(result.path, "src", "loose.ts")));
  });

  it("refuses to move a copy with uncommitted or untracked files and leaves them alone", () => {
    const { path } = copyOf();
    NodeFS.writeFileSync(NodePath.join(path, "notes.txt"), "mine");
    NodeFS.writeFileSync(NodePath.join(path, "src", "index.ts"), "edited\n");
    write("src/index.ts", "export const one = 3;\n");
    commit("third");
    let error: unknown;
    try {
      copyOf();
    } catch (cause) {
      error = cause;
    }
    assert.instanceOf(error, VerificationCopyError);
    assert.strictEqual((error as VerificationCopyError).kind, "dirty");
    assert.include((error as Error).message, "?? notes.txt");
    assert.include((error as Error).message, "M src/index.ts");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(path, "notes.txt"), "utf8"), "mine");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(path, "src", "index.ts"), "utf8"),
      "edited\n",
    );
  });

  it("asks for the gate only when the copy has to change", () => {
    let asked = 0;
    const counting = <A>(work: () => A): A => {
      asked += 1;
      return work();
    };
    copyOf(undefined, counting);
    assert.isAbove(asked, 0);
    asked = 0;
    copyOf(undefined, counting);
    assert.strictEqual(asked, 0);

    write("src/index.ts", "export const one = 4;\n");
    commit("fourth");
    const before = git(NodePath.join(home, "verify", "widgets"), "rev-parse", "HEAD");
    const refusing = (): never => {
      throw new VerificationCopyError("busy", "the gate is held");
    };
    assert.throws(() => copyOf(undefined, refusing), "the gate is held");
    assert.strictEqual(git(NodePath.join(home, "verify", "widgets"), "rev-parse", "HEAD"), before);
  });

  it("names the copy after the repository and picks the install command from packageManager", () => {
    assert.strictEqual(repositoryName("https://github.com/acme/widgets.git"), "widgets");
    assert.strictEqual(repositoryName("git@github.com:acme/widgets.git"), "widgets");
    assert.strictEqual(repositoryName("/work/checkouts/widgets/"), "widgets");
    const plan = installPlan(source, {});
    assert.strictEqual(plan.command, "pnpm install --frozen-lockfile");
    assert.match(plan.lockfileHash ?? "", /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(installPlan(root, {}), { lockfileHash: null, command: null });
  });
});
