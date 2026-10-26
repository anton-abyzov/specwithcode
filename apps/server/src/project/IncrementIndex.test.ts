// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  incrementExists,
  listProjectIncrements,
  queryProjectIncrements,
  resolveIncrementRef,
} from "./ThreadIncrementProgress.ts";

const COUNT = 3_000;
const STATUSES = ["completed", "completed", "completed", "active", "abandoned"];
let root = "";

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-increment-index-"));
  const folder = NodePath.join(root, ".specweave/increments");
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, ".specweave/config.json"), "{}");
  for (let start = 1; start <= COUNT; start += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, COUNT - start + 1) }, async (_, offset) => {
        const n = start + offset;
        const id = `${String(n).padStart(4, "0")}-feature-${n}`;
        await NodeFSP.mkdir(NodePath.join(folder, id));
        // Every 100th increment has no metadata, like one made without SpecWithCode.
        if (n % 100 === 0) return;
        await NodeFSP.writeFile(
          NodePath.join(folder, id, "metadata.json"),
          JSON.stringify({
            status: STATUSES[n % STATUSES.length],
            title: n === 17 ? "Billing retries for Stripe" : `Feature ${n}`,
          }),
        );
      }),
    );
  }
}, 60_000);

afterAll(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("queryProjectIncrements", () => {
  it("pages 3,000 increments newest first with totals and status counts", async () => {
    const first = await queryProjectIncrements(root, null, { limit: 50 });
    expect(first.total).toBe(COUNT);
    expect(first.increments).toHaveLength(50);
    expect(first.increments[0]!.incrementId).toBe("3000-feature-3000");
    expect(first.increments[0]!.status).toBe("unknown");
    const counts = first.statusCounts;
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(COUNT);
    expect(counts.unknown).toBe(30);
    const last = await queryProjectIncrements(root, null, { offset: 2_950, limit: 50 });
    expect(last.increments.map((entry) => entry.incrementId).at(-1)).toBe("0001-feature-1");
  });

  it("finds an old increment by title words or id, at any page", async () => {
    const byTitle = await queryProjectIncrements(root, null, { query: "stripe BILLING" });
    expect(byTitle.increments.map((entry) => entry.incrementId)).toEqual(["0017-feature-17"]);
    expect(byTitle.total).toBe(1);
    const byId = await queryProjectIncrements(root, null, { query: "0042" });
    expect(byId.increments.map((entry) => entry.incrementId)).toEqual(["0042-feature-42"]);
  });

  it("filters by status and keeps the counts of the whole query", async () => {
    const active = await queryProjectIncrements(root, null, { status: "active", limit: 10 });
    expect(active.increments.every((entry) => entry.status === "active")).toBe(true);
    expect(active.total).toBe(active.statusCounts.active);
    expect(active.statusCounts.completed).toBeGreaterThan(active.total);
  });

  it("answers again from the metadata cache, and sees a changed file", async () => {
    const started = performance.now();
    await queryProjectIncrements(root, null, { query: "feature-2999" });
    expect(performance.now() - started).toBeLessThan(2_000);
    const file = NodePath.join(root, ".specweave/increments/2999-feature-2999/metadata.json");
    await NodeFSP.writeFile(file, JSON.stringify({ status: "active", title: "Renamed later on" }));
    const renamed = await queryProjectIncrements(root, null, { query: "renamed later" });
    expect(renamed.increments).toEqual([
      { incrementId: "2999-feature-2999", title: "Renamed later on", status: "active" },
    ]);
  });

  it("keeps the old unpaged answer for older clients", async () => {
    expect(await listProjectIncrements(root, null)).toHaveLength(300);
  });

  it("checks a link target past the first page without listing", async () => {
    expect(await incrementExists(root, null, "0001-feature-1")).toBe(true);
    expect(await incrementExists(root, null, "0001-missing")).toBe(false);
    expect(await incrementExists(root, null, "../../etc")).toBe(false);
  });

  it("lists SpecWeave's lettered increments, like 0657E, beside the plain one", async () => {
    const lettered = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "studio-increment-lettered-"),
    );
    for (const [id, status] of [
      ["0657-dark-theme", "completed"],
      ["0657E-dark-theme-followup", "completed"],
      ["0713B-production-rollout", "abandoned"],
    ] as const) {
      await NodeFSP.mkdir(NodePath.join(lettered, ".specweave/increments", id), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(lettered, ".specweave/increments", id, "metadata.json"),
        JSON.stringify({ status }),
      );
    }
    const all = await queryProjectIncrements(lettered, null);
    expect(all.total).toBe(3);
    expect(all.statusCounts).toEqual({ completed: 2, abandoned: 1 });
    expect(all.increments.map((entry) => entry.incrementId).sort()).toEqual([
      "0657-dark-theme",
      "0657E-dark-theme-followup",
      "0713B-production-rollout",
    ]);
    expect(await incrementExists(lettered, null, "0713B-production-rollout")).toBe(true);
    const ref = await resolveIncrementRef(lettered, null, "0657");
    expect(ref).toMatchObject({ kind: "closed", incrementId: "0657-dark-theme" });
    await NodeFSP.rm(lettered, { recursive: true, force: true });
  });

  it("answers empty for a project with no increments", async () => {
    const plain = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-increment-none-"));
    expect(await queryProjectIncrements(plain, null)).toEqual({
      increments: [],
      total: 0,
      statusCounts: {},
    });
    await NodeFSP.rm(plain, { recursive: true, force: true });
  });
});
