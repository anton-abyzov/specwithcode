// @effect-diagnostics nodeBuiltinImport:off - builds real Git fixtures with worktrees and links
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareFingerprints } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { originUrlFromConfig, scanRepositoryFingerprint } from "./projectFingerprint.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const scratch = () => {
  const folder = mkdtempSync(join(tmpdir(), "fingerprint-"));
  folders.push(folder);
  return folder;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
const repository = (folder: string, origin: string | null) => {
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  if (origin) git(folder, "remote", "add", "origin", origin);
  writeFileSync(join(folder, "README.md"), "fixture\n");
  git(folder, "add", "README.md");
  git(folder, "commit", "-q", "-m", "fixture");
};

describe("scanRepositoryFingerprint", () => {
  it("reads a root repository with nested repositories and their canonical origins", async () => {
    const root = scratch();
    repository(root, "git@github.com:team/umbrella.git");
    repository(join(root, "repositories/team/api"), "https://github.com/team/api.git");
    repository(join(root, "repositories/team/web"), null);
    const fingerprint = await scanRepositoryFingerprint(root);
    expect(fingerprint).toEqual({
      root: "repository",
      repositories: [
        { path: "", originKey: "github.com/team/umbrella", worktrees: 0 },
        { path: "repositories/team/api", originKey: "github.com/team/api", worktrees: 0 },
        { path: "repositories/team/web", originKey: null, worktrees: 0 },
      ],
      skippedLinks: 0,
      truncated: false,
    });
  });

  it("accepts a plain umbrella folder, counts worktrees under their repository and skips links", async () => {
    const root = scratch();
    const outside = scratch();
    repository(join(root, "matchcam"), "https://github.com/team/matchcam.git");
    git(join(root, "matchcam"), "worktree", "add", "-q", join(root, "matchcam-wt-a"), "-b", "a");
    git(join(root, "matchcam"), "worktree", "add", "-q", join(root, "aaa-wt-b"), "-b", "b");
    mkdirSync(join(outside, "skills"));
    symlinkSync(join(outside, "skills"), join(root, "skills-link"));
    symlinkSync(join(root, "matchcam"), join(root, "matchcam-alias"));
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    repository(join(root, "node_modules/pkg"), "https://github.com/other/pkg.git");
    const fingerprint = await scanRepositoryFingerprint(root);
    expect(fingerprint).toEqual({
      root: "folder",
      repositories: [{ path: "matchcam", originKey: "github.com/team/matchcam", worktrees: 2 }],
      skippedLinks: 2,
      truncated: false,
    });
  });
});

describe("compareFingerprints", () => {
  const entry = (path: string, originKey: string | null) => ({ path, originKey, worktrees: 0 });
  const umbrella = {
    root: "repository" as const,
    repositories: [
      entry("", "github.com/team/umbrella"),
      entry("repositories/api", "github.com/team/api"),
      entry("repositories/web", "github.com/team/web"),
      entry("repositories/ml", "github.com/team/ml"),
    ],
    skippedLinks: 0,
    truncated: false,
  };
  it("matches a subset copy at the root and lists what is missing here", () => {
    const partial = { ...umbrella, repositories: umbrella.repositories.slice(0, 2) };
    const comparison = compareFingerprints(partial, umbrella);
    expect(comparison.rootMatches).toBe(true);
    expect(comparison.shared).toBe(2);
    expect(comparison.missingHere.map((item) => item.path)).toEqual([
      "repositories/web",
      "repositories/ml",
    ]);
    expect(comparison.score).toBeGreaterThan(
      compareFingerprints(partial, {
        ...umbrella,
        repositories: [entry("", "github.com/team/other"), ...umbrella.repositories.slice(1)],
      }).score,
    );
  });
  it("refuses a different root repository, and folders that share nothing", () => {
    expect(
      compareFingerprints(umbrella, { ...umbrella, repositories: [entry("", "github.com/x/y")] })
        .rootMatches,
    ).toBe(false);
    const folder = (key: string) => ({
      root: "folder" as const,
      repositories: [entry("a", key)],
      skippedLinks: 0,
      truncated: false,
    });
    expect(
      compareFingerprints(folder("github.com/a/a"), folder("github.com/a/a")).rootMatches,
    ).toBe(true);
    expect(
      compareFingerprints(folder("github.com/a/a"), folder("github.com/b/b")).rootMatches,
    ).toBe(false);
    expect(compareFingerprints(folder("github.com/a/a"), umbrella).rootMatches).toBe(false);
  });
});

describe("originUrlFromConfig", () => {
  it("reads only the origin remote", () => {
    expect(
      originUrlFromConfig(
        '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://x/up.git\n[remote "origin"]\n\turl = git@github.com:team/repo.git\n',
      ),
    ).toBe("git@github.com:team/repo.git");
    expect(originUrlFromConfig("[core]\n")).toBeNull();
  });

  it("decodes escapes and quotes the way Git writes them", () => {
    expect(originUrlFromConfig('[remote "origin"]\n\turl = C:\\\\repos\\\\app.git\n')).toBe(
      "C:\\repos\\app.git",
    );
    expect(originUrlFromConfig('[remote "origin"]\n\turl = "/srv/a b;c.git" # mirror\n')).toBe(
      "/srv/a b;c.git",
    );
  });
});
