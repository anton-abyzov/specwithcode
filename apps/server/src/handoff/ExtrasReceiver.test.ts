// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";

import { type EffectiveWorkGrant, unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { createBundle } from "./bundleGit.ts";
import {
  checkedOutBranches,
  extraBranchName,
  extraId,
  extrasProject,
  landExtra,
} from "./ExtrasReceiver.ts";
import {
  allRefs,
  branches,
  cleanUp,
  commit,
  git,
  isolateGit,
  restoreGit,
  snapshot,
  twoMachines,
} from "./extrasTestKit.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const OPERATION = "0a1b2c3d-1111-4222-8333-444455556666";

/** Bundles `ref` on the source as the sender does, leaving out what `exclude` reaches. */
async function bundleOf(source: string, branch: string, exclude: ReadonlyArray<string>) {
  const tip = git(source, "rev-parse", `refs/heads/${branch}`);
  const bundle = await createBundle({
    root: source,
    ref: `refs/heads/${branch}`,
    commit: tip,
    exclude,
  });
  try {
    return { tip, bytes: new Uint8Array(NodeFS.readFileSync(bundle.path)) };
  } finally {
    await bundle.dispose();
  }
}

async function send(
  f: { a: string; b: string },
  branch: string,
  options: { readonly operationId?: string; readonly leaf?: string } = {},
) {
  const base = git(f.b, "rev-parse", "refs/remotes/origin/main");
  const { tip, bytes } = await bundleOf(f.a, branch, [base]);
  const landed = await landExtra({
    root: f.b,
    bundle: bytes,
    commit: tip,
    sourceLabel: "M4",
    leaf: options.leaf ?? branch,
    operationId: options.operationId ?? OPERATION,
  });
  return { tip, landed };
}

describe("landing a Sync extra (1390 AC-13)", () => {
  it("arrives as swc/from-{machine}/{branch} and touches nothing else", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    const before = snapshot(f.b);
    const ownBranches = branches(f.b);
    const { tip, landed } = await send(f, "feature");
    expect(landed).toEqual({ branch: "swc/from-M4/feature", landed: "created" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/feature")).toBe(tip);
    // No file in the working folder, the same checked-out branch, the same own branches.
    expect(snapshot(f.b)).toEqual(before);
    expect(branches(f.b).filter((line) => !line.startsWith("swc/from-"))).toEqual(ownBranches);
    expect(NodeFS.existsSync(NodePath.join(f.b, "feature.ts"))).toBe(false);
    // The hidden incoming ref is gone again.
    expect(allRefs(f.b)).not.toContain("refs/specwithcode/extras-incoming/");
  });

  it("makes a machine label safe for a ref name", () => {
    expect(extraBranchName("M4", "main")).toBe("swc/from-M4/main");
    const odd = extraBranchName("Anton's MacBook: M4 Max", "main");
    expect(odd).toMatch(/^swc\/from-Anton-s-MacBook-M4-Max-[0-9a-f]{16}\/main$/);
    expect(extraId(OPERATION)).toBe("0a1b2c");
  });

  it("moves the branch forward when the new head continues it, and repeats change nothing", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    await send(f, "feature");
    expect((await send(f, "feature")).landed).toEqual({
      branch: "swc/from-M4/feature",
      landed: "unchanged",
    });
    commit(f.a, "feature.ts", "export const feature = 2;\n");
    const { tip, landed } = await send(f, "feature");
    expect(landed).toEqual({ branch: "swc/from-M4/feature", landed: "moved-forward" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/feature")).toBe(tip);
  });

  it("arrives beside a branch whose history it does not continue", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    const first = await send(f, "feature");
    git(f.a, "reset", "-q", "--hard", "origin/main");
    commit(f.a, "feature.ts", "export const feature = 'rewritten';\n");
    const second = await send(f, "feature");
    expect(second.landed).toEqual({ branch: "swc/from-M4/feature-0a1b2c", landed: "beside" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/feature")).toBe(first.tip);
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/feature-0a1b2c")).toBe(second.tip);
  });

  it("arrives beside a branch that is checked out in the project folder", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    await send(f, "feature");
    git(f.b, "checkout", "-q", "swc/from-M4/feature");
    commit(f.a, "feature.ts", "export const feature = 2;\n");
    const before = snapshot(f.b);
    const { tip, landed } = await send(f, "feature");
    expect(landed).toEqual({ branch: "swc/from-M4/feature-0a1b2c", landed: "checked-out" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/feature-0a1b2c")).toBe(tip);
    // The checked-out branch, its index and its files did not move.
    expect(snapshot(f.b)).toEqual(before);
  });

  it("arrives beside a branch that is checked out in another worktree", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    await send(f, "feature");
    const worktree = NodePath.join(f.base, "b-worktree");
    git(f.b, "worktree", "add", "-q", worktree, "swc/from-M4/feature");
    expect(await checkedOutBranches(f.b)).toEqual(new Set(["main", "swc/from-M4/feature"]));
    commit(f.a, "feature.ts", "export const feature = 2;\n");
    const before = snapshot(worktree);
    const { landed } = await send(f, "feature");
    expect(landed).toEqual({ branch: "swc/from-M4/feature-0a1b2c", landed: "checked-out" });
    expect(snapshot(worktree)).toEqual(before);
    // A second run that day gets its own name beside it.
    commit(f.a, "feature.ts", "export const feature = 3;\n");
    const again = await send(f, "feature", {
      operationId: "ffeedd00-1111-4222-8333-444455556666",
    });
    expect(again.landed).toEqual({ branch: "swc/from-M4/feature-ffeedd", landed: "checked-out" });
  });

  it("arrives beside a name Git cannot create, such as a branch that is a folder there", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "topic");
    commit(f.a, "topic.ts", "export const topic = 1;\n");
    // `swc/from-M4/topic/sub` exists here, so `swc/from-M4/topic` cannot be a branch.
    git(f.b, "branch", "swc/from-M4/topic/sub");
    const { tip, landed } = await send(f, "topic");
    expect(landed).toEqual({ branch: "swc/from-M4/topic-0a1b2c", landed: "beside" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/topic-0a1b2c")).toBe(tip);
  });

  it("never moves a branch of the destination's own, even one with the same name", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 'from the source';\n");
    const before = snapshot(f.b);
    const { tip, landed } = await send(f, "main");
    expect(landed).toEqual({ branch: "swc/from-M4/main", landed: "created" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/main")).toBe(tip);
    expect(snapshot(f.b)).toEqual(before);
  });

  it("carries the whole branch when the destination holds none of its commits", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "--orphan", "island");
    commit(f.a, "island.ts", "export const island = 1;\n");
    const { tip, bytes } = await bundleOf(f.a, "island", []);
    const landed = await landExtra({
      root: f.b,
      bundle: bytes,
      commit: tip,
      sourceLabel: "M4",
      leaf: "island",
      operationId: OPERATION,
    });
    expect(landed).toEqual({ branch: "swc/from-M4/island", landed: "created" });
  });

  it("pins a commit the destination already holds, with no bundle", async () => {
    const f = twoMachines();
    const head = git(f.b, "rev-parse", "HEAD");
    const landed = await landExtra({
      root: f.b,
      bundle: null,
      commit: head,
      sourceLabel: "M4",
      leaf: "main",
      operationId: OPERATION,
    });
    expect(landed).toEqual({ branch: "swc/from-M4/main", landed: "created" });
  });

  it("refuses a bundle that is not the commit named, a bad name, and a missing base", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    const before = allRefs(f.b);
    const base = git(f.b, "rev-parse", "HEAD");
    const { tip, bytes } = await bundleOf(f.a, "feature", [base]);
    const land = (change: Partial<Parameters<typeof landExtra>[0]>) =>
      landExtra({
        root: f.b,
        bundle: bytes,
        commit: tip,
        sourceLabel: "M4",
        leaf: "feature",
        operationId: OPERATION,
        ...change,
      });
    await expect(land({ commit: base })).rejects.toMatchObject({ code: "mismatch" });
    await expect(land({ bundle: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({
      code: "invalid",
    });
    for (const leaf of ["", "-x", "a..b", "a b", "x.lock", "a\nb", "../../heads/main"])
      await expect(land({ leaf }), leaf).rejects.toMatchObject({ code: "invalid" });
    // A bundle whose base this repository lacks.
    commit(f.a, "feature.ts", "export const feature = 2;\n");
    const later = await bundleOf(f.a, "feature", [tip]);
    await expect(land({ bundle: later.bytes, commit: later.tip })).rejects.toMatchObject({
      code: "missing_prerequisites",
    });
    expect(allRefs(f.b)).toBe(before);
  });
});

describe("who may send extras here (1390 AC-13)", () => {
  const m4 = EnvironmentId.make("env-m4");
  const m5 = EnvironmentId.make("env-m5");
  const other = EnvironmentId.make("env-other");
  const members = [
    { environmentId: m4, projectId: "project-m4" },
    { environmentId: m5, projectId: "project-m5" },
  ];
  const project = (change: Record<string, unknown> = {}) =>
    ({
      id: ProjectId.make("project-m5"),
      title: "App",
      workspaceRoot: "/tmp/app",
      workspaceSettings: { logicalProject: { members } },
      ...change,
    }) as never;
  const grant = (change: Partial<EffectiveWorkGrant> = {}): EffectiveWorkGrant => ({
    ...unscopedGrant(m4),
    ...change,
  });
  const ask = (change: Partial<Parameters<typeof extrasProject>[0]> = {}) =>
    extrasProject({
      projects: [project()],
      selfEnvironmentId: m5,
      caller: { sourceEnvironmentId: m4, grant: grant() },
      sourceEnvironmentId: m4,
      sourceProjectId: "project-m4",
      ...change,
    });

  it("accepts the linked project under the work grant", () => {
    expect(ask()).toMatchObject({ kind: "project", project: { id: "project-m5" } });
  });

  it("refuses a request that names another machine than the one asking", () => {
    expect(ask({ sourceEnvironmentId: other })).toMatchObject({ kind: "refused", status: 403 });
    expect(ask({ caller: { sourceEnvironmentId: other, grant: grant() } })).toMatchObject({
      kind: "refused",
      status: 403,
    });
  });

  it("refuses a project that is not linked both ways, or linked twice", () => {
    expect(ask({ sourceProjectId: "project-else" })).toMatchObject({
      kind: "refused",
      check: "project-link",
    });
    expect(
      ask({
        projects: [project({ workspaceSettings: { logicalProject: { members: [members[0]!] } } })],
      }),
    ).toMatchObject({ kind: "refused", check: "project-link" });
    expect(
      ask({ projects: [project(), project({ id: "project-m5", title: "Twin" })] }),
    ).toMatchObject({ kind: "refused", check: "project-link" });
    expect(ask({ projects: [project({ deletedAt: "2026-11-18T00:00:00.000Z" })] })).toMatchObject({
      kind: "refused",
      check: "project-link",
    });
  });

  it("refuses without a grant, and a grant that does not cover the project", () => {
    expect(ask({ caller: { sourceEnvironmentId: m4, grant: null } })).toMatchObject({
      kind: "refused",
      status: 403,
      code: "needs_grant",
      check: "grant",
    });
    expect(
      ask({
        caller: {
          sourceEnvironmentId: m4,
          grant: grant({ projects: { kind: "listed", projectIds: [] } as never }),
        },
      }),
    ).toMatchObject({ kind: "refused", code: "needs_grant" });
  });

  it("never lands work in a personal project", () => {
    expect(
      ask({
        projects: [
          project({
            workspaceSettings: { kind: "personal", logicalProject: { members } },
          }),
        ],
      }),
    ).toMatchObject({ kind: "refused" });
  });
});
