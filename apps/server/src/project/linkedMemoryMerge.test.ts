import type { LinkedMemoryExport } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import {
  applyMergeStepToHistory,
  conflictCopyName,
  emptyMemoryHistory,
  type LocalMemoryFile,
  localFileView,
  machineSlug,
  type MemoryHistoryState,
  type MemoryMergeStep,
  planMemoryMerge,
  recordMemoryDelete,
  recordMemoryWrite,
  unionHistory,
} from "./linkedMemoryMerge.ts";

/** One machine's memory store and version history, driven like the server drives them. */
interface Machine {
  readonly environmentId: string;
  readonly label: string;
  files: Map<string, { content: string; revision: number; updatedAt: string }>;
  state: MemoryHistoryState;
  clock: number;
  /** Names whose writes the store refuses, like a full memory. */
  refuse: Set<string>;
}

const machine = (environmentId: string, label: string): Machine => ({
  environmentId,
  label,
  files: new Map(),
  state: emptyMemoryHistory,
  clock: 0,
  refuse: new Set(),
});
const at = (minute: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, minute)));

/** An ordinary write from a tool or the UI, at `minute`. */
const write = (target: Machine, name: string, content: string, minute: number) => {
  if (target.refuse.has(name)) return false;
  const previous = target.files.get(name);
  const updatedAt = at(minute);
  target.files.set(name, { content, revision: (previous?.revision ?? 0) + 1, updatedAt });
  target.state = recordMemoryWrite(target.state, {
    name,
    previous: previous === undefined ? undefined : memoryContentHash(previous.content),
    hash: memoryContentHash(content),
    authoredAt: updatedAt,
  });
  return true;
};
const remove = (target: Machine, name: string, minute: number) => {
  const previous = target.files.get(name);
  target.files.delete(name);
  target.state = recordMemoryDelete(target.state, {
    name,
    hash: previous === undefined ? undefined : memoryContentHash(previous.content),
    deletedAt: at(minute),
  });
};

const files = (source: Machine) =>
  new Map<string, LocalMemoryFile>(
    [...source.files].map(([name, file]) => {
      const sha = memoryContentHash(file.content);
      const view = localFileView(source.state.files[name], { sha, updatedAt: file.updatedAt });
      return [name, { ...file, sha, ...view }];
    }),
  );
const exportOf = (source: Machine): LinkedMemoryExport => ({
  logicalProjectId: "logical:1",
  environmentId: source.environmentId as LinkedMemoryExport["environmentId"],
  machineLabel: source.label,
  files: [...files(source)].map(([name, file]) => ({
    name,
    content: file.content,
    contentSha256: file.sha,
    updatedAt: file.updatedAt,
    history: [...file.history],
  })),
  tombstones: Object.entries(source.state.tombstones)
    .filter(([name]) => name !== "MEMORY.md" && !source.files.has(name))
    .map(([name, tombstone]) => ({ name, ...tombstone, history: [...tombstone.history] })),
  truncated: false,
});

/** Applies a peer's export the way `LinkedMemorySync.memoryMerge` does. */
const merge = (target: Machine, remote: LinkedMemoryExport, minute: number) => {
  const plan = planMemoryMerge(
    {
      environmentId: target.environmentId,
      machineSlug: machineSlug(target.label, target.environmentId),
      files: files(target),
      tombstones: target.state.tombstones,
    },
    remote,
  );
  const done: MemoryMergeStep[] = [];
  for (const step of plan.steps) {
    if (step.kind === "write") {
      if (
        step.conflictCopy?.write &&
        !write(target, step.conflictCopy.name, step.conflictCopy.content, minute)
      )
        continue;
      if (!write(target, step.name, step.content, minute)) continue;
    }
    if (step.kind === "delete") remove(target, step.name, minute);
    done.push(step);
  }
  target.state = done.reduce(applyMergeStepToHistory, target.state);
  return plan;
};

/** One sync pass: both exports first, then each side merges the other's. */
const pass = (left: Machine, right: Machine, minute: number, skip?: "left" | "right") => {
  const fromLeft = exportOf(left);
  const fromRight = exportOf(right);
  if (skip !== "left") merge(left, fromRight, minute);
  if (skip !== "right") merge(right, fromLeft, minute);
};
const contents = (source: Machine) =>
  Object.fromEntries([...source.files].map(([name, file]) => [name, file.content]).toSorted());

describe("linked memory merge", () => {
  it("adopts files only one side has, both ways", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "MEMORY.md", "# A index", 1);
    write(b, "notes.md", "from b", 2);
    pass(a, b, 3);
    expect(contents(a)).toEqual({ "MEMORY.md": "# A index", "notes.md": "from b" });
    expect(contents(b)).toEqual(contents(a));
  });

  it("does nothing when both sides hold the same content", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "same", 1);
    pass(a, b, 2);
    const plan = merge(a, exportOf(b), 3);
    expect(plan.steps).toEqual([]);
    expect(plan.kept).toEqual([]);
    expect(merge(b, exportOf(a), 3).steps).toEqual([]);
  });

  it("only remembers the union of versions when contents match", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "one", 1);
    write(a, "notes.md", "two", 2);
    write(b, "notes.md", "two", 3);
    const plan = merge(b, exportOf(a), 4);
    expect(plan.steps.map((step) => step.kind)).toEqual(["history"]);
    expect(b.state.files["notes.md"]?.history).toEqual([
      memoryContentHash("one"),
      memoryContentHash("two"),
    ]);
    expect(b.files.get("notes.md")?.revision).toBe(1);
  });

  it.each([
    ["a newer edit on the left", "left"],
    ["a newer edit on the right", "right"],
  ] as const)("takes %s over the version it replaced, with no copy", (_label, editor) => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "v1", 1);
    pass(a, b, 2);
    write(editor === "left" ? a : b, "notes.md", "v2", 3);
    pass(a, b, 4);
    expect(contents(a)).toEqual({ "notes.md": "v2" });
    expect(contents(b)).toEqual({ "notes.md": "v2" });
  });

  it("keeps the local version when the peer still holds one it replaced", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "v1", 1);
    pass(a, b, 2);
    // Much later on the clock, but already seen and replaced here.
    b.files.set("notes.md", { ...b.files.get("notes.md")!, updatedAt: at(50) });
    write(a, "notes.md", "v2", 10);
    const plan = merge(a, exportOf(b), 11);
    expect(plan.kept).toEqual(["notes.md"]);
    expect(plan.steps).toEqual([]);
    expect(contents(a)).toEqual({ "notes.md": "v2" });
  });

  it.each([
    ["the left writes last", "left", "right"],
    ["the right writes last", "right", "left"],
  ] as const)("resolves concurrent edits to the last writer when %s", (_label, winner, loser) => {
    const machines = { left: machine("env-a", "Alpha"), right: machine("env-b", "Beta") };
    write(machines.left, "notes.md", "base", 1);
    pass(machines.left, machines.right, 2);
    write(machines[loser], "notes.md", `${loser} edit`, 3);
    write(machines[winner], "notes.md", `${winner} edit`, 4);
    pass(machines.left, machines.right, 5);
    pass(machines.left, machines.right, 6);
    const loserSlug = machines[loser].label.toLowerCase();
    const expected = {
      "notes.md": `${winner} edit`,
      [`notes.conflict-${loserSlug}.md`]: `${loser} edit`,
    };
    expect(contents(machines.left)).toEqual(expected);
    expect(contents(machines.right)).toEqual(expected);
    // A further pass changes nothing.
    expect(merge(machines.left, exportOf(machines.right), 7).steps).toEqual([]);
    expect(merge(machines.right, exportOf(machines.left), 7).steps).toEqual([]);
  });

  it("picks the same winner on both sides from the same two exports", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "a edit", 5);
    write(b, "notes.md", "b edit", 5);
    const fromA = exportOf(a);
    const fromB = exportOf(b);
    const onA = merge(a, fromB, 6);
    const onB = merge(b, fromA, 6);
    // Same time: the larger environment id wins on both sides.
    expect(onA.steps).toMatchObject([
      {
        kind: "write",
        name: "notes.md",
        content: "b edit",
        conflictCopy: { name: "notes.conflict-alpha.md" },
      },
    ]);
    expect(onB.kept).toEqual(["notes.md"]);
    expect(onB.steps).toEqual([]);
  });

  it("converges with no regression when one side's merge failed", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "base", 1);
    write(a, "MEMORY.md", "# index", 1);
    pass(a, b, 2);
    write(a, "notes.md", "a edit", 3);
    write(b, "notes.md", "b edit", 4);
    write(b, "plan.md", "b plan", 4);
    // A applied B's export; B's merge of A's export failed.
    pass(a, b, 5, "right");
    expect(contents(a)).toEqual({
      "MEMORY.md": "# index",
      "notes.md": "b edit",
      "notes.conflict-alpha.md": "a edit",
      "plan.md": "b plan",
    });
    expect(contents(b)).toEqual({
      "MEMORY.md": "# index",
      "notes.md": "b edit",
      "plan.md": "b plan",
    });
    pass(a, b, 6);
    expect(contents(b)).toEqual(contents(a));
    expect(contents(a)["notes.md"]).toBe("b edit");
    expect(Object.keys(contents(a)).filter((name) => name.includes(".conflict-"))).toEqual([
      "notes.conflict-alpha.md",
    ]);
  });

  it("converges when the other side failed first", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "base", 1);
    pass(a, b, 2);
    write(a, "notes.md", "a edit", 3);
    write(b, "notes.md", "b edit", 4);
    pass(a, b, 5, "left");
    expect(contents(a)).toEqual({ "notes.md": "a edit" });
    expect(contents(b)).toEqual({ "notes.md": "b edit" });
    pass(a, b, 6);
    pass(a, b, 7);
    expect(contents(a)).toEqual({
      "notes.md": "b edit",
      "notes.conflict-alpha.md": "a edit",
    });
    expect(contents(b)).toEqual(contents(a));
  });

  it("does not replace a version whose conflict copy could not be saved", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "a edit", 1);
    write(b, "notes.md", "b edit", 2);
    a.refuse.add("notes.conflict-alpha.md");
    merge(a, exportOf(b), 3);
    expect(contents(a)).toEqual({ "notes.md": "a edit" });
    a.refuse.clear();
    merge(a, exportOf(b), 4);
    expect(contents(a)).toEqual({ "notes.md": "b edit", "notes.conflict-alpha.md": "a edit" });
  });

  it("never loses MEMORY.md in a concurrent edit", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "MEMORY.md", "# base", 1);
    pass(a, b, 2);
    write(a, "MEMORY.md", "# a", 3);
    write(b, "MEMORY.md", "# b", 4);
    pass(a, b, 5);
    pass(a, b, 6);
    expect(contents(a)).toEqual({ "MEMORY.md": "# b", "MEMORY.conflict-alpha.md": "# a" });
    expect(contents(b)).toEqual(contents(a));
  });

  it("ignores a peer's tombstone for MEMORY.md", () => {
    const a = machine("env-a", "Alpha");
    write(a, "MEMORY.md", "# index", 1);
    const tombstone = {
      name: "MEMORY.md",
      deletedAt: at(9),
      history: [memoryContentHash("# index")],
    };
    const plan = merge(a, { ...exportOf(machine("env-b", "Beta")), tombstones: [tombstone] }, 10);
    expect(plan.steps).toEqual([]);
    expect(contents(a)).toEqual({ "MEMORY.md": "# index" });
  });

  it("restores MEMORY.md deleted here when a peer still has it", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "MEMORY.md", "# index", 1);
    pass(a, b, 2);
    remove(b, "MEMORY.md", 3);
    pass(a, b, 4);
    expect(contents(a)).toEqual({ "MEMORY.md": "# index" });
    expect(contents(b)).toEqual({ "MEMORY.md": "# index" });
  });

  it.each([
    ["the left deletes", "left", "right"],
    ["the right deletes", "right", "left"],
  ] as const)(
    "replicates a deletion of a version the peer has seen when %s",
    (_label, deleter, other) => {
      const machines = { left: machine("env-a", "Alpha"), right: machine("env-b", "Beta") };
      write(machines[other], "notes.md", "v1", 1);
      write(machines[other], "keep.md", "kept", 1);
      pass(machines.left, machines.right, 2);
      remove(machines[deleter], "notes.md", 3);
      pass(machines.left, machines.right, 4);
      expect(contents(machines.left)).toEqual({ "keep.md": "kept" });
      expect(contents(machines.right)).toEqual({ "keep.md": "kept" });
      expect(machines[other].state.tombstones["notes.md"]).toBeDefined();
      pass(machines.left, machines.right, 5);
      expect(contents(machines.left)).toEqual({ "keep.md": "kept" });
    },
  );

  it.each([
    ["the left deletes", "left", "right"],
    ["the right deletes", "right", "left"],
  ] as const)("keeps an edit made after the version %s", (_label, deleter, editor) => {
    const machines = { left: machine("env-a", "Alpha"), right: machine("env-b", "Beta") };
    write(machines.left, "notes.md", "v1", 1);
    pass(machines.left, machines.right, 2);
    remove(machines[deleter], "notes.md", 5);
    // An edit to a version the deleter never saw outlives the deletion, even an older one.
    write(machines[editor], "notes.md", "v2", 3);
    pass(machines.left, machines.right, 6);
    expect(contents(machines.left)).toEqual({ "notes.md": "v2" });
    expect(contents(machines.right)).toEqual({ "notes.md": "v2" });
    pass(machines.left, machines.right, 7);
    expect(contents(machines.left)).toEqual({ "notes.md": "v2" });
  });

  it("does not resurrect a deleted file from a peer's older copy", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "v1", 1);
    pass(a, b, 2);
    remove(a, "notes.md", 3);
    const plan = merge(a, exportOf(b), 4);
    expect(plan.kept).toEqual(["notes.md"]);
    expect(plan.steps).toEqual([]);
    expect(contents(a)).toEqual({});
  });

  it("records a peer's deletion of a file it never had", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    const c = machine("env-c", "Gamma");
    write(b, "notes.md", "v1", 1);
    pass(b, c, 2);
    remove(b, "notes.md", 3);
    pass(a, b, 4);
    expect(a.state.tombstones["notes.md"]?.history).toEqual([memoryContentHash("v1")]);
    // C's stale copy does not come back through A.
    pass(a, c, 5);
    expect(contents(a)).toEqual({});
    expect(contents(c)).toEqual({});
  });

  it("follows a revert to an earlier version by its last writer", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "x", 1);
    pass(a, b, 2);
    write(b, "notes.md", "y", 3);
    pass(a, b, 4);
    write(a, "notes.md", "x", 5);
    pass(a, b, 6);
    expect(contents(a)).toEqual({ "notes.md": "x" });
    expect(contents(b)).toEqual({ "notes.md": "x" });
  });

  it("never writes a conflict copy for identical content", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.md", "same", 1);
    write(b, "notes.md", "same", 2);
    pass(a, b, 3);
    expect(contents(a)).toEqual({ "notes.md": "same" });
    expect(contents(b)).toEqual({ "notes.md": "same" });
  });

  it("never deletes for a file missing from a truncated export", () => {
    const a = machine("env-a", "Alpha");
    write(a, "notes.md", "v1", 1);
    const plan = merge(a, { ...exportOf(machine("env-b", "Beta")), truncated: true }, 2);
    expect(plan.steps).toEqual([]);
    expect(contents(a)).toEqual({ "notes.md": "v1" });
  });

  it("numbers a conflict copy whose name holds other content", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.conflict-alpha.md", "older loser", 1);
    write(a, "notes.md", "a edit", 2);
    write(b, "notes.md", "b edit", 3);
    const plan = merge(a, exportOf(b), 4);
    expect(plan.steps).toMatchObject([
      {
        kind: "write",
        name: "notes.md",
        conflictCopy: { name: "notes.conflict-alpha-2.md", write: true },
      },
    ]);
    expect(contents(a)).toEqual({
      "notes.conflict-alpha.md": "older loser",
      "notes.conflict-alpha-2.md": "a edit",
      "notes.md": "b edit",
    });
  });

  it("reuses a conflict copy that already holds the losing version", () => {
    const a = machine("env-a", "Alpha");
    const b = machine("env-b", "Beta");
    write(a, "notes.conflict-alpha.md", "a edit", 1);
    write(a, "notes.md", "a edit", 2);
    write(b, "notes.md", "b edit", 3);
    const plan = merge(a, exportOf(b), 4);
    expect(plan.steps).toMatchObject([
      { kind: "write", conflictCopy: { name: "notes.conflict-alpha.md", write: false } },
    ]);
    expect(a.files.get("notes.conflict-alpha.md")?.revision).toBe(1);
  });

  it("names conflict copies within the memory name rules", () => {
    const free = () => "free" as const;
    expect(conflictCopyName("MEMORY.md", "macbook-pro", free)).toEqual({
      name: "MEMORY.conflict-macbook-pro.md",
      exists: false,
    });
    const taken = new Set(["a.b.conflict-m.md", "a.b.conflict-m-2.md"]);
    expect(
      conflictCopyName("a.b.md", "m", (name) => (taken.has(name) ? "taken" : "free")).name,
    ).toBe("a.b.conflict-m-3.md");
    const long = `${"x".repeat(100)}.${"y".repeat(23)}.md`;
    const copy = conflictCopyName(long, "a".repeat(32), free).name;
    expect(copy.length).toBeLessThanOrEqual(128);
    expect(copy).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/);
  });

  it("slugs machine names, falling back to the environment id", () => {
    expect(machineSlug("Anton's MacBook Pro", "env-1")).toBe("anton-s-macbook-pro");
    expect(machineSlug("Café", "env-1")).toBe("cafe");
    expect(machineSlug("---", "4F3A9C21-AAAA")).toBe("4f3a9c21");
    expect(machineSlug(undefined, "")).toBe("machine");
    expect(machineSlug("x".repeat(80), "env")).toHaveLength(32);
  });

  it("keeps the newest fifty versions, the current one last", () => {
    const hashes = Array.from({ length: 60 }, (_, index) => memoryContentHash(String(index)));
    let state = emptyMemoryHistory;
    hashes.forEach((hash, index) => {
      state = recordMemoryWrite(state, {
        name: "notes.md",
        previous: index === 0 ? undefined : hashes[index - 1],
        hash,
        authoredAt: at(index),
      });
    });
    expect(state.files["notes.md"]?.history).toEqual(hashes.slice(-50));
    expect(unionHistory(["b", "c"], ["a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("heals a history that missed a write made around the hook", () => {
    const stored = { history: ["old"], authoredAt: at(1) };
    expect(localFileView(stored, { sha: "new", updatedAt: at(2) })).toEqual({
      history: ["old", "new"],
      updatedAt: at(2),
    });
    expect(
      localFileView(
        { history: ["old", "new"], authoredAt: at(1) },
        { sha: "new", updatedAt: at(3) },
      ),
    ).toEqual({
      history: ["old", "new"],
      updatedAt: at(1),
    });
  });
});
