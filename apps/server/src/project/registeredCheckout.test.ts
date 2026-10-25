// @effect-diagnostics nodeBuiltinImport:off - Real Git checkouts in a temporary folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  checkoutCommonDir,
  registeredCheckouts,
  sameRepositoryCheckout,
  withinCheckTime,
} from "./registeredCheckout.ts";

const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

/** Runs Git with no user or system configuration, so the machine's settings never leak in. */
function git(cwd: string, ...args: string[]): void {
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

/** A repository with one commit at `<base>/main` and a linked worktree at `<base>/linked`. */
async function repository(base: string, name = "main") {
  const main = NodePath.join(base, name);
  await NodeFSP.mkdir(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(main, "README.md"), "x\n");
  git(main, "add", "README.md");
  git(main, "commit", "-q", "-m", "init");
  const linked = NodePath.join(base, `${name}-linked`);
  git(main, "worktree", "add", "-q", "-b", `wt-${name}`, linked);
  return { main, linked };
}

describe("registeredCheckout", () => {
  it("accepts a linked worktree of the same repository, both ways, and refuses a sibling", async () => {
    const base = await temp("studio-checkout-");
    const { main, linked } = await repository(base);
    const sibling = NodePath.join(base, "sibling");
    await NodeFSP.mkdir(sibling);

    expect(await checkoutCommonDir(main)).toBe(NodePath.join(main, ".git"));
    expect(await checkoutCommonDir(linked)).toBe(NodePath.join(main, ".git"));
    expect(await sameRepositoryCheckout(linked, [main])).toBe(true);
    expect(await sameRepositoryCheckout(main, [linked])).toBe(true);
    expect(await sameRepositoryCheckout(sibling, [main])).toBe(false);
    // A folder inside a checkout is not its top.
    expect(await sameRepositoryCheckout(NodePath.join(linked, "sub"), [main])).toBe(false);
    expect(await registeredCheckouts([main])).toEqual([main, linked]);
    expect(await registeredCheckouts([linked])).toEqual([main, linked]);
  });

  it("refuses another repository's worktree", async () => {
    const base = await temp("studio-checkout-");
    const { main } = await repository(base, "one");
    const other = await repository(base, "two");

    expect(await sameRepositoryCheckout(other.linked, [main])).toBe(false);
    expect(await sameRepositoryCheckout(other.main, [main])).toBe(false);
    expect(await registeredCheckouts([main])).not.toContain(other.linked);
  });

  it("refuses a forged .git file, a stale admin entry and a submodule link", async () => {
    const base = await temp("studio-checkout-");
    const { main, linked } = await repository(base);
    const common = NodePath.join(main, ".git");
    const admin = NodePath.join(common, "worktrees", NodePath.basename(linked));

    // A folder that only claims the linked worktree's admin entry: no back-link to it.
    const forged = NodePath.join(base, "forged");
    await NodeFSP.mkdir(forged);
    await NodeFSP.writeFile(NodePath.join(forged, ".git"), `gitdir: ${admin}\n`);
    expect(await checkoutCommonDir(forged)).toBeNull();
    expect(await sameRepositoryCheckout(forged, [main])).toBe(false);

    // An admin entry made by hand whose back-link names the forger still needs Git's layout.
    const fake = NodePath.join(base, "fake-admin", "worktrees", "x");
    await NodeFSP.mkdir(fake, { recursive: true });
    const impostor = NodePath.join(base, "impostor");
    await NodeFSP.mkdir(impostor);
    await NodeFSP.writeFile(NodePath.join(impostor, ".git"), `gitdir: ${fake}\n`);
    await NodeFSP.writeFile(NodePath.join(fake, "gitdir"), `${impostor}/.git\n`);
    await NodeFSP.writeFile(NodePath.join(fake, "commondir"), `${common}\n`);
    expect(await checkoutCommonDir(impostor)).toBeNull();
    expect(await sameRepositoryCheckout(impostor, [main])).toBe(false);
    // Without the commondir file it is a consistent checkout of another
    // "repository" (the fake one); identity, not consistency, refuses it.
    await NodeFSP.rm(NodePath.join(fake, "commondir"));
    expect(await checkoutCommonDir(impostor)).toBe(
      await NodeFSP.realpath(NodePath.join(base, "fake-admin")),
    );
    expect(await sameRepositoryCheckout(impostor, [main])).toBe(false);

    // A submodule's .git points into .git/modules, never .git/worktrees.
    const modules = NodePath.join(common, "modules", "lib");
    await NodeFSP.mkdir(modules, { recursive: true });
    const submodule = NodePath.join(main, "lib");
    await NodeFSP.mkdir(submodule);
    await NodeFSP.writeFile(NodePath.join(submodule, ".git"), `gitdir: ../.git/modules/lib\n`);
    expect(await checkoutCommonDir(submodule)).toBeNull();

    // The worktree folder removed by hand: its admin entry is stale and lists nothing.
    await NodeFSP.rm(linked, { recursive: true, force: true });
    expect(await registeredCheckouts([main])).toEqual([main]);
  });

  it("refuses a symlinked .git and resolves a symlinked path to the real checkout", async () => {
    const base = await temp("studio-checkout-");
    const { main, linked } = await repository(base);
    const alias = NodePath.join(base, "alias");
    await NodeFSP.symlink(linked, alias);
    expect(await sameRepositoryCheckout(alias, [main])).toBe(true);

    const linkedGit = NodePath.join(base, "linked-git");
    await NodeFSP.mkdir(linkedGit);
    await NodeFSP.symlink(NodePath.join(main, ".git"), NodePath.join(linkedGit, ".git"));
    expect(await checkoutCommonDir(linkedGit)).toBeNull();
  });

  it("accepts a worktree Git recorded with relative paths", async () => {
    const base = await temp("studio-checkout-");
    const { main, linked } = await repository(base);
    const admin = NodePath.join(main, ".git", "worktrees", NodePath.basename(linked));
    // Git for Windows marks the pointer hidden, which Windows refuses to overwrite.
    await NodeFSP.rm(NodePath.join(linked, ".git"));
    await NodeFSP.writeFile(
      NodePath.join(linked, ".git"),
      `gitdir: ${NodePath.relative(linked, admin)}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(admin, "gitdir"),
      `${NodePath.relative(admin, NodePath.join(linked, ".git"))}\n`,
    );
    expect(await sameRepositoryCheckout(linked, [main])).toBe(true);
    expect(await registeredCheckouts([main])).toEqual([main, linked]);
  });
  it("answers a hung folder's fallback in time, then skips it for a while", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const hung = () => {
        calls += 1;
        return new Promise<boolean>(() => undefined);
      };
      const first = withinCheckTime("/hung-mount/wt", hung, false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await first).toBe(false);
      // Not asked again while it is remembered as slow.
      expect(await withinCheckTime("/hung-mount/wt", hung, false)).toBe(false);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      void withinCheckTime("/hung-mount/wt", hung, false);
      expect(calls).toBe(2);
      expect(await withinCheckTime("/fast/wt", async () => true, false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
