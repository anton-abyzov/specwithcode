import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  EnvironmentId,
  MACHINE_HANDOFF_BUNDLE_MAX_BYTES,
  MACHINE_HANDOFF_MAX_BYTES,
  type MachineHandoffBundle,
  ProjectId,
  ProjectWorkspaceError,
  ThreadId,
} from "@specweave-studio/contracts";
import { stringifyJson } from "../json.ts";
import type * as ProjectWorkspaceService from "../project/ProjectWorkspaceService.ts";
import {
  checkBundle,
  comparableContext,
  contextWithinLimits,
  importDestinationNotes,
  machineHandoffDigest,
  planDestinationNotes,
  planNoteImport,
} from "./handoffBundle.ts";

const projectId = ProjectId.make("destination");
const operationId = "11111111-1111-4111-8111-111111111111";
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected a failure");
    }),
  );
const bundleWith = (notes: ReadonlyArray<{ name: string; content: string }>) => {
  const value: Omit<MachineHandoffBundle, "digest"> = {
    manifest: {
      version: 1,
      operationId,
      repositories: [
        {
          relativePath: ".",
          identity: "github.com/owner/repository",
          head: "a".repeat(40),
          ref: `refs/heads/codex/handoff/${operationId}/${"a".repeat(40)}`,
        },
      ],
    },
    sourceEnvironmentId: EnvironmentId.make("source-env"),
    sourceProjectId: ProjectId.make("source"),
    sourceThreadId: ThreadId.make("source-thread"),
    createdAt: "2026-10-28T00:00:00Z",
    context: { goal: "", instructions: "", notes, threads: [] },
  };
  return { ...value, digest: machineHandoffDigest(value) };
};
/** One project's memory as the workspace service reads and writes it. */
const workspaceOver = (
  files: Map<string, string>,
  options: { readFailure?: string; corrupt?: boolean } = {},
) =>
  ({
    readWorkspace: () =>
      Effect.succeed({
        settings: {},
        memory: {
          files: [...files].map(([name, content]) => ({
            name,
            revision: 1,
            updatedAt: "2026-10-28T00:00:00Z",
            byteLength: Buffer.byteLength(content),
          })),
          totalBytes: [...files.values()].reduce((sum, c) => sum + Buffer.byteLength(c), 0),
        },
      }),
    readMemory: (input: { name: string }) =>
      input.name === options.readFailure
        ? Effect.fail(new ProjectWorkspaceError({ projectId, code: "operation_failed" }))
        : files.has(input.name)
          ? Effect.succeed({ name: input.name, content: files.get(input.name)! })
          : Effect.fail(new ProjectWorkspaceError({ projectId, code: "not_found" })),
    writeMemory: (input: { name: string; content: string }) =>
      Effect.sync(() => {
        files.set(input.name, options.corrupt ? `${input.content}!` : input.content);
        return input;
      }),
    deleteMemory: (input: { name: string }) => Effect.sync(() => void files.delete(input.name)),
  }) as unknown as ProjectWorkspaceService.ProjectWorkspaceService["Service"];
const plan = (
  workspace: ProjectWorkspaceService.ProjectWorkspaceService["Service"],
  notes: ReadonlyArray<{ name: string; content: string }>,
) =>
  planDestinationNotes(workspace, {
    projectId,
    notes,
    sourceEnvironmentId: "source-env",
    nicknames: { "source-env": { name: "M4" } } as never,
  });

describe("handoff bundle memory", () => {
  it("moves a project holding its full 16 MiB of memory, and refuses more", () => {
    const full = Array.from({ length: 64 }, (_, i) => ({
      name: `topic_${i}.md`,
      content: "x".repeat(262_144),
    }));
    const bundle = bundleWith(full);
    expect(() => checkBundle(bundle)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThan(
      MACHINE_HANDOFF_BUNDLE_MAX_BYTES,
    );
    const over = bundleWith([...full, { name: "one_more.md", content: "x" }]);
    expect(() => checkBundle(over)).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("keeps the destination file and writes a changed note as a conflict copy", () => {
    const existing = new Map<string, string | null>([
      ["MEMORY.md", "Destination index"],
      ["same.md", "Same everywhere"],
      ["other.md", null],
    ]);
    const result = planNoteImport(
      [
        { name: "MEMORY.md", content: "Source index" },
        { name: "same.md", content: "Same everywhere" },
        { name: "new.md", content: "Only on the source" },
      ],
      existing,
      "m4",
    );
    expect(result.steps.map((step) => [step.target, step.write])).toEqual([
      ["MEMORY.conflict-m4.md", true],
      ["same.md", false],
      ["new.md", true],
    ]);
    expect(result).toMatchObject({ files: 2, bytes: "Source index".length + 18 });
    // A retry finds the copy already holding the note and writes nothing.
    const retried = planNoteImport(
      [{ name: "MEMORY.md", content: "Source index" }],
      new Map([...existing, ["MEMORY.conflict-m4.md", "Source index"]]),
      "m4",
    );
    expect(retried.steps).toEqual([
      expect.objectContaining({ target: "MEMORY.conflict-m4.md", write: false }),
    ]);
    // A copy name holding something else moves on to the next free one.
    const taken = planNoteImport(
      [{ name: "MEMORY.md", content: "Source index" }],
      new Map([...existing, ["MEMORY.conflict-m4.md", "Older copy"]]),
      "m4",
    );
    expect(taken.steps[0]?.target).toBe("MEMORY.conflict-m4-2.md");
  });

  it.effect("names copies for the source machine and verifies every note after import", () =>
    Effect.gen(function* () {
      const files = new Map([["MEMORY.md", "Destination index"]]);
      const workspace = workspaceOver(files);
      const notes = [
        { name: "MEMORY.md", content: "Source index" },
        { name: "decision.md", content: "Ship on Fridays" },
      ];
      const steps = yield* plan(workspace, notes);
      expect(yield* importDestinationNotes(workspace, projectId, steps)).toBe(2);
      expect(Object.fromEntries(files)).toEqual({
        "MEMORY.md": "Destination index",
        "MEMORY.conflict-m4.md": "Source index",
        "decision.md": "Ship on Fridays",
      });
    }),
  );

  it.effect("fails the import when a note does not read back intact", () =>
    Effect.gen(function* () {
      const files = new Map([["kept.md", "Destination note"]]);
      const workspace = workspaceOver(files, { corrupt: true });
      const notes = [{ name: "decision.md", content: "Ship on Fridays" }];
      const steps = yield* plan(workspace, notes);
      expect((yield* failure(importDestinationNotes(workspace, projectId, steps))).code).toBe(
        "memory_mismatch",
      );
      // The bad file the import created is removed; the destination's own note stays.
      expect(Object.fromEntries(files)).toEqual({ "kept.md": "Destination note" });
    }),
  );

  it.effect("refuses an import the destination limits cannot hold before writing", () =>
    Effect.gen(function* () {
      const files = new Map(
        Array.from({ length: 4_095 }, (_, i) => [`kept_${i}.md`, "x"] as [string, string]),
      );
      const workspace = workspaceOver(files);
      const notes = [
        { name: "a.md", content: "a" },
        { name: "b.md", content: "b" },
      ];
      expect((yield* failure(plan(workspace, notes))).code).toBe("destination_memory_full");
      const big = new Map([["big.md", "x".repeat(16_777_000)]]);
      expect(
        (yield* failure(plan(workspaceOver(big), [{ name: "c.md", content: "x".repeat(300) }])))
          .code,
      ).toBe("destination_memory_full");
      expect(files.size).toBe(4_095);
    }),
  );

  it.effect("treats a read error as a failure, never as a missing file to create", () =>
    Effect.gen(function* () {
      const files = new Map([["decision.md", "Destination decision"]]);
      const workspace = workspaceOver(files, { readFailure: "decision.md" });
      const notes = [{ name: "decision.md", content: "Source decision" }];
      expect((yield* failure(plan(workspace, notes))).code).toBe("storage_failed");
      expect(files.get("decision.md")).toBe("Destination decision");
    }),
  );
});
describe("handoff context limit", () => {
  it("counts a worker summary toward the 2 MiB and still leaves notes out", () => {
    const context = {
      goal: "g",
      instructions: "i",
      notes: [{ name: "MEMORY.md", content: "n".repeat(3_000_000) }],
      threads: [],
    };
    const retention = (note: string) => ({
      note,
      coordinatorMessages: 0,
      omittedMessages: 0,
      truncatedMessages: 0,
      totalThreads: 0,
      workers: [],
      omittedThreads: 0,
    });
    expect(contextWithinLimits({ ...context, retention: retention("fits") })).toBe(true);
    const frame = Buffer.byteLength(
      stringifyJson({ ...context, notes: [], retention: retention("") }),
    );
    expect(
      contextWithinLimits({
        ...context,
        retention: retention("x".repeat(MACHINE_HANDOFF_MAX_BYTES - frame + 1)),
      }),
    ).toBe(false);
  });
});
describe("comparing a retained context with its preview", () => {
  const retention = (lastActivityAt: string) => ({
    note: "n",
    coordinatorMessages: 1,
    omittedMessages: 5,
    truncatedMessages: 0,
    totalThreads: 1,
    workers: [
      {
        threadId: ThreadId.make("w"),
        title: "Worker",
        branch: null,
        worktreePath: null,
        status: "completed",
        archived: false,
        lastActivityAt,
      },
    ],
    omittedThreads: 0,
  });
  const context = {
    goal: "g",
    instructions: "i",
    runtimeMode: "full-access" as const,
    notes: [],
    threads: [],
  };
  it("keeps the previewed worker summary but still sees a summary appear or vanish", () => {
    const saved = { ...context, retention: retention("2026-10-30T00:00:00.000Z") };
    const later = { ...context, retention: retention("2026-10-30T00:05:00.000Z") };
    expect(comparableContext(later, saved)).toEqual(saved);
    expect(comparableContext(context, saved)).toEqual(context);
    expect(comparableContext(later, context)).toEqual(later);
  });
});
