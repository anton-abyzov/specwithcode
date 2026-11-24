import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  memoryResolutionsForSeat,
  renamedMemoryName,
  type MemoryClashResolution,
  type MemoryFileClash,
  type MemoryFileClashVariant,
} from "./personalAssistantMigration.ts";

// Mirrors ProjectMemoryName in packages/contracts/src/projectWorkspace.ts.
const MEMORY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/;
const MEMORY_NAME_MAX = 128;

const env = (id: string) => id as EnvironmentId;

const variant = (environmentId: string, updatedAt: string): MemoryFileClashVariant => ({
  environmentId: env(environmentId),
  machineLabel: environmentId.toUpperCase(),
  projectId: `project-${environmentId}` as ProjectId,
  sha256: `sha-${environmentId}`,
  updatedAt,
  byteLength: 10,
});

const clash = (name: string, ...variants: MemoryFileClashVariant[]): MemoryFileClash => ({
  name,
  variants,
});

const expectValidMemoryName = (name: string) => {
  expect(name).toMatch(MEMORY_NAME);
  expect(name.length).toBeLessThanOrEqual(MEMORY_NAME_MAX);
};

describe("memoryResolutionsForSeat", () => {
  const memory = clash(
    "MEMORY.md",
    variant("m1", "2026-11-01T10:00:00.000Z"),
    variant("m4", "2026-11-20T10:00:00.000Z"),
    variant("m5", "2026-11-10T10:00:00.000Z"),
  );

  it("keep-from X: X keeps the name, every other seat renames locally", () => {
    const resolutions: Record<string, MemoryClashResolution> = {
      "MEMORY.md": { strategy: "keep-from", environmentId: env("m1") },
    };
    expect(memoryResolutionsForSeat([memory], resolutions, env("m1"))).toEqual([
      { name: "MEMORY.md", action: "keep" },
    ]);
    expect(memoryResolutionsForSeat([memory], resolutions, env("m4"))).toEqual([
      { name: "MEMORY.md", action: "rename-local" },
    ]);
    expect(memoryResolutionsForSeat([memory], resolutions, env("m5"))).toEqual([
      { name: "MEMORY.md", action: "rename-local" },
    ]);
  });

  it("keep-from X wins even when another seat has the newer copy", () => {
    const resolutions: Record<string, MemoryClashResolution> = {
      "MEMORY.md": { strategy: "keep-from", environmentId: env("m5") },
    };
    expect(memoryResolutionsForSeat([memory], resolutions, env("m4"))).toEqual([
      { name: "MEMORY.md", action: "rename-local" },
    ]);
    expect(memoryResolutionsForSeat([memory], resolutions, env("m5"))).toEqual([
      { name: "MEMORY.md", action: "keep" },
    ]);
  });

  it("keep-both: the newest updatedAt keeps the name, the others rename and share", () => {
    const resolutions: Record<string, MemoryClashResolution> = {
      "MEMORY.md": { strategy: "keep-both" },
    };
    expect(memoryResolutionsForSeat([memory], resolutions, env("m4"))).toEqual([
      { name: "MEMORY.md", action: "keep" },
    ]);
    expect(memoryResolutionsForSeat([memory], resolutions, env("m1"))).toEqual([
      { name: "MEMORY.md", action: "rename-shared" },
    ]);
    expect(memoryResolutionsForSeat([memory], resolutions, env("m5"))).toEqual([
      { name: "MEMORY.md", action: "rename-shared" },
    ]);
  });

  it("keep-both picks the newest regardless of variant order", () => {
    const reordered = clash(
      "MEMORY.md",
      variant("m4", "2026-11-20T10:00:00.000Z"),
      variant("m5", "2026-11-10T10:00:00.000Z"),
      variant("m1", "2026-11-01T10:00:00.000Z"),
    );
    const resolutions: Record<string, MemoryClashResolution> = {
      "MEMORY.md": { strategy: "keep-both" },
    };
    expect(memoryResolutionsForSeat([reordered], resolutions, env("m4"))).toEqual([
      { name: "MEMORY.md", action: "keep" },
    ]);
    expect(memoryResolutionsForSeat([reordered], resolutions, env("m1"))).toEqual([
      { name: "MEMORY.md", action: "rename-shared" },
    ]);
  });

  it("keep-both with equal timestamps: exactly one seat keeps, the same one on every seat", () => {
    const tied = clash(
      "notes.md",
      variant("m5", "2026-11-20T10:00:00.000Z"),
      variant("m1", "2026-11-20T10:00:00.000Z"),
    );
    const resolutions: Record<string, MemoryClashResolution> = {
      "notes.md": { strategy: "keep-both" },
    };
    const actions = ["m1", "m5"].map(
      (id) => memoryResolutionsForSeat([tied], resolutions, env(id))[0]?.action,
    );
    expect(actions.filter((action) => action === "keep")).toHaveLength(1);
    expect(actions.filter((action) => action === "rename-shared")).toHaveLength(1);
  });

  it("gives a seat nothing for a clash it holds no variant of", () => {
    const twoSeat = clash(
      "notes.md",
      variant("m1", "2026-11-01T10:00:00.000Z"),
      variant("m4", "2026-11-02T10:00:00.000Z"),
    );
    expect(
      memoryResolutionsForSeat([twoSeat], { "notes.md": { strategy: "keep-both" } }, env("m5")),
    ).toEqual([]);
    expect(
      memoryResolutionsForSeat(
        [twoSeat],
        { "notes.md": { strategy: "keep-from", environmentId: env("m1") } },
        env("m5"),
      ),
    ).toEqual([]);
  });

  it("gives nothing for a clash the owner has not resolved", () => {
    const notes = clash(
      "notes.md",
      variant("m1", "2026-11-01T10:00:00.000Z"),
      variant("m4", "2026-11-02T10:00:00.000Z"),
    );
    expect(memoryResolutionsForSeat([memory, notes], {}, env("m1"))).toEqual([]);
    expect(
      memoryResolutionsForSeat(
        [memory, notes],
        { "MEMORY.md": { strategy: "keep-from", environmentId: env("m1") } },
        env("m4"),
      ),
    ).toEqual([{ name: "MEMORY.md", action: "rename-local" }]);
  });

  it("never returns a delete action, only keep or a rename", () => {
    const notes = clash(
      "notes.md",
      variant("m1", "2026-11-03T10:00:00.000Z"),
      variant("m4", "2026-11-02T10:00:00.000Z"),
    );
    const resolutions: Record<string, MemoryClashResolution> = {
      "MEMORY.md": { strategy: "keep-from", environmentId: env("m5") },
      "notes.md": { strategy: "keep-both" },
    };
    for (const id of ["m1", "m4", "m5"]) {
      for (const resolution of memoryResolutionsForSeat([memory, notes], resolutions, env(id))) {
        expect(["keep", "rename-shared", "rename-local"]).toContain(resolution.action);
      }
    }
  });
});

describe("renamedMemoryName", () => {
  it("inserts the machine before .md", () => {
    expect(renamedMemoryName("notes.md", "m4")).toBe("notes.from-m4.md");
    expect(renamedMemoryName("MEMORY.md", "M5")).toBe("MEMORY.from-m5.md");
  });

  it.each([
    ["spaces", "Anton's MacBook Pro"],
    ["unicode", "Антон Мак 💻"],
    ["only unicode", "Ноутбук"],
    ["empty", ""],
    ["only punctuation", " ... !!! "],
    ["dots", "mac.local"],
    ["leading and trailing dashes", "--m4--"],
    ["very long", "a really long machine label ".repeat(10)],
  ])("stays a valid memory name for a machine label with %s", (_case, label) => {
    expectValidMemoryName(renamedMemoryName("notes.md", label));
    expectValidMemoryName(renamedMemoryName("MEMORY.md", label));
  });

  it("falls back to a placeholder when the label has nothing usable", () => {
    expect(renamedMemoryName("notes.md", "")).toBe("notes.from-machine.md");
    expect(renamedMemoryName("notes.md", "Ноутбук")).toBe("notes.from-machine.md");
  });

  it("caps the result at 128 characters for a maximum-length name and a long label", () => {
    const longName = `${"n".repeat(MEMORY_NAME_MAX - 3)}.md`;
    expectValidMemoryName(longName);
    const renamed = renamedMemoryName(longName, "an extremely long machine label ".repeat(4));
    expectValidMemoryName(renamed);
    expect(renamed.length).toBe(MEMORY_NAME_MAX);
    expect(renamed.endsWith(".md")).toBe(true);
  });

  it("keeps dotted names valid", () => {
    expectValidMemoryName(renamedMemoryName("project.notes.v2.md", "m4"));
    expect(renamedMemoryName("project.notes.v2.md", "m4")).toBe("project.notes.v2.from-m4.md");
  });

  it("differs per machine, so two renamed copies do not collide", () => {
    expect(renamedMemoryName("notes.md", "m1")).not.toBe(renamedMemoryName("notes.md", "m4"));
  });

  // Truncating the stem can cut right after a dot; the trailing dot is trimmed
  // so no "..from-" reaches ProjectMemoryName.
  it("stays valid when truncation lands right after a dot in a long dotted name", () => {
    const label = "m4";
    const suffixLength = `.from-${label}.md`.length; // 11
    const keep = MEMORY_NAME_MAX - suffixLength; // 117 stem characters survive
    const name = `${"a".repeat(keep - 1)}.${"b".repeat(MEMORY_NAME_MAX - 3 - keep)}.md`;
    expectValidMemoryName(name);
    expectValidMemoryName(renamedMemoryName(name, label));
  });

  it("stays valid for a long dotted name and a 32-character label", () => {
    const label = "x".repeat(40);
    const suffixLength = `.from-${"x".repeat(32)}.md`.length; // 41
    const keep = MEMORY_NAME_MAX - suffixLength; // 87
    const name = `${"a".repeat(keep - 1)}.${"b".repeat(30)}.md`;
    expectValidMemoryName(name);
    expectValidMemoryName(renamedMemoryName(name, label));
  });

  it("adds an environment id fragment so machines with the same label do not collide", () => {
    const a = renamedMemoryName("notes.md", "MacBook Pro", "env-AAAA1111-xyz");
    const b = renamedMemoryName("notes.md", "MacBook Pro", "env-BBBB2222-xyz");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^notes\.from-macbook-pro-[0-9a-f]{8}\.md$/);
    // Ids that share a long prefix still get different fragments.
    expect(renamedMemoryName("notes.md", "Mac", "environment-0001")).not.toBe(
      renamedMemoryName("notes.md", "Mac", "environment-0002"),
    );
    expectValidMemoryName(a);
    expectValidMemoryName(b);
    expect(renamedMemoryName("notes.md", "Ноутбук", "env-1")).toMatch(
      /^notes\.from-machine-[0-9a-f]{8}\.md$/,
    );
  });

  it("stays valid at the length cap with an environment id fragment", () => {
    const name = `${"a".repeat(80)}.${"b".repeat(44)}.md`;
    expectValidMemoryName(name);
    const renamed = renamedMemoryName(name, "x".repeat(40), "environment-0123456789");
    expectValidMemoryName(renamed);
    expect(renamed.length).toBeLessThanOrEqual(MEMORY_NAME_MAX);
  });
});
