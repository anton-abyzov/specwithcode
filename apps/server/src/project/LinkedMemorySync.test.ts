import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PROJECT_LINK_MAX_BYTES,
  PROJECT_MEMORY_FILE_BYTES,
  ProjectId,
  type ProjectLinkError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { alpha, beta, LOGICAL_ID, machine, members, pass } from "./LinkedMemorySync.testkit.ts";

const refusal = (exit: Exit.Exit<unknown, ProjectLinkError>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?.code : "succeeded";

it.effect("records every memory write and delete as a version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      yield* a.write("notes.md", "one");
      yield* a.write("notes.md", "two");
      const written = yield* a.history;
      assert.deepStrictEqual(written.files["notes.md"]?.history, [
        LinkedMemoryHistory.memoryContentHash("one"),
        LinkedMemoryHistory.memoryContentHash("two"),
      ]);
      yield* a.remove("notes.md");
      const deleted = yield* a.history;
      assert.isUndefined(deleted.files["notes.md"]);
      assert.deepStrictEqual(deleted.tombstones["notes.md"]?.history, [
        LinkedMemoryHistory.memoryContentHash("one"),
        LinkedMemoryHistory.memoryContentHash("two"),
      ]);
    }),
  ),
);

it.effect("exports MEMORY.md first with hashes, versions and tombstones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      yield* a.write("zeta.md", "z");
      yield* a.write("MEMORY.md", "# index");
      yield* a.write("gone.md", "bye");
      yield* a.remove("gone.md");
      const memory = yield* a.exported;
      assert.strictEqual(memory.logicalProjectId, LOGICAL_ID);
      assert.strictEqual(memory.environmentId, alpha.environmentId);
      assert.strictEqual(memory.machineLabel, "Alpha");
      assert.strictEqual(memory.truncated, false);
      assert.deepStrictEqual(
        memory.files.map((file) => file.name),
        ["MEMORY.md", "zeta.md"],
      );
      const index = memory.files[0]!;
      assert.strictEqual(index.contentSha256, LinkedMemoryHistory.memoryContentHash("# index"));
      assert.deepStrictEqual(index.history, [index.contentSha256]);
      assert.deepStrictEqual(
        memory.tombstones.map((tombstone) => tombstone.name),
        ["gone.md"],
      );
    }),
  ),
);

// Live: the memory store stamps writes with the wall clock.
it.live("pages memory beyond one message so the whole store reaches the peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("gone.md", "bye");
      yield* a.remove("gone.md");
      const names = Array.from({ length: 9 }, (_, index) => `big-${index}.md`);
      for (const [index, name] of names.entries())
        yield* a.write(name, String(index).repeat(PROJECT_MEMORY_FILE_BYTES));
      yield* a.write("MEMORY.md", "# index");

      const first = yield* a.exported;
      assert.strictEqual(first.files[0]?.name, "MEMORY.md");
      assert.isTrue(first.truncated);
      assert.isString(first.nextCursor);
      assert.deepStrictEqual(
        first.tombstones.map((tombstone) => tombstone.name),
        ["gone.md"],
      );
      let bytes = 0;
      for (const file of first.files) bytes += file.content.length;
      assert.isAtMost(bytes, PROJECT_LINK_MAX_BYTES);

      const pages = [first];
      while (pages.at(-1)!.nextCursor)
        pages.push(yield* a.exportPage({ cursor: pages.at(-1)!.nextCursor! }));
      assert.isAbove(pages.length, 1);
      const last = pages.at(-1)!;
      assert.isFalse(last.truncated);
      assert.deepStrictEqual(last.tombstones, []);
      assert.deepStrictEqual(
        pages.flatMap((page) => page.files.map((file) => file.name)).toSorted(),
        ["MEMORY.md", ...names].toSorted(),
      );
      // Every page and a digest-only export describe the same whole memory.
      const summary = yield* a.exportPage({ digestOnly: true });
      assert.deepStrictEqual(summary.files, []);
      assert.isString(summary.digest);
      for (const page of pages) assert.strictEqual(page.digest, summary.digest);

      for (const page of pages) yield* b.merge(alpha, page);
      const copied = yield* b.contents;
      assert.deepStrictEqual(Object.keys(copied).toSorted(), ["MEMORY.md", ...names].toSorted());
      assert.strictEqual(copied["big-8.md"], "8".repeat(PROJECT_MEMORY_FILE_BYTES));
      // b took a's files and deletion, so both copies now report one digest.
      assert.strictEqual((yield* b.exportPage({ digestOnly: true })).digest, summary.digest);

      assert.strictEqual(
        refusal(yield* Effect.exit(a.exportPage({ cursor: "not a cursor" }))),
        "invalid",
      );
    }),
  ),
);

it.live("replicates memory both ways and merges edits made on each machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("MEMORY.md", "# index");
      yield* a.write("notes.md", "one\ntwo\nthree\n");
      yield* b.write("plan.md", "from beta");
      const first = yield* pass(a, b);
      assert.deepStrictEqual(first.onLeft.applied, ["plan.md"]);
      assert.deepStrictEqual(first.onRight.applied, ["MEMORY.md", "notes.md"]);
      assert.deepStrictEqual(yield* a.contents, yield* b.contents);

      yield* a.write("notes.md", "ONE\ntwo\nthree\n");
      yield* b.write("notes.md", "one\ntwo\nTHREE\n");
      yield* pass(a, b);
      const expected = {
        "MEMORY.md": "# index",
        "notes.md": "ONE\ntwo\nTHREE\n",
        "plan.md": "from beta",
      };
      assert.deepStrictEqual(yield* a.contents, expected);
      assert.deepStrictEqual(yield* b.contents, expected);
      const settled = yield* pass(a, b);
      assert.deepStrictEqual(settled.onLeft, { applied: [], conflicts: [], kept: [], skipped: [] });
      assert.deepStrictEqual(settled.onRight, {
        applied: [],
        conflicts: [],
        kept: [],
        skipped: [],
      });
    }),
  ),
);

it.live("keeps a real clash in the one file on both machines, flagged, with no copy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("notes.md", "base\n");
      yield* pass(a, b);
      yield* a.write("notes.md", "alpha edit\n");
      yield* b.write("notes.md", "beta edit\n");
      yield* pass(a, b);
      const expected = {
        "notes.md": "<<<<<<< alpha\nalpha edit\n=======\nbeta edit\n>>>>>>> beta\n",
      };
      assert.deepStrictEqual(yield* a.contents, expected);
      assert.deepStrictEqual(yield* b.contents, expected);
      const history = yield* a.history;
      assert.strictEqual(history.files["notes.md"]?.clash, true);
      const settled = yield* pass(a, b);
      assert.deepStrictEqual(settled.onLeft.applied, []);
      assert.deepStrictEqual(settled.onRight.applied, []);
      // Tidying it clears the flag and reaches the other machine.
      yield* a.write("notes.md", "tidied\n");
      assert.isUndefined((yield* a.history).files["notes.md"]?.clash);
      yield* pass(a, b);
      assert.deepStrictEqual(yield* b.contents, { "notes.md": "tidied\n" });
    }),
  ),
);

it.live("merges a moved coordinator's notes into this copy, and never revives a deletion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("notes.md", "one\ntwo\n");
      yield* a.write("old.md", "stale\n");
      yield* pass(a, b);
      yield* b.remove("old.md");
      yield* pass(a, b);
      yield* a.write("old.md", "stale\n");
      yield* a.write("notes.md", "ONE\ntwo\n");
      yield* b.write("notes.md", "one\nTWO\n");
      const versions = yield* a.noteVersions;
      const settled = yield* b.mergeMovedNotes({
        notes: [
          { name: "notes.md", content: "ONE\ntwo\n" },
          { name: "old.md", content: "stale\n" },
          { name: "fresh.md", content: "new\n" },
        ],
        versions: {
          ...versions,
          "fresh.md": { history: [], updatedAt: "2026-11-02T00:00:00.000Z" },
        },
        sourceEnvironmentId: alpha.environmentId,
      });
      assert.deepStrictEqual([...settled].toSorted(), ["fresh.md", "notes.md", "old.md"]);
      assert.deepStrictEqual(yield* b.contents, {
        "fresh.md": "new\n",
        "notes.md": "ONE\nTWO\n",
      });
    }),
  ),
);

it.live("settles a moved note whose merge matches this copy, with no conflict copy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("notes.md", "one\ntwo\n");
      yield* pass(a, b);
      yield* a.write("notes.md", "ONE\ntwo\n");
      yield* pass(a, b);
      yield* b.write("notes.md", "ONE\nTWO\n");
      const settled = yield* b.mergeMovedNotes({
        notes: [{ name: "notes.md", content: "ONE\ntwo\n" }],
        versions: yield* a.noteVersions,
        sourceEnvironmentId: alpha.environmentId,
      });
      assert.deepStrictEqual([...settled], ["notes.md"]);
      assert.deepStrictEqual(yield* b.contents, { "notes.md": "ONE\nTWO\n" });
    }),
  ),
);

it.live("merges cleanly in one pass after one machine made many edits apart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("notes.md", "top\nmiddle\nbottom\n");
      yield* pass(a, b);
      for (let edit = 0; edit < 20; edit += 1)
        yield* a.write("notes.md", `top ${edit}\nmiddle\nbottom\n`);
      yield* b.write("notes.md", "top\nmiddle\nbottom from b\n");
      yield* pass(a, b);
      const merged = { "notes.md": "top 19\nmiddle\nbottom from b\n" };
      assert.deepStrictEqual(yield* a.contents, merged);
      assert.deepStrictEqual(yield* b.contents, merged);
    }),
  ),
);

it.effect("replicates a bulk delete larger than one page of tombstones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      const names = Array.from({ length: 300 }, (_, index) => `receipt-${index}.md`);
      for (const name of names) yield* a.write(name, name);
      yield* a.write("MEMORY.md", "# index");
      yield* pass(a, b);
      for (const name of names) yield* a.remove(name);
      assert.strictEqual(Object.keys((yield* a.history).tombstones).length, 300);

      const pages = [yield* a.exported];
      while (pages.at(-1)!.nextCursor)
        pages.push(yield* a.exportPage({ cursor: pages.at(-1)!.nextCursor! }));
      assert.deepStrictEqual(
        pages.map((page) => page.tombstones.length),
        [256, 44],
      );
      for (const page of pages) yield* b.merge(alpha, page);
      // Every deletion reached b, so none can come back on the next pass.
      assert.deepStrictEqual(yield* b.contents, { "MEMORY.md": "# index" });
      yield* pass(a, b);
      assert.deepStrictEqual(yield* a.contents, { "MEMORY.md": "# index" });
    }),
  ),
);

it.effect("replicates deletions but never MEMORY.md", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("MEMORY.md", "# index");
      yield* a.write("notes.md", "v1");
      yield* pass(a, b);
      yield* b.remove("notes.md");
      yield* b.remove("MEMORY.md");
      const result = yield* pass(a, b);
      assert.deepStrictEqual(result.onLeft.applied, ["notes.md"]);
      assert.deepStrictEqual(result.onRight.applied, ["MEMORY.md"]);
      assert.deepStrictEqual(yield* a.contents, { "MEMORY.md": "# index" });
      assert.deepStrictEqual(yield* b.contents, { "MEMORY.md": "# index" });
    }),
  ),
);

it.effect("refuses merges from unlinked projects, unknown members and this machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      const lone = yield* machine(
        { environmentId: EnvironmentId.make("env-lone"), projectId: ProjectId.make("lone") },
        "Lone",
        null,
      );
      yield* b.write("notes.md", "v1");
      const memory = yield* b.exported;
      assert.strictEqual(refusal(yield* Effect.exit(lone.exported)), "not_linked");
      assert.strictEqual(refusal(yield* Effect.exit(lone.merge(beta, memory))), "not_linked");
      assert.strictEqual(
        refusal(
          yield* Effect.exit(a.merge(beta, { ...memory, logicalProjectId: "logical:other" })),
        ),
        "not_linked",
      );
      assert.strictEqual(
        refusal(
          yield* Effect.exit(a.merge(alpha, { ...memory, environmentId: alpha.environmentId })),
        ),
        "same_machine",
      );
      const stranger = {
        environmentId: EnvironmentId.make("env-stranger"),
        projectId: beta.projectId,
      };
      assert.strictEqual(
        refusal(
          yield* Effect.exit(
            a.merge(stranger, { ...memory, environmentId: stranger.environmentId }),
          ),
        ),
        "not_member",
      );
      assert.strictEqual(
        refusal(
          yield* Effect.exit(a.merge({ ...beta, environmentId: stranger.environmentId }, memory)),
        ),
        "invalid",
      );
      assert.deepStrictEqual(yield* a.contents, {});
    }),
  ),
);

it.effect("never exports a personal assistant's memory nor merges another machine's into it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Linked before the rule that keeps a personal assistant on its machine.
      const household = yield* machine(alpha, "Example Household", undefined, "personal");
      const b = yield* machine(beta, "Beta");
      yield* household.write("notes.md", "groceries");
      yield* b.write("notes.md", "from beta");
      assert.strictEqual(refusal(yield* Effect.exit(household.exported)), "not_code_project");
      const memory = yield* b.exported;
      assert.strictEqual(
        refusal(yield* Effect.exit(household.merge(beta, memory))),
        "not_code_project",
      );
      assert.deepStrictEqual(yield* household.contents, { "notes.md": "groceries" });
    }),
  ),
);

it.effect("refuses a peer's memory while this copy moves to another machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const moving = yield* machine(alpha, "Alpha", undefined, "code", {
        epoch: 1,
        state: "transferring",
        operationId: "11111111-1111-4111-8111-111111111111",
      });
      const b = yield* machine(beta, "Beta");
      yield* moving.write("notes.md", "before the move");
      yield* b.write("notes.md", "late from beta");
      assert.strictEqual(
        refusal(yield* Effect.exit(moving.merge(beta, yield* b.exported))),
        "handoff_in_progress",
      );
      assert.deepStrictEqual(yield* moving.contents, { "notes.md": "before the move" });
    }),
  ),
);

it.effect("refuses memory that does not match its hash or is too large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* b.write("notes.md", "v1");
      const memory = yield* b.exported;
      const tampered = {
        ...memory,
        files: memory.files.map((file) => ({ ...file, content: "tampered" })),
      };
      assert.strictEqual(refusal(yield* Effect.exit(a.merge(beta, tampered))), "invalid");
      const big = "x".repeat(PROJECT_MEMORY_FILE_BYTES);
      const oversized = {
        ...memory,
        files: Array.from({ length: 9 }, (_, index) => ({
          ...memory.files[0]!,
          name: `big-${index}.md`,
          content: big,
        })),
      };
      assert.strictEqual(refusal(yield* Effect.exit(a.merge(beta, oversized))), "too_large");
      assert.deepStrictEqual(yield* a.contents, {});
    }),
  ),
);

it.effect("skips a file the store refuses and merges the rest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* b.write("notes.md", "v1");
      const memory = yield* b.exported;
      const huge = "y".repeat(PROJECT_MEMORY_FILE_BYTES + 1);
      const result = yield* a.merge(beta, {
        ...memory,
        files: [
          ...memory.files,
          {
            name: "huge.md",
            content: huge,
            contentSha256: LinkedMemoryHistory.memoryContentHash(huge),
            updatedAt: "2026-10-19T00:00:00.000Z",
            history: [],
          },
        ],
      });
      assert.deepStrictEqual(result.applied, ["notes.md"]);
      assert.deepStrictEqual(result.skipped, ["huge.md"]);
      assert.deepStrictEqual(yield* a.contents, { "notes.md": "v1" });
      assert.isUndefined((yield* a.history).files["huge.md"]);
    }),
  ),
);

it.effect("keeps scopes separate per machine", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const a = yield* machine(alpha, "Alpha").pipe(Scope.provide(scope));
    const b = yield* machine(beta, "Beta").pipe(Scope.provide(scope));
    yield* a.write("notes.md", "only alpha");
    assert.deepStrictEqual(yield* b.contents, {});
    yield* Scope.close(scope, Exit.void);
  }),
);
