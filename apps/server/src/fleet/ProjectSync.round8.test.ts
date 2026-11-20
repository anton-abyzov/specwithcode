// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The offline move, review round 8 follow-ups (1390): every Git child of a
 * move, also the folder probes before it binds the Git folder, runs with an
 * empty protocol allow-list, and the move's `protocol.allow` entry is added
 * to an inherited `GIT_CONFIG_COUNT` list instead of replacing it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
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
import { boundGit } from "./projectSyncGit.ts";
import { keepFetch, keptFetch, newFetchRecord } from "./projectSyncRecord.ts";
import { refTransaction } from "./refTransaction.ts";

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
type Env = Readonly<Record<string, string | undefined>>;
const real: Runner = (cwd, args, options) => runGit(cwd, args, options);

function behind() {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  write(f.a, "app.ts", "export const a = 2;\n");
  git(f.a, "commit", "-q", "-am", "published");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, was, head: git(f.a, "rev-parse", "HEAD") };
}

/** The `protocol.allow` entries an environment sets through Git's environment pairs. */
const protocolEntries = (env: Env) => {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  const out: Array<string> = [];
  for (let index = 0; index < count; index += 1)
    if (env[`GIT_CONFIG_KEY_${index}`] === "protocol.allow")
      out.push(env[`GIT_CONFIG_VALUE_${index}`] ?? "");
  return out;
};

/** Fetches B, then moves it with a runner and a transaction that note the environment of each child. */
async function moveNoting(f: { readonly b: string }) {
  const record = newFetchRecord("project-round8");
  await ProjectSync.fetchAll({ git: real, inUse: async () => null, fetched: record }, [
    { path: ".", cwd: f.b },
  ]);
  keepFetch(record);
  const children: Array<{ readonly args: string; readonly env: Env }> = [];
  const noting: Runner = (cwd, args, options) => {
    children.push({ args: args.join(" "), env: options?.env ?? {} });
    return runGit(cwd, args, options);
  };
  const step = await ProjectSync.fastForwardRepository(
    {
      git: noting,
      inUse: async () => null,
      record: () => keptFetch("project-round8", record.id),
      transaction: (cwd, message, options) => {
        children.push({ args: "update-ref --stdin", env: options?.env ?? {} });
        return refTransaction(cwd, message, options);
      },
    },
    { path: ".", cwd: f.b },
    null,
  );
  return { step, children };
}

describe("every Git child of a move has an empty protocol allow-list (follow-up 1)", () => {
  it("from the move's entry, the folder probes and the transaction included", async () => {
    const f = behind();
    const { step, children } = await moveNoting(f);
    expect(step.moved).toBe(1);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
    expect(children.length).toBeGreaterThan(0);
    const open = children.filter(
      ({ env }) => env.GIT_ALLOW_PROTOCOL !== "" || protocolEntries(env).join() !== "never",
    );
    expect(open.map(({ args }) => args)).toEqual([]);
  });
});

describe("an inherited GIT_CONFIG_COUNT list is kept (follow-up 2)", () => {
  it("a bound command still reads the inherited settings, and transport stays off", async () => {
    const f = twoMachines();
    setEnv("GIT_CONFIG_COUNT", "1");
    setEnv("GIT_CONFIG_KEY_0", "swc.inherited");
    setEnv("GIT_CONFIG_VALUE_0", "kept");
    const gitDir = NodeFS.realpathSync(NodePath.join(f.b, ".git"));
    const bound = boundGit(real, gitDir, f.b);
    const inherited = await bound(f.b, ["config", "--get", "swc.inherited"], {
      allowFailure: true,
    });
    expect(inherited.stdout.trim()).toBe("kept");
    const protocol = await bound(f.b, ["config", "--get-all", "protocol.allow"], {
      allowFailure: true,
    });
    expect(protocol.stdout.trim()).toBe("never");
  });

  it("the move's children and its transaction keep the inherited entry, with one protocol entry", async () => {
    const f = behind();
    setEnv("GIT_CONFIG_COUNT", "1");
    setEnv("GIT_CONFIG_KEY_0", "swc.inherited");
    setEnv("GIT_CONFIG_VALUE_0", "kept");
    const { step, children } = await moveNoting(f);
    expect(step.moved).toBe(1);
    const lost = children.filter(
      ({ env }) =>
        env.GIT_CONFIG_COUNT !== "2" ||
        (env.GIT_CONFIG_KEY_0 !== undefined && env.GIT_CONFIG_KEY_0 !== "swc.inherited") ||
        protocolEntries({ ...process.env, ...env }).length !== 1,
    );
    expect(lost.map(({ args }) => args)).toEqual([]);
  });
});
