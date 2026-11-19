// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A clone's staging folder while it is being set up (1390, P2-35): from the
 * moment its mark can be read, a sweep in this server knows the clone is live.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { cleanUp, git, isolateGit, restoreGit, twoMachines } from "../handoff/extrasTestKit.ts";
import { runGit } from "./folderTransfer/git.ts";
import { runSync, sweepCloneLeftovers, type SyncContext } from "./ProjectSync.ts";

/** Runs right after a staging folder got its mark, before the clone step goes on. */
const afterMark: { run: ((folder: string) => Promise<void>) | null } = { run: null };

vi.mock("./cloneStaging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloneStaging.ts")>();
  return {
    ...actual,
    markCloneStaging: async (folder: string) => {
      await actual.markCloneStaging(folder);
      await afterMark.run?.(folder);
    },
  };
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  afterMark.run = null;
  cleanUp();
});

describe("project sync: a sweep while a clone is being set up (P2-35)", () => {
  it("leaves the staging folder of a clone that has just been marked", async () => {
    const f = twoMachines();
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(f.base, "project-")));
    git(root, "init", "-q", "-b", "main");
    const config = NodePath.join(f.base, "gitconfig");
    NodeFS.writeFileSync(config, `[url "${f.base}/"]\n\tinsteadOf = https://sync.test/\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const swept: Array<{ readonly marked: boolean; readonly kept: boolean }> = [];
    // Another project's Sync on the same folder sweeps at the worst moment: the mark is
    // there, the clone has not begun.
    afterMark.run = async (folder) => {
      const marked = NodeFS.existsSync(NodePath.join(folder, "swc-clone-staging"));
      await sweepCloneLeftovers(root, [NodePath.basename(folder)]);
      swept.push({ marked, kept: NodeFS.existsSync(folder) });
    };
    try {
      const context: SyncContext = {
        git: (cwd, args, options) => runGit(cwd, args, options),
        inUse: async () => null,
      };
      const results = await runSync(context, root, [], {
        fastForward: [],
        clone: [{ path: "lib", remote: "https://sync.test/remote.git" }],
      });
      expect(swept).toEqual([{ marked: true, kept: true }]);
      expect(results[0]).toMatchObject({ action: "clone", reason: "missing", branch: "main" });
      expect(NodeFS.existsSync(NodePath.join(root, "lib", ".git"))).toBe(true);
      // Done, the folder is nobody's live clone any more: nothing of it is left.
      expect(NodeFS.readdirSync(root).filter((name) => name.startsWith(".swc-clone-"))).toEqual([]);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    }
  });

  it("leaves a marked folder another process is filling, and says so (R5-07)", async () => {
    const f = twoMachines();
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(f.base, "project-")));
    const folder = NodeFS.mkdtempSync(NodePath.join(root, ".swc-clone-lib-"));
    const name = NodePath.basename(folder);
    // Another server process marks the folder as its clone step does, and keeps running.
    const moduleUrl = new URL("./cloneStaging.ts", import.meta.url).href;
    const other = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(moduleUrl)});` +
          `await m.markCloneStaging(${JSON.stringify(folder)});` +
          'console.log("marked"); setInterval(() => {}, 1000);',
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const ended = new Promise((resolve) => other.on("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        other.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("marked")) resolve();
        });
        other.on("exit", () => reject(new Error("the other process ended early")));
      });
      const kept = await sweepCloneLeftovers(root, [name]);
      expect(NodeFS.existsSync(NodePath.join(folder, "swc-clone-staging"))).toBe(true);
      expect(kept).toEqual({ failed: [], live: [name] });
    } finally {
      other.kill();
    }
    await ended;
    // Its owner is gone now: the folder is a leftover, and goes.
    expect(await sweepCloneLeftovers(root, [name])).toEqual({ failed: [], live: [] });
    expect(NodeFS.existsSync(folder)).toBe(false);
  });
});
