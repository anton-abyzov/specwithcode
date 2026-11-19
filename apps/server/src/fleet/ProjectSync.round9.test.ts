// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The offline move, review round 9 follow-up 3 (1390): an inherited
 * `GIT_CONFIG_COUNT` that is not a plain decimal count is never rewritten;
 * the move is declined as unread, and the checkout stays where it was.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { PROJECT_SYNC_STATE_UNREAD_DETAIL } from "@specweave-studio/contracts";
import { vi } from "vite-plus/test";

import {
  cleanUp,
  git,
  isolateGit,
  restoreGit,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import { runGit } from "./folderTransfer/git.ts";
import * as ProjectSync from "./ProjectSync.ts";
import { keepFetch, keptFetch, newFetchRecord } from "./projectSyncRecord.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

const restoreEnv: Array<() => void> = [];
beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  for (const undo of restoreEnv.splice(0)) undo();
  cleanUp();
});
const setEnv = (key: string, value: string) => {
  const was = process.env[key];
  process.env[key] = value;
  restoreEnv.push(() => {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  });
};

type Runner = ProjectSync.SyncContext["git"];
const real: Runner = (cwd, args, options) => runGit(cwd, args, options);

function behind() {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  write(f.a, "app.ts", "export const a = 2;\n");
  git(f.a, "commit", "-q", "-am", "published");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, was, head: git(f.a, "rev-parse", "HEAD") };
}

// Counts Git itself reads as 1 (Git 2.50); one Git refuses, such as "1 ", fails the fetch first.
describe("a GIT_CONFIG_COUNT that is not plain decimal (follow-up 3)", () => {
  for (const count of ["01", "+1", " 1"]) {
    it(`count ${JSON.stringify(count)}: declined as unread, the branch where it was`, async () => {
      const f = behind();
      setEnv("GIT_CONFIG_COUNT", count);
      setEnv("GIT_CONFIG_KEY_0", "swc.inherited");
      setEnv("GIT_CONFIG_VALUE_0", "kept");
      const record = newFetchRecord("project-round9");
      await ProjectSync.fetchAll({ git: real, inUse: async () => null, fetched: record }, [
        { path: ".", cwd: f.b },
      ]);
      keepFetch(record);
      const step = await ProjectSync.fastForwardRepository(
        {
          git: real,
          inUse: async () => null,
          record: () => keptFetch("project-round9", record.id),
        },
        { path: ".", cwd: f.b },
        null,
      );
      expect(step.moved).toBe(0);
      expect(step.detail).toBe(PROJECT_SYNC_STATE_UNREAD_DETAIL);
      expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
    });
  }
});
