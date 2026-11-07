// @effect-diagnostics nodeBuiltinImport:off globalDate:off - drives a real Git repository in a temporary folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  TEAM_RULES_NONE,
  teamRulesCeiling,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  makeTeamRulesFolderReader,
  readTeamRulesFolder,
  type TeamRulesGitRun,
} from "./TeamRulesScope.ts";

const RULES = (ceiling: string) =>
  JSON.stringify({ version: 1, owner: "Team", agents: { ceiling } });

const roots: Array<string> = [];
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/** A clone with `origin` whose default branch is `trunk`, holding `ceiling` when given. */
function cloneWith(ceiling: string | undefined) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "team-rules-scope-"));
  roots.push(root);
  const origin = NodePath.join(root, "origin");
  NodeFS.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "trunk");
  if (ceiling !== undefined) {
    NodeFS.mkdirSync(NodePath.join(origin, ".specwithcode"));
    NodeFS.writeFileSync(NodePath.join(origin, ".specwithcode", "team-rules.json"), RULES(ceiling));
    git(origin, "add", ".");
  }
  git(origin, "commit", "-q", "--allow-empty", "-m", "first");
  const clone = NodePath.join(root, "clone");
  git(root, "clone", "-q", origin, clone);
  return { root, origin, clone };
}

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const repositoryCeiling = async (cwd: string) => {
  const reader = makeTeamRulesFolderReader(() => TEAM_RULES_NONE);
  return teamRulesCeiling(await reader(cwd));
};

describe("repository rules come from the remote-tracking ref", () => {
  it("reads the default branch, whatever its name", async () => {
    const { clone } = cloneWith("approval-required");
    expect(await repositoryCeiling(clone)).toBe("approval-required");
  });

  it("ignores an uncommitted, staged or local-only edit", async () => {
    const { clone } = cloneWith("approval-required");
    const file = NodePath.join(clone, ".specwithcode", "team-rules.json");
    NodeFS.writeFileSync(file, RULES("full-access"));
    expect(await repositoryCeiling(clone)).toBe("approval-required");
    git(clone, "add", ".");
    expect(await repositoryCeiling(clone)).toBe("approval-required");
    git(clone, "commit", "-q", "-m", "loosen");
    expect(await repositoryCeiling(clone)).toBe("approval-required");
    NodeFS.rmSync(file);
    expect(await repositoryCeiling(clone)).toBe("approval-required");
  });

  it("applies a new rule only after a fetch brings it in", async () => {
    const { origin, clone } = cloneWith("full-access");
    NodeFS.writeFileSync(
      NodePath.join(origin, ".specwithcode", "team-rules.json"),
      RULES("approval-required"),
    );
    git(origin, "commit", "-q", "-am", "tighten");
    expect(await repositoryCeiling(clone)).toBe("full-access");
    git(clone, "fetch", "-q", "origin");
    expect(await repositoryCeiling(clone)).toBe("approval-required");
  });

  it("reads the same from a linked worktree and a subfolder", async () => {
    const { root, clone } = cloneWith("auto");
    const linked = NodePath.join(root, "linked");
    git(clone, "worktree", "add", "-q", "-b", "side", linked);
    expect(await repositoryCeiling(linked)).toBe("auto");
    NodeFS.mkdirSync(NodePath.join(clone, "sub"));
    expect(await repositoryCeiling(NodePath.join(clone, "sub"))).toBe("auto");
  });

  it("has no rules without a file, a remote or a repository", async () => {
    expect(await repositoryCeiling(cloneWith(undefined).clone)).toBeUndefined();
    const plain = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "team-rules-plain-"));
    roots.push(plain);
    expect(await readTeamRulesFolder(plain)).toEqual({
      kind: "read",
      remotes: [],
      repository: undefined,
    });
    git(plain, "init", "-q");
    expect(await readTeamRulesFolder(plain)).toEqual({
      kind: "read",
      remotes: [],
      repository: undefined,
    });
    expect(await repositoryCeiling(NodePath.join(plain, "missing"))).toBeUndefined();
  });

  it("holds only the folder whose committed file is broken", async () => {
    const broken = cloneWith(undefined);
    NodeFS.mkdirSync(NodePath.join(broken.origin, ".specwithcode"));
    NodeFS.writeFileSync(NodePath.join(broken.origin, ".specwithcode", "team-rules.json"), "{");
    git(broken.origin, "add", ".");
    git(broken.origin, "commit", "-q", "-m", "broken");
    git(broken.clone, "fetch", "-q", "origin");
    const healthy = cloneWith("auto");
    const reader = makeTeamRulesFolderReader(() => TEAM_RULES_NONE);
    const held = await reader(broken.clone);
    expect(held.status === "hold" && held.holdScope).toBe("repository");
    expect((await reader(healthy.clone)).status).toBe("active");
  });
});

describe("zones", () => {
  const machine: TeamRulesState = {
    status: "active",
    fingerprint: "abc",
    warnings: [],
    rules: {
      version: 1,
      owner: "Acme",
      zones: [{ remote: "github.com/acme/*", agents: { ceiling: "approval-required" } }],
    },
  };

  it("matches any remote, not only origin", async () => {
    const { clone } = cloneWith(undefined);
    const reader = makeTeamRulesFolderReader(() => machine);
    expect(teamRulesCeiling(await reader(clone))).toBeUndefined();
    git(clone, "remote", "add", "client", "https://token@github.com/acme/payments.git");
    const zoned = makeTeamRulesFolderReader(() => machine);
    expect(teamRulesCeiling(await zoned(clone))).toBe("approval-required");
  });

  const failing: TeamRulesGitRun = async () => ({
    code: "failed",
    stdout: "",
    stderr: "",
    tooLarge: false,
  });

  it("holds a folder it cannot read when the machine has zones", async () => {
    const held = await makeTeamRulesFolderReader(() => machine, failing)("/somewhere");
    expect(held.status === "hold" && held.holdScope).toBe("zone");
  });

  it("does not hold a folder it cannot read when no zone could apply", async () => {
    const reader = makeTeamRulesFolderReader(() => TEAM_RULES_NONE, failing);
    expect(await reader("/somewhere")).toBe(TEAM_RULES_NONE);
  });
});

describe("cost", () => {
  it("reads once per folder per interval and asks nothing during a machine hold", async () => {
    let calls = 0;
    const counted: TeamRulesGitRun = async () => {
      calls += 1;
      return { code: 1, stdout: "", stderr: "", tooLarge: false };
    };
    const reader = makeTeamRulesFolderReader(() => TEAM_RULES_NONE, counted);
    await Promise.all([reader("/a"), reader("/a"), reader("/a")]);
    await reader("/a");
    expect(calls).toBe(1);
    await reader("/b");
    expect(calls).toBe(2);
    const held = makeTeamRulesFolderReader(() => ({ status: "hold", issues: ["x"] }), counted);
    await held("/c");
    expect(calls).toBe(2);
  });

  it("keeps the last answer when a later read fails", async () => {
    const { clone } = cloneWith("auto");
    let fail = false;
    const real: TeamRulesGitRun = (cwd, args, timeoutMs) =>
      fail
        ? Promise.resolve({ code: "failed", stdout: "", stderr: "", tooLarge: false })
        : new Promise((resolve) => {
            NodeChildProcess.execFile(
              "git",
              ["-C", cwd, ...args],
              { timeout: timeoutMs, encoding: "utf8" },
              (error, stdout, stderr) =>
                resolve({
                  code: error === null ? 0 : typeof error.code === "number" ? error.code : "failed",
                  stdout,
                  stderr,
                  tooLarge: false,
                }),
            );
          });
    const now = Date.now();
    const original = Date.now;
    const reader = makeTeamRulesFolderReader(() => TEAM_RULES_NONE, real);
    expect(teamRulesCeiling(await reader(clone))).toBe("auto");
    fail = true;
    Date.now = () => now + 60_000;
    try {
      expect(teamRulesCeiling(await reader(clone))).toBe("auto");
    } finally {
      Date.now = original;
    }
  });
});
