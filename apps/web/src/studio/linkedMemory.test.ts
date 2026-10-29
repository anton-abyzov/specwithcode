import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, LinkedMemoryExport, ProjectId } from "@specweave-studio/contracts";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));

const { linkedMemory, linkedMemoryGroups, syncLinkedMemory } = await import("./linkedMemory");
type Member = Parameters<typeof syncLinkedMemory>[0][number][number];

const project = (environmentId: string, id: string, logicalProjectId?: string) =>
  ({
    environmentId,
    id,
    workspaceSettings: logicalProjectId ? { logicalProject: { id: logicalProjectId } } : {},
  }) as unknown as EnvironmentProject;
const member = (environmentId: string, projectId = `${environmentId}-copy`): Member => ({
  environmentId: environmentId as EnvironmentId,
  projectId: projectId as ProjectId,
  label: environmentId.toUpperCase(),
});
const memory = (
  environmentId: string,
  files: Record<string, string>,
  extra: Partial<LinkedMemoryExport> = {},
): LinkedMemoryExport =>
  ({
    logicalProjectId: "logical:1",
    environmentId,
    files: Object.entries(files).map(([name, sha]) => ({
      name,
      content: sha,
      contentSha256: sha,
      updatedAt: "2026-10-19T00:00:00.000Z",
      history: [sha],
    })),
    tombstones: [],
    truncated: false,
    ...extra,
  }) as LinkedMemoryExport;

/** Records every call in order; exports come from `exports`, a thrown value or null. */
function recorder(
  exports: Record<string, LinkedMemoryExport | null | Error>,
  mergeFails: ReadonlySet<string> = new Set(),
) {
  const calls: string[] = [];
  const mismatches: string[] = [];
  return {
    calls,
    mismatches,
    driver: {
      exportMemory: async (target: Member, options?: { digestOnly?: boolean }) => {
        calls.push(`export ${target.environmentId}${options?.digestOnly ? " digest" : ""}`);
        const found = exports[target.environmentId];
        if (found instanceof Error) throw found;
        return found ?? null;
      },
      mergeMemory: async (target: Member, peer: Member, from: LinkedMemoryExport) => {
        calls.push(
          `merge ${from.environmentId} into ${target.environmentId} from ${peer.environmentId}`,
        );
        if (mergeFails.has(target.environmentId)) throw new Error("refused");
        return true;
      },
      reportMismatch: (left: Member, right: Member) =>
        mismatches.push(`${left.environmentId}/${right.environmentId}`),
    },
  };
}

/**
 * Machines that page: each holds files (name to hash), sends `pageSize` files
 * per page and a digest, and a merge takes the higher hash of every file, so
 * one pass converges unless `stubborn` refuses to take anything.
 */
function pagingMachines(
  stores: Record<string, Record<string, string>>,
  { pageSize = 2, stubborn = "" }: { pageSize?: number; stubborn?: string } = {},
) {
  const calls: string[] = [];
  const mismatches: string[] = [];
  const ordered = (environmentId: string) =>
    Object.entries(stores[environmentId]!).toSorted(([a], [b]) =>
      a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a < b ? -1 : 1,
    );
  const digest = (environmentId: string) => JSON.stringify(ordered(environmentId));
  return {
    calls,
    mismatches,
    stores,
    driver: {
      exportMemory: async (target: Member, options?: { cursor?: string; digestOnly?: boolean }) => {
        const id = target.environmentId;
        calls.push(
          `export ${id}${options?.digestOnly ? " digest" : options?.cursor ? ` @${options.cursor}` : ""}`,
        );
        if (options?.digestOnly)
          return memory(id, {}, { digest: digest(id), truncated: true } as never);
        const start = Number(options?.cursor ?? 0);
        const all = ordered(id);
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        return memory(id, Object.fromEntries(page), {
          truncated: more,
          digest: digest(id),
          ...(more ? { nextCursor: String(start + pageSize) } : {}),
        } as never);
      },
      mergeMemory: async (target: Member, _peer: Member, from: LinkedMemoryExport) => {
        calls.push(
          `merge ${from.files.map((file) => file.name).join(",")} into ${target.environmentId}`,
        );
        if (target.environmentId === stubborn) return false;
        const store = stores[target.environmentId]!;
        for (const file of from.files)
          if ((store[file.name] ?? "") < file.contentSha256) store[file.name] = file.contentSha256;
        return true;
      },
      reportMismatch: (left: Member, right: Member) =>
        mismatches.push(`${left.environmentId}/${right.environmentId}`),
    },
  };
}

describe("linked memory sync", () => {
  it("uses the two linked-memory RPC methods", () => {
    expect(linkedMemory).toEqual({
      export: "projectLink.memoryExport",
      merge: "projectLink.memoryMerge",
    });
  });

  it("groups ready copies of one linked project that sit on two or more machines", () => {
    const groups = linkedMemoryGroups(
      [
        project("m3", "kept", "logical:1"),
        project("m4", "joined", "logical:1"),
        project("m5", "offline", "logical:1"),
        project("m4", "solo", "logical:2"),
        project("m4", "a", "logical:3"),
        project("m4", "b", "logical:3"),
        project("m1", "plain"),
      ],
      (environmentId) => environmentId !== "m5",
      (environmentId) => `Machine ${environmentId}`,
    );
    expect(groups).toEqual([
      [
        { environmentId: "m3", projectId: "kept", label: "Machine m3" },
        { environmentId: "m4", projectId: "joined", label: "Machine m4" },
      ],
    ]);
  });

  it("exports both sides of every pair before merging either way", async () => {
    const { calls, driver } = recorder({
      a: memory("a", { "MEMORY.md": "1" }),
      b: memory("b", { "MEMORY.md": "2" }),
      c: memory("c", { "notes.md": "3" }),
    });
    await syncLinkedMemory([[member("a"), member("b"), member("c")]], driver);
    expect(calls.filter((call) => call.startsWith("merge"))).toEqual([
      "merge b into a from b",
      "merge a into b from a",
      "merge b into a from b",
      "merge a into b from a",
      "merge c into a from c",
      "merge a into c from a",
      "merge c into a from c",
      "merge a into c from a",
      "merge c into b from c",
      "merge b into c from b",
      "merge c into b from c",
      "merge b into c from b",
    ]);
    // Neither side changes in this stub, so every pair is retried once and then reported.
    expect(calls.slice(0, 4)).toEqual([
      "export a",
      "export b",
      "merge b into a from b",
      "merge a into b from a",
    ]);
  });

  it("skips a pair whose copies already hold the same memory", async () => {
    const same = { "MEMORY.md": "1", "notes.md": "2" };
    const { calls, driver } = recorder({ a: memory("a", same), b: memory("b", same) });
    await syncLinkedMemory([[member("a"), member("b")]], driver);
    expect(calls).toEqual(["export a", "export b"]);
  });

  it("still merges matching copies when an export was cut short", async () => {
    const same = { "MEMORY.md": "1" };
    const { calls, driver } = recorder({
      a: memory("a", same, { truncated: true }),
      b: memory("b", same),
    });
    await syncLinkedMemory([[member("a"), member("b")]], driver);
    expect(calls.filter((call) => call.startsWith("merge"))).toHaveLength(2);
  });

  it("merges when only the deletions differ", async () => {
    const { calls, driver } = recorder({
      a: memory("a", {}, {
        tombstones: [{ name: "old.md", deletedAt: "2026-10-19T00:00:00.000Z", history: ["x"] }],
      } as Partial<LinkedMemoryExport>),
      b: memory("b", {}),
    });
    await syncLinkedMemory([[member("a"), member("b")]], driver);
    // Two each way: the stub never converges, so the pair gets its one retry.
    expect(calls.filter((call) => call.startsWith("merge"))).toHaveLength(4);
  });

  it("skips a pair when either copy cannot be read and carries on with the rest", async () => {
    const { calls, driver } = recorder({
      a: null,
      b: new Error("offline"),
      c: memory("c", { "MEMORY.md": "3" }),
      d: memory("d", { "MEMORY.md": "4" }),
    });
    await syncLinkedMemory(
      [
        [member("a"), member("b")],
        [member("b"), member("c")],
        [member("c"), member("d")],
      ],
      driver,
    );
    expect(calls.slice(0, 6)).toEqual([
      "export a",
      "export b",
      "export c",
      "export d",
      "merge d into c from d",
      "merge c into d from c",
    ]);
  });

  it("still merges into the second copy when the first refuses", async () => {
    const { calls, driver } = recorder(
      { a: memory("a", { "MEMORY.md": "1" }), b: memory("b", { "MEMORY.md": "2" }) },
      new Set(["a"]),
    );
    await expect(syncLinkedMemory([[member("a"), member("b")]], driver)).resolves.toBeUndefined();
    expect(calls.filter((call) => call.startsWith("merge"))).toEqual([
      "merge b into a from b",
      "merge a into b from a",
      "merge b into a from b",
      "merge a into b from a",
    ]);
  });

  it("never pairs two copies on the same machine", async () => {
    const { calls, driver } = recorder({ a: memory("a", { "MEMORY.md": "1" }) });
    await syncLinkedMemory([[member("a", "one"), member("a", "two")]], driver);
    expect(calls).toEqual([]);
  });

  it("reports a pair that still differs after one retry", async () => {
    const { mismatches, driver } = recorder({
      a: memory("a", { "MEMORY.md": "1" }),
      b: memory("b", { "MEMORY.md": "2" }),
    });
    await syncLinkedMemory([[member("a"), member("b")]], driver);
    expect(mismatches).toEqual(["a/b"]);
  });

  it("does not report a copy too old to send all of its memory", async () => {
    const { mismatches, calls, driver } = recorder({
      a: memory("a", { "MEMORY.md": "1" }, { truncated: true }),
      b: memory("b", { "MEMORY.md": "1" }),
    });
    await syncLinkedMemory([[member("a"), member("b")]], driver);
    expect(calls.filter((call) => call.startsWith("merge"))).toHaveLength(2);
    expect(mismatches).toEqual([]);
  });

  it("fetches every page of both sides before merging, then confirms by digest", async () => {
    const machines = pagingMachines({
      a: { "MEMORY.md": "1", "a1.md": "1", "a2.md": "1", "a3.md": "1" },
      b: { "MEMORY.md": "2", "b1.md": "2" },
    });
    await syncLinkedMemory([[member("a"), member("b")]], machines.driver);
    expect(machines.calls).toEqual([
      "export a",
      "export b",
      "export a @2",
      "merge MEMORY.md,b1.md into a",
      "merge MEMORY.md,a1.md into b",
      "merge a2.md,a3.md into b",
      "export a digest",
      "export b digest",
    ]);
    expect(machines.stores.a).toEqual(machines.stores.b);
    expect(Object.keys(machines.stores.b!)).toHaveLength(5);
    expect(machines.mismatches).toEqual([]);
  });

  it("stops after the first pages when both whole-memory digests already match", async () => {
    const same = { "MEMORY.md": "1", "a1.md": "1", "a2.md": "1", "a3.md": "1" };
    const machines = pagingMachines({ a: { ...same }, b: { ...same } });
    await syncLinkedMemory([[member("a"), member("b")]], machines.driver);
    expect(machines.calls).toEqual(["export a", "export b"]);
  });

  it("retries a pair whose digests differ once, then reports it", async () => {
    const machines = pagingMachines(
      { a: { "MEMORY.md": "1" }, b: { "MEMORY.md": "2" } },
      { stubborn: "a" },
    );
    await syncLinkedMemory([[member("a"), member("b")]], machines.driver);
    expect(machines.calls.filter((call) => call.endsWith("digest"))).toHaveLength(4);
    expect(machines.calls.filter((call) => call.startsWith("merge"))).toHaveLength(4);
    expect(machines.mismatches).toEqual(["a/b"]);
  });
});
