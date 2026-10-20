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
  return {
    calls,
    driver: {
      exportMemory: async (target: Member) => {
        calls.push(`export ${target.environmentId}`);
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
    expect(calls).toEqual([
      "export a",
      "export b",
      "merge b into a from b",
      "merge a into b from a",
      "export a",
      "export c",
      "merge c into a from c",
      "merge a into c from a",
      "export b",
      "export c",
      "merge c into b from c",
      "merge b into c from b",
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
    expect(calls.filter((call) => call.startsWith("merge"))).toHaveLength(2);
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
    expect(calls).toEqual([
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
    expect(calls).toEqual([
      "export a",
      "export b",
      "merge b into a from b",
      "merge a into b from a",
    ]);
  });

  it("never pairs two copies on the same machine", async () => {
    const { calls, driver } = recorder({ a: memory("a", { "MEMORY.md": "1" }) });
    await syncLinkedMemory([[member("a", "one"), member("a", "two")]], driver);
    expect(calls).toEqual([]);
  });
});
