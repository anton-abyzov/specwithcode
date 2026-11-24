import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LinkedMemoryExport,
  PROJECT_MEMORY_FILE_BYTES,
  ProjectId,
  ProjectMemoryName,
  ProjectWorkspaceError,
  ThreadId,
} from "@specweave-studio/contracts";
import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { type Machine, machine, pass } from "./LinkedMemorySync.testkit.ts";
import { hasClashMarkers } from "./linkedMemoryThreeWay.ts";
import {
  type AutoMergeInput,
  type AutoMergePlan,
  type AutoMergeSeatFile,
  type AutoMergeServices,
  PersonalAutoMergeError,
  applyAutoMerge,
  autoMergeJoiningSeat,
  planAutoMerge,
} from "./personalAutoMerge.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

const hash = LinkedMemoryHistory.memoryContentHash;
const file = (name: string, content: string): AutoMergeSeatFile => ({
  name,
  content,
  sha256: hash(content),
});
const LABEL = "Laptop";
const ENVIRONMENT = "env-laptop";
const renamed = (name: string) => renamedMemoryName(name, LABEL, ENVIRONMENT);
const isMemoryName = Schema.is(ProjectMemoryName);

/** The joining seat against a link holding `linkFiles`. */
const inputOf = (
  linkFiles: ReadonlyArray<AutoMergeSeatFile>,
  seatFiles: ReadonlyArray<AutoMergeSeatFile>,
  unshared: ReadonlyArray<string> = [],
): AutoMergeInput => ({
  link: {
    files: linkFiles.map(({ name, sha256 }) => ({ name, sha256 })),
    index: linkFiles.find((entry) => entry.name === "MEMORY.md")?.content ?? null,
  },
  seat: {
    files: seatFiles,
    machineLabel: LABEL,
    environmentId: ENVIRONMENT,
    unshared: new Set(unshared),
  },
});

/** The seat's files once `plan` is written, as `applyAutoMerge` writes it. */
const written = (
  files: ReadonlyArray<AutoMergeSeatFile>,
  plan: AutoMergePlan,
  only: "all" | "index" = "all",
): ReadonlyArray<AutoMergeSeatFile> => {
  const next = new Map(files.map((entry) => [entry.name, entry]));
  if (plan.index !== null) next.set("MEMORY.md", file("MEMORY.md", plan.index.content));
  if (only === "all")
    for (const rename of plan.renames) {
      const source = next.get(rename.from);
      if (source === undefined) continue;
      next.delete(rename.from);
      next.set(rename.to, file(rename.to, source.content));
    }
  return [...next.values()];
};

describe("planAutoMerge: MEMORY.md", () => {
  it("keeps the link's lines in order, then this seat's lines the link lacks", () => {
    const link = "# Memory\n\n- [Home](home.md) the house\n- [Travel](travel.md) trips\n";
    const seat =
      "# Memory   \n\n- [Work](work.md) the office\n- [Travel](travel.md) trips\t\n\n- [Garden](garden.md) plants\n";
    const plan = planAutoMerge(inputOf([file("MEMORY.md", link)], [file("MEMORY.md", seat)]));
    assert.deepStrictEqual(plan.renames, []);
    assert.strictEqual(
      plan.index?.content,
      `${link}- [Work](work.md) the office\n- [Garden](garden.md) plants\n`,
    );
    assert.deepStrictEqual(plan.index?.base, { sha256: hash(link), content: link });
  });

  it("ends the link's last line before adding this seat's lines", () => {
    const plan = planAutoMerge(
      inputOf([file("MEMORY.md", "- one\n- two")], [file("MEMORY.md", "- three")]),
    );
    assert.strictEqual(plan.index?.content, "- one\n- two\n- three\n");
  });

  it("keeps this seat's blank lines when the link has none, and its repeated lines", () => {
    const plan = planAutoMerge(
      inputOf([file("MEMORY.md", "- one\n")], [file("MEMORY.md", "- two\n\n- two\n")]),
    );
    assert.strictEqual(plan.index?.content, "- one\n- two\n\n- two\n");
  });

  it("is the link's index byte for byte when this seat adds nothing", () => {
    const link = "- one\n- two";
    const plan = planAutoMerge(
      inputOf([file("MEMORY.md", link)], [file("MEMORY.md", "- two  \n")]),
    );
    assert.strictEqual(plan.index?.content, link);
    assert.isNull(plan.index?.base);
  });

  it("leaves this seat's index as it is when the link has none", () => {
    const seat = "- [Work](work.md)";
    const plan = planAutoMerge(inputOf([file("home.md", "h")], [file("MEMORY.md", seat)]));
    assert.deepStrictEqual(plan, { renames: [], index: { content: seat, base: null } });
  });

  it("plans no index for a seat without one, or with one kept on this machine", () => {
    const link = [file("MEMORY.md", "- one\n")];
    assert.isNull(planAutoMerge(inputOf(link, [file("work.md", "w")])).index);
    assert.deepStrictEqual(
      planAutoMerge(inputOf(link, [file("MEMORY.md", "- mine\n")], ["MEMORY.md"])),
      { renames: [], index: null },
    );
  });

  it("keeps an index too large to union as a renamed file instead of failing", () => {
    const half = `${"x".repeat(PROJECT_MEMORY_FILE_BYTES / 2 + 8)}\n`;
    const seat = [file("MEMORY.md", `${half.replace(/x/g, "y")}`)];
    const plan = planAutoMerge(inputOf([file("MEMORY.md", half)], seat));
    assert.deepStrictEqual(plan, {
      renames: [{ from: "MEMORY.md", to: renamed("MEMORY.md") }],
      index: null,
    });
    // Planned again once written: the seat has no index left to merge.
    assert.deepStrictEqual(planAutoMerge(inputOf([file("MEMORY.md", half)], written(seat, plan))), {
      renames: [],
      index: null,
    });
  });

  it("renames this seat's index when the link lists one whose text was not sent", () => {
    const input = inputOf([file("MEMORY.md", "- theirs\n")], [file("MEMORY.md", "- mine\n")]);
    const plan = planAutoMerge({ ...input, link: { ...input.link, index: null } });
    assert.deepStrictEqual(plan, {
      renames: [{ from: "MEMORY.md", to: renamed("MEMORY.md") }],
      index: null,
    });
  });
});

describe("planAutoMerge: files", () => {
  it("renames a same-name file with other content and points its index line at it", () => {
    const link = [
      file("MEMORY.md", "- [Notes](notes.md) from the desk\n"),
      file("notes.md", "desk notes"),
    ];
    const seat = [
      file(
        "MEMORY.md",
        "- [Notes](notes.md) on the road\n- see notes.md, not my-notes.md or notes.md.bak\n- [Mine](./notes.md)\n- [Other](my-notes.md)\n",
      ),
      file("notes.md", "road notes"),
      file("my-notes.md", "untouched"),
    ];
    const plan = planAutoMerge(inputOf(link, seat));
    const to = renamed("notes.md");
    assert.deepStrictEqual(plan.renames, [{ from: "notes.md", to }]);
    assert.strictEqual(
      plan.index?.content,
      `- [Notes](notes.md) from the desk\n- [Notes](${to}) on the road\n- see ${to}, not my-notes.md or notes.md.bak\n- [Mine](./${to})\n- [Other](my-notes.md)\n`,
    );
  });

  it("points the line at the renamed copy even when the link has the same line", () => {
    const line = "- [Notes](notes.md) shared wording\n";
    const plan = planAutoMerge(
      inputOf(
        [file("MEMORY.md", line), file("notes.md", "desk")],
        [file("MEMORY.md", `- [Work](work.md)\n${line}`), file("notes.md", "road")],
      ),
    );
    assert.strictEqual(
      plan.index?.content,
      `${line}- [Work](work.md)\n- [Notes](${renamed("notes.md")}) shared wording\n`,
    );
  });

  it("reads lines after the link's own as this seat's, so a union is never rewritten", () => {
    const linkIndex = "- [Notes](notes.md) desk\n";
    const to = renamed("notes.md");
    // An index that already starts with the link's lines: only the rest is this seat's.
    const plan = planAutoMerge(
      inputOf(
        [file("MEMORY.md", linkIndex), file("notes.md", "desk")],
        [file("MEMORY.md", `${linkIndex}- [Notes](${to}) road\n`), file("notes.md", "road")],
      ),
    );
    assert.deepStrictEqual(plan.renames, [{ from: "notes.md", to }]);
    assert.strictEqual(plan.index?.content, `${linkIndex}- [Notes](${to}) road\n`);
  });

  it("does nothing for the same name with the same content, or a file one side has", () => {
    const plan = planAutoMerge(
      inputOf(
        [file("same.md", "equal"), file("theirs.md", "t")],
        [file("same.md", "equal"), file("mine.md", "m")],
      ),
    );
    assert.deepStrictEqual(plan, { renames: [], index: null });
  });

  it("treats a target that already holds the same content as a rename to finish", () => {
    const seat = [file("notes.md", "road"), file(renamed("notes.md"), "road")];
    const plan = planAutoMerge(inputOf([file("notes.md", "desk")], seat));
    assert.deepStrictEqual(plan.renames, [{ from: "notes.md", to: renamed("notes.md") }]);
    assert.deepStrictEqual(
      planAutoMerge(inputOf([file("notes.md", "desk")], written(seat, plan))).renames,
      [],
    );
  });

  it("takes the next free name, never an occupied one", () => {
    const first = renamed("notes.md");
    const second = first.replace(/\.md$/, "-2.md");
    const third = first.replace(/\.md$/, "-3.md");
    // This seat already holds the first name with other content; the link holds the second.
    const plan = planAutoMerge(
      inputOf(
        [file("notes.md", "desk"), file(second, "someone else's")],
        [file("notes.md", "road"), file(first, "an older copy")],
      ),
    );
    assert.deepStrictEqual(plan.renames, [{ from: "notes.md", to: third }]);
    assert.isTrue(isMemoryName(third));
    // The same inputs give the same name.
    assert.deepStrictEqual(
      planAutoMerge(
        inputOf(
          [file("notes.md", "desk"), file(second, "someone else's")],
          [file("notes.md", "road"), file(first, "an older copy")],
        ),
      ).renames,
      plan.renames,
    );
  });

  it("never renames into a name kept on this machine", () => {
    const first = renamed("notes.md");
    const plan = planAutoMerge(
      inputOf([file("notes.md", "desk")], [file("notes.md", "road")], [first]),
    );
    assert.deepStrictEqual(plan.renames, [
      { from: "notes.md", to: first.replace(/\.md$/, "-2.md") },
    ]);
  });

  it("gives two clashing files different, valid names, also at the length limit", () => {
    const long = `${"n".repeat(124)}.md`;
    const other = `${"n".repeat(123)}x.md`;
    const plan = planAutoMerge(
      inputOf([file(long, "a"), file(other, "b")], [file(long, "c"), file(other, "d")]),
    );
    const targets = plan.renames.map((rename) => rename.to);
    assert.strictEqual(new Set(targets).size, 2);
    for (const target of targets) assert.isTrue(isMemoryName(target), target);
  });

  it("leaves local-only and secret-flagged files alone", () => {
    // Built at run time, so no key-shaped literal sits in the repository.
    const secret = `token ${["sk", "live", "k".repeat(24)].join("-")}`;
    const seat = [
      file("MEMORY.md", "- [Private](private.md)\n- [Keys](keys.md)\n"),
      file("private.md", "stays here"),
      file("keys.md", secret),
    ];
    const plan = planAutoMerge(
      inputOf(
        [file("MEMORY.md", "- [Private](private.md) theirs\n"), file("private.md", "theirs")],
        seat,
        ["private.md", "keys.md"],
      ),
    );
    assert.deepStrictEqual(plan.renames, []);
    assert.strictEqual(
      plan.index?.content,
      "- [Private](private.md) theirs\n- [Private](private.md)\n- [Keys](keys.md)\n",
    );
  });
});

describe("planAutoMerge: repeatable and lossless", () => {
  const link = [
    file("MEMORY.md", "# Memory\n\n- [Notes](notes.md) desk\n- [Home](home.md)\n"),
    file("notes.md", "desk notes"),
    file("home.md", "the house"),
    file("people.md", "desk people"),
  ];
  const seat = [
    file("MEMORY.md", "# Memory\n\n- [Notes](notes.md) road\n- [Work](work.md)\n- people.md\n"),
    file("notes.md", "road notes"),
    file("work.md", "the office"),
    file("people.md", "road people"),
    file("home.md", "the house"),
  ];

  it("plans the same again, and nothing more once written", () => {
    const plan = planAutoMerge(inputOf(link, seat));
    assert.deepStrictEqual(planAutoMerge(inputOf(link, seat)), plan);
    assert.strictEqual(plan.renames.length, 2);
    const after = planAutoMerge(inputOf(link, written(seat, plan)));
    assert.deepStrictEqual(after.renames, []);
    assert.strictEqual(after.index?.content, plan.index?.content);
  });

  it("plans the same renames and index after a restart between the index and the renames", () => {
    const plan = planAutoMerge(inputOf(link, seat));
    const halfway = planAutoMerge(inputOf(link, written(seat, plan, "index")));
    assert.deepStrictEqual(halfway.renames, plan.renames);
    assert.strictEqual(halfway.index?.content, plan.index?.content);
  });

  it("keeps its index once every seat holds the union", () => {
    const plan = planAutoMerge(inputOf(link, seat));
    const union = file("MEMORY.md", plan.index!.content);
    // The link took the union and the renamed copies; this seat took the link's files.
    const merged = [
      ...written(seat, plan),
      ...link.filter((entry) => entry.name !== "MEMORY.md" && entry.name !== "home.md"),
    ];
    const linkAfter = [...merged.filter((entry) => entry.name !== "MEMORY.md"), union];
    const again = planAutoMerge(inputOf(linkAfter, merged));
    assert.deepStrictEqual(again.renames, []);
    assert.strictEqual(again.index?.content, union.content);
    assert.isNull(again.index?.base);
  });

  it("loses no line and no file of either side", () => {
    const plan = planAutoMerge(inputOf(link, seat));
    const mine = written(seat, plan);
    // What every seat holds after the first sync: both sides' names, which no longer clash.
    const theirs = new Map(link.map((entry) => [entry.name, entry.content]));
    for (const entry of mine)
      if (entry.name !== "MEMORY.md")
        assert.strictEqual(theirs.get(entry.name) ?? entry.content, entry.content, entry.name);
    const contents = new Set([...link, ...mine].map((entry) => entry.content));
    for (const original of [...link, ...seat])
      if (original.name !== "MEMORY.md")
        assert.isTrue(contents.has(original.content), original.name);
    const lines = new Set(plan.index!.content.split("\n"));
    for (const line of link[0]!.content.split("\n")) assert.isTrue(lines.has(line), line);
    const pointers = new Map(plan.renames.map((rename) => [rename.from, rename.to]));
    for (const line of seat[0]!.content.split("\n")) {
      const followed = [...pointers].reduce((text, [from, to]) => text.replace(from, to), line);
      assert.isTrue(lines.has(followed), followed);
    }
  });
});

const desktop = {
  environmentId: EnvironmentId.make("env-desktop"),
  projectId: ProjectId.make("percy-desktop"),
};
const laptop = {
  environmentId: EnvironmentId.make("env-laptop"),
  projectId: ProjectId.make("percy-laptop"),
};
const tablet = {
  environmentId: EnvironmentId.make("env-tablet"),
  projectId: ProjectId.make("percy-tablet"),
};
const identityOf = (seats: ReadonlyArray<typeof desktop>) => ({
  id: "logical:percy:test",
  members: seats.map((seat) => ({
    ...seat,
    coordinatorThreadId: ThreadId.make(`coordinator:${seat.projectId}`),
  })),
});

const servicesOf = (seat: Machine) =>
  Effect.provide(
    Effect.gen(function* () {
      return {
        workspace: yield* Workspace.ProjectWorkspaceService,
        histories: yield* LinkedMemoryHistory.LinkedMemoryHistory,
      } satisfies AutoMergeServices;
    }),
    seat.context,
  );
const filesOf = (seat: Machine) =>
  servicesOf(seat).pipe(
    Effect.flatMap(({ workspace }) =>
      workspace.readMemoryFiles({ projectId: seat.self.projectId }),
    ),
    Effect.map((files) => Object.fromEntries(files.map((entry) => [entry.name, entry.content]))),
  );
/** What a joining seat is told about the link: the member's export. */
const linkOf = (exported: LinkedMemoryExport) => ({
  files: exported.files.map((entry) => ({ name: entry.name, sha256: entry.contentSha256 })),
  index: exported.files.find((entry) => entry.name === "MEMORY.md")?.content ?? null,
});
const join = (seat: Machine, label: string, member: Machine, services?: AutoMergeServices) =>
  Effect.gen(function* () {
    return yield* autoMergeJoiningSeat(services ?? (yield* servicesOf(seat)), {
      projectId: seat.self.projectId,
      link: linkOf(yield* member.exported),
      machineLabel: label,
      environmentId: seat.self.environmentId,
      localOnly: new Set(),
    });
  });
const assertClean = (files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    assert.isFalse(hasClashMarkers(content), `${name} holds clash markers`);
    assert.notInclude(name, ".conflict-");
  }
};

describe("applyAutoMerge with the real memory sync", () => {
  const linkIndex = "# Memory\n\n- [Notes](notes.md) desk\n- [Home](home.md)\n";
  const seatIndex = "# Memory\n\n- [Notes](notes.md) road\n- [Work](work.md)\n";
  const seed = (member: Machine, joiner: Machine) =>
    Effect.gen(function* () {
      yield* member.write("MEMORY.md", linkIndex);
      yield* member.write("notes.md", "desk notes");
      yield* member.write("home.md", "the house");
      yield* joiner.write("MEMORY.md", seatIndex);
      yield* joiner.write("notes.md", "road notes");
      yield* joiner.write("work.md", "the office");
    });

  it.effect("gives every seat the union after the first sync, with no clash markers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const identity = identityOf([desktop, laptop]);
        const a = yield* machine(desktop, "Desktop", identity, "personal");
        const b = yield* machine(laptop, "Laptop", identity, "personal");
        yield* seed(a, b);

        const joined = yield* join(b, "Laptop", a);
        const to = renamedMemoryName("notes.md", "Laptop", laptop.environmentId);
        const union = `${linkIndex}- [Notes](${to}) road\n- [Work](work.md)\n`;
        assert.deepStrictEqual(joined.renamed, [{ from: "notes.md", to }]);
        assert.isTrue(joined.indexWritten);
        assert.strictEqual(joined.plan.index?.content, union);
        // The rename left no tombstone for the link's file of that name.
        assert.deepStrictEqual((yield* b.history).tombstones, {});

        const first = yield* pass(a, b);
        assert.deepStrictEqual(first.onLeft.conflicts, []);
        assert.deepStrictEqual(first.onRight.conflicts, []);
        const expected = {
          "MEMORY.md": union,
          "home.md": "the house",
          "notes.md": "desk notes",
          [to]: "road notes",
          "work.md": "the office",
        };
        assert.deepStrictEqual(yield* filesOf(a), expected);
        assert.deepStrictEqual(yield* filesOf(b), expected);
        assertClean(yield* filesOf(a));

        // A second pass has nothing left to do, and a second join changes nothing.
        const second = yield* pass(a, b);
        assert.deepStrictEqual(second.onLeft.applied, []);
        assert.deepStrictEqual(second.onRight.applied, []);
        const again = yield* join(b, "Laptop", a);
        assert.deepStrictEqual(again.renamed, []);
        assert.isFalse(again.indexWritten);
        assert.deepStrictEqual(yield* filesOf(b), expected);
      }),
    ),
  );

  it.effect("without the merge base the same two indexes end in clash markers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const identity = identityOf([desktop, laptop]);
        const a = yield* machine(desktop, "Desktop", identity, "personal");
        const b = yield* machine(laptop, "Laptop", identity, "personal");
        yield* seed(a, b);
        const services = yield* servicesOf(b);
        // The union written as an ordinary edit: the link's version is not in its history.
        const joined = yield* join(b, "Laptop", a, {
          workspace: services.workspace,
          histories: { saveVersion: () => Effect.succeed(false), modify: services.histories.read },
        });
        assert.isTrue(joined.indexWritten);
        yield* pass(a, b);
        assert.isTrue(hasClashMarkers((yield* filesOf(a))["MEMORY.md"]!));
      }),
    ),
  );

  it.effect("finishes a join that stopped between the index and the renames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const identity = identityOf([desktop, laptop]);
        const a = yield* machine(desktop, "Desktop", identity, "personal");
        const b = yield* machine(laptop, "Laptop", identity, "personal");
        yield* seed(a, b);
        const services = yield* servicesOf(b);
        const stopped = yield* Effect.flip(
          join(b, "Laptop", a, {
            ...services,
            workspace: {
              ...services.workspace,
              renameMemory: () =>
                Effect.fail(
                  new ProjectWorkspaceError({
                    projectId: laptop.projectId,
                    code: "operation_failed",
                  }),
                ),
            },
          }),
        );
        assert.instanceOf(stopped, PersonalAutoMergeError);
        assert.strictEqual(stopped.stage, "rename");
        assert.strictEqual(stopped.name, "notes.md");
        const halfway = yield* filesOf(b);
        assert.strictEqual(halfway["notes.md"], "road notes");

        const joined = yield* join(b, "Laptop", a);
        const to = renamedMemoryName("notes.md", "Laptop", laptop.environmentId);
        assert.deepStrictEqual(joined.renamed, [{ from: "notes.md", to }]);
        assert.isFalse(joined.indexWritten);
        assert.strictEqual((yield* filesOf(b))["MEMORY.md"], halfway["MEMORY.md"]);

        yield* pass(a, b);
        const merged = yield* filesOf(a);
        assert.deepStrictEqual(yield* filesOf(b), merged);
        assert.strictEqual(merged["MEMORY.md"], halfway["MEMORY.md"]);
        assert.strictEqual(merged[to], "road notes");
        assertClean(merged);
      }),
    ),
  );

  it.effect("merges two seats that joined the same link at the same time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const identity = identityOf([desktop, laptop, tablet]);
        const a = yield* machine(desktop, "Desktop", identity, "personal");
        const b = yield* machine(laptop, "Laptop", identity, "personal");
        const c = yield* machine(tablet, "Tablet", identity, "personal");
        yield* seed(a, b);
        yield* c.write("MEMORY.md", "# Memory\n\n- [Notes](notes.md) couch\n- [Books](books.md)\n");
        yield* c.write("notes.md", "couch notes");
        yield* c.write("books.md", "the shelf");
        // Both plan against the link as it was before either union reached it.
        yield* join(b, "Laptop", a);
        yield* join(c, "Tablet", a);

        for (let round = 0; round < 3; round += 1) {
          yield* pass(b, c);
          yield* pass(a, b);
          yield* pass(a, c);
        }
        const merged = yield* filesOf(a);
        assert.deepStrictEqual(yield* filesOf(b), merged);
        assert.deepStrictEqual(yield* filesOf(c), merged);
        assertClean(merged);
        const lines = merged["MEMORY.md"]!.split("\n");
        assert.deepStrictEqual(lines.slice(0, 4), linkIndex.split("\n").slice(0, 4));
        const fromLaptop = renamedMemoryName("notes.md", "Laptop", laptop.environmentId);
        const fromTablet = renamedMemoryName("notes.md", "Tablet", tablet.environmentId);
        for (const line of [
          `- [Notes](${fromLaptop}) road`,
          "- [Work](work.md)",
          `- [Notes](${fromTablet}) couch`,
          "- [Books](books.md)",
        ])
          assert.include(lines, line);
        assert.strictEqual(merged["notes.md"], "desk notes");
        assert.strictEqual(merged[fromLaptop], "road notes");
        assert.strictEqual(merged[fromTablet], "couch notes");
        assert.strictEqual(Object.keys(merged).length, 7);
      }),
    ),
  );

  it.effect("applies a plan made elsewhere, skipping what is already written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* machine(laptop, "Laptop", identityOf([desktop, laptop]), "personal");
        yield* b.write("notes.md", "road notes");
        const services = yield* servicesOf(b);
        const plan: AutoMergePlan = {
          renames: [{ from: "notes.md", to: "notes.from-laptop.md" }],
          index: null,
        };
        const first = yield* applyAutoMerge(services, { projectId: laptop.projectId, plan });
        const second = yield* applyAutoMerge(services, { projectId: laptop.projectId, plan });
        assert.deepStrictEqual(first.renamed, plan.renames);
        assert.deepStrictEqual(second, { indexWritten: false, renamed: [] });
        assert.deepStrictEqual(yield* filesOf(b), { "notes.from-laptop.md": "road notes" });
      }),
    ),
  );
});
