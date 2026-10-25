// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ENFORCED_INCREMENT_MESSAGE,
  NO_INCREMENT_BRIEF,
  REMINDED_INCREMENT_MESSAGE,
  launchIncrementFields,
  resolveLaunchIncrement,
  seedLaunchBinding,
  withIncrementBrief,
} from "./launchIncrement.ts";
import {
  readThreadIncrementProgress,
  specweaveStudioThreadBindingPath,
} from "./ThreadIncrementProgress.ts";

const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function increment(root: string, id: string, status = "active") {
  const folder = NodePath.join(root, ".specweave/increments", id);
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), `# ${id}\n`);
  await NodeFSP.writeFile(
    NodePath.join(folder, "metadata.json"),
    JSON.stringify({ status, title: `Title ${id}` }),
  );
  return folder;
}

async function project(mode?: string) {
  const root = await temp("launch-increment-root-");
  await NodeFSP.mkdir(NodePath.join(root, ".specweave"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, ".specweave/config.json"),
    JSON.stringify(mode === undefined ? {} : { planning: { requireIncrement: mode } }),
  );
  await increment(root, "0996-connect");
  await increment(root, "0990-shipped", "completed");
  return root;
}

async function bind(home: string, threadId: string, root: string, incrementId: string) {
  const file = specweaveStudioThreadBindingPath(threadId, home);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(
    file,
    JSON.stringify({
      version: 1,
      threadId,
      incrementId,
      root,
      taskId: "T-01",
      event: "claim",
      at: "2026-10-22T10:00:00Z",
    }),
  );
}

function launch(
  root: string,
  input: Partial<Parameters<typeof resolveLaunchIncrement>[0]> & { home?: string },
) {
  return resolveLaunchIncrement({
    workspaceRoot: root,
    worktreePath: null,
    ref: undefined,
    caller: {
      threadId: "worker",
      title: "Worker",
      branch: null,
      worktreePath: null,
      ...(input.home === undefined ? {} : { home: input.home }),
    },
    isCoordinator: false,
    ...input,
  });
}

/** A Git repository at `folder` with one commit and a linked worktree at `linked`, no user config. */
function gitCheckouts(folder: string, linked: string): void {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: folder,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: folder, stdio: "ignore", env });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "wt", linked);
}

describe("resolveLaunchIncrement", () => {
  it("resolves an explicit increment with its spec link and pickup line", async () => {
    const root = await project();
    const result = await launch(root, { ref: "0996" });
    const specPath = NodePath.join(root, ".specweave/increments/0996-connect/spec.md");
    expect(result).toEqual({
      ok: true,
      value: {
        increment: { root, incrementId: "0996-connect", title: "Title 0996-connect", specPath },
        brief: `Increment 0996-connect ([spec](${specPath})): run \`specweave pickup 0996-connect\` first.`,
      },
    });
    expect(launchIncrementFields(result.ok ? result.value : {})).toEqual({
      increment: { incrementId: "0996-connect", title: "Title 0996-connect", specPath },
    });
  });

  it("refuses a ref that is missing or closed", async () => {
    const root = await project();
    const missing = await launch(root, { ref: "0999" });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.message).toContain('Increment "0999" was not found');
    const closed = await launch(root, { ref: "0990" });
    expect(!closed.ok && closed.message).toBe(
      'Increment 0990-shipped is completed. Pass an open increment, "new" for new work, or "none".',
    );
  });

  it('briefs "new" and "none" without binding anything', async () => {
    const root = await project("enforce");
    expect(await launch(root, { ref: "new", title: 'Add "export"', isCoordinator: true })).toEqual({
      ok: true,
      value: {
        brief:
          'Plan it first: `specweave create-increment "Add export"`, fill spec.md, then edit code.',
      },
    });
    expect(await launch(root, { ref: "none", isCoordinator: true })).toEqual({
      ok: true,
      value: { brief: NO_INCREMENT_BRIEF },
    });
  });

  it("lets a worker's child inherit its open binding, but never the coordinator's", async () => {
    const root = await project();
    const home = await temp("launch-increment-home-");
    await bind(home, "worker", root, "0996-connect");
    const inherited = await launch(root, { home });
    expect(inherited).toMatchObject({
      ok: true,
      value: {
        // The claim's root, after links.
        increment: {
          incrementId: "0996-connect",
          root: await NodeFSP.realpath(root),
          inheritedFrom: "worker",
        },
      },
    });
    expect(inherited.ok && inherited.value.brief).toContain("specweave pickup 0996-connect");
    expect(await launch(root, { home, isCoordinator: true })).toEqual({ ok: true, value: {} });
    // A closed increment is not passed on.
    await bind(home, "worker", root, "0990-shipped");
    expect(await launch(root, { home })).toEqual({ ok: true, value: {} });
  });

  it("passes on a binding in the caller's own worktree only to a thread that can read it", async () => {
    const root = await project();
    const home = await temp("launch-increment-home-");
    // Worker A planned 1001 in its worktree; the project root does not have it.
    const workerTree = await temp("launch-increment-worker-");
    await increment(workerTree, "1001-feature");
    await bind(home, "worker", workerTree, "1001-feature");
    const caller = {
      threadId: "worker",
      title: "Worker",
      branch: null,
      worktreePath: workerTree,
      home,
    };
    // A child sharing A's checkout inherits it.
    expect(await launch(root, { worktreePath: workerTree, caller })).toMatchObject({
      ok: true,
      value: { increment: { incrementId: "1001-feature", inheritedFrom: "worker" } },
    });
    // A thread in the project root or a new worktree (null before it exists) does not.
    expect(await launch(root, { caller })).toEqual({
      ok: true,
      value: {
        warning:
          "Increment 1001-feature was not passed on: the new thread's checkout does not have it. Pass increment to name one it has.",
      },
    });
  });

  it("looks up an explicit ref in the caller's worktree when the project lacks it", async () => {
    const root = await project();
    const workerTree = await temp("launch-increment-worker-");
    await increment(workerTree, "1001-feature");
    expect((await launch(root, { ref: "1001" })).ok).toBe(false);
    const result = await launch(root, { ref: "1001", fallbackWorktreePath: workerTree });
    expect(result).toMatchObject({
      ok: true,
      value: {
        increment: { root: workerTree, incrementId: "1001-feature" },
        warning: expect.stringContaining("only if its base branch does"),
      },
    });
    // The project's own increment wins, with no warning.
    const own = await launch(root, { ref: "0996", fallbackWorktreePath: workerTree });
    expect(own).toMatchObject({
      ok: true,
      value: { increment: { root, incrementId: "0996-connect" } },
    });
    expect(own.ok && own.value.warning).toBeUndefined();
  });

  it("refuses a coordinator without an increment under enforce, and warns otherwise", async () => {
    const enforced = await project("enforce");
    const home = await temp("launch-increment-home-");
    expect(await launch(enforced, { home, isCoordinator: true })).toEqual({
      ok: false,
      message: ENFORCED_INCREMENT_MESSAGE,
    });
    expect(await launch(enforced, { home })).toEqual({
      ok: true,
      value: { warning: ENFORCED_INCREMENT_MESSAGE },
    });
    const reminded = await project("remind");
    expect(await launch(reminded, { home, isCoordinator: true })).toEqual({
      ok: true,
      value: { warning: REMINDED_INCREMENT_MESSAGE },
    });
    expect(await launch(await project(), { home, isCoordinator: true })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("leaves a project without SpecWeave alone", async () => {
    const plain = await temp("launch-increment-plain-");
    expect(await launch(plain, { isCoordinator: true })).toEqual({ ok: true, value: {} });
    expect((await launch(plain, { ref: "0996" })).ok).toBe(false);
  });

  it("appends the brief to the task, or stands alone for an empty one", () => {
    expect(withIncrementBrief("Fix it.", { brief: "Line." })).toBe("Fix it.\n\nLine.");
    expect(withIncrementBrief("", { brief: "Line." })).toBe("Line.");
    expect(withIncrementBrief("Fix it.", {})).toBe("Fix it.");
  });
});

describe("seedLaunchBinding", () => {
  it("binds the worktree when it holds the increment, else the root resolved before launch", async () => {
    const root = await project();
    const home = await temp("launch-increment-home-");
    const worktree = await temp("launch-increment-worktree-");
    await increment(worktree, "0996-connect");
    const read = async (threadId: string) =>
      JSON.parse(await NodeFSP.readFile(specweaveStudioThreadBindingPath(threadId, home), "utf8"));
    const seeded = { root, incrementId: "0996-connect" };
    expect(
      await seedLaunchBinding({
        threadId: "in-worktree",
        increment: seeded,
        workspaceRoot: root,
        worktreePath: worktree,
        home,
      }),
    ).toBe(true);
    expect(await read("in-worktree")).toMatchObject({ root: worktree, event: "studio-launch" });
    // A worktree with SpecWeave but without this increment (made before it was planned).
    const bare = await temp("launch-increment-bare-");
    await NodeFSP.mkdir(NodePath.join(bare, ".specweave/increments"), { recursive: true });
    expect(
      await seedLaunchBinding({
        threadId: "fallback",
        increment: seeded,
        workspaceRoot: root,
        worktreePath: bare,
        home,
      }),
    ).toBe(true);
    expect(await read("fallback")).toMatchObject({ root, incrementId: "0996-connect" });
  });

  it("resolves an explicit ref planned in another registered checkout, but never inherits one", async () => {
    const root = await NodeFSP.realpath(await project());
    const home = await temp("launch-increment-home-");
    const owner = `${root}-owner's tree`;
    roots.push(owner);
    gitCheckouts(root, owner);
    await increment(owner, "1009-shared");
    // The owner thread works on 1009 in its worktree; the project root lacks it.
    const resolved = await launch(root, { ref: "1009" });
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        increment: { root: owner, incrementId: "1009-shared", registered: true },
        warning: expect.stringContaining("another checkout of this repository"),
      },
    });
    // The brief tries the worker's own checkout first, then names where the
    // increment is planned (SpecWeave resolves increments from the current directory).
    const brief = resolved.ok ? (resolved.value.brief ?? "") : "";
    expect(brief).toContain("run `specweave pickup 1009-shared` first.");
    const command = /run `(cd [^`]+)` instead/u.exec(brief);
    expect(command?.[1]).toContain("specweave pickup 1009-shared");
    // The quoting is POSIX shell quoting; Windows has no /bin/sh to run it with.
    if (process.platform !== "win32") {
      const bin = await temp("launch-increment-bin-");
      await NodeFSP.writeFile(
        NodePath.join(bin, "specweave"),
        '#!/bin/sh\nprintf "%s|%s" "$(pwd -P)" "$*"\n',
        { mode: 0o755 },
      );
      expect(
        NodeChildProcess.execFileSync("/bin/sh", ["-c", command![1]!], {
          cwd: root,
          env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
          encoding: "utf8",
        }),
      ).toBe(`${owner}|pickup 1009-shared`);
    }
    const increment1009 = resolved.ok ? resolved.value.increment! : null;
    expect(
      await seedLaunchBinding({
        threadId: "ps23",
        increment: increment1009!,
        workspaceRoot: root,
        worktreePath: null,
        home,
      }),
    ).toBe(true);
    const [progress] = await readThreadIncrementProgress(root, [
      { threadId: "ps23", title: null, branch: null, worktreePath: null, home },
    ]);
    expect(progress).toMatchObject({ incrementId: "1009-shared", binding: "claim" });

    // Inherited from a caller bound there, it is not passed on.
    await bind(home, "worker", owner, "1009-shared");
    expect(await launch(root, { home })).toEqual({
      ok: true,
      value: {
        warning:
          "Increment 1009-shared was not passed on: the new thread's checkout does not have it. Pass increment to name one it has.",
      },
    });
    // Without the explicit flag the same root is not seeded.
    expect(
      await seedLaunchBinding({
        threadId: "child",
        increment: { root: owner, incrementId: "1009-shared" },
        workspaceRoot: root,
        worktreePath: null,
        home,
      }),
    ).toBe(false);
  });

  it("never seeds another thread's worktree as the root", async () => {
    const root = await project();
    const home = await temp("launch-increment-home-");
    const workerTree = await temp("launch-increment-worker-");
    await increment(workerTree, "1001-feature");
    const seeded = { root: workerTree, incrementId: "1001-feature" };
    const file = (threadId: string) => specweaveStudioThreadBindingPath(threadId, home);
    // B's new worktree lacks 1001 (it is only on A's branch): nothing is written.
    const sibling = await temp("launch-increment-sibling-");
    await NodeFSP.mkdir(NodePath.join(sibling, ".specweave/increments"), { recursive: true });
    expect(
      await seedLaunchBinding({
        threadId: "sibling",
        increment: seeded,
        workspaceRoot: root,
        worktreePath: sibling,
        home,
      }),
    ).toBe(false);
    await expect(NodeFSP.stat(file("sibling"))).rejects.toThrow();
    // Its base branch had 1001: the seed re-roots to B's worktree, and B's plan card shows it.
    await increment(sibling, "1001-feature");
    expect(
      await seedLaunchBinding({
        threadId: "sibling",
        increment: seeded,
        workspaceRoot: root,
        worktreePath: sibling,
        home,
      }),
    ).toBe(true);
    const [progress] = await readThreadIncrementProgress(root, [
      { threadId: "sibling", title: null, branch: null, worktreePath: sibling, home },
    ]);
    expect(progress).toMatchObject({ incrementId: "1001-feature", binding: "claim" });
  });
});
