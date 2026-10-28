import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it as plainIt } from "@effect/vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  foldSpecweaveLedger,
  MAX_INCREMENTS_PER_PROJECT,
  parseSpecweaveSpec,
  parseVerifyReport,
  readSpecweaveProgress,
} from "./SpecweaveProgress.ts";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW - hours * 3_600_000));

const SPEC = `# Billing retries

## Acceptance Criteria

- [ ] AC-01: Failed charges retry three times.
- [x] AC-02: The user sees the retry state.
- [ ] AC-03: Nothing covers this one.

\`\`\`
### T-99 Not a task, inside a fence
- [ ] AC-99: Not a criterion either
\`\`\`

## Tasks

### T-01 Retry worker
- AC: AC-01 | Files: /Users/someone/secret/path.ts | Test: npm test -- retry

### T-02 Retry badge
- AC: AC-02, AC-09 | Files: web/badge.tsx | Test: npm test -- badge

### T-03 Docs
- Files: docs/retry.md | Test: true
`;

const ledgerLine = (entry: Record<string, string>) => JSON.stringify(entry);

describe("parseSpecweaveSpec", () => {
  plainIt("reads ACs and tasks outside fences, with the ACs each task cites", () => {
    const parsed = parseSpecweaveSpec(SPEC);
    assert.equal(parsed.title, "Billing retries");
    assert.deepEqual(
      parsed.criteria.map((criterion) => criterion.id),
      ["AC-01", "AC-02", "AC-03"],
    );
    assert.deepEqual(
      parsed.tasks.map((task) => [task.id, task.criteria]),
      [
        ["T-01", ["AC-01"]],
        ["T-02", ["AC-02", "AC-09"]],
        ["T-03", []],
      ],
    );
    // Files and Test fields never reach the summary.
    assert.notInclude(JSON.stringify(parsed), "/Users/someone");
    assert.notInclude(JSON.stringify(parsed), "npm test");
  });

  plainIt("reads the older bold AC and colon task forms", () => {
    const parsed = parseSpecweaveSpec(
      [
        "### US-001",
        "- [ ] **AC-US1-01**: Works",
        "",
        "### T-001: Build it",
        "**Satisfies ACs**: AC-US1-01 | **Status**: [x] completed",
        "### T-002: Test it",
        "**Satisfies ACs**: AC-US1-01 | **Status**: [ ] pending",
      ].join("\n"),
    );
    assert.deepEqual(parsed.criteria, [{ id: "AC-US1-01", text: "Works", story: "US-001" }]);
    assert.deepEqual(parsed.tasks, [
      { id: "T-001", title: "Build it", criteria: ["AC-US1-01"], checked: true },
      { id: "T-002", title: "Test it", criteria: ["AC-US1-01"], checked: false },
    ]);
    // With no ledger, an older increment's checked task reads as done.
    assert.deepEqual(
      foldSpecweaveLedger(parsed.tasks, "", NOW).tasks.map((task) => task.status),
      ["done", "planned"],
    );
  });
});

describe("parseSpecweaveSpec criteria forms", () => {
  plainIt("reads ACs without a checkbox, but not a task's AC bullet", () => {
    const parsed = parseSpecweaveSpec(
      [
        "- AC-US1-01 — Rows show the project path.",
        "- AC-US1-02: Rows show the user path.",
        "",
        "### T-01 Rows",
        "- AC-US1-01, AC-US1-02",
        "- AC-US1-09",
      ].join("\n"),
    );
    assert.deepEqual(parsed.criteria, [
      { id: "AC-US1-01", text: "Rows show the project path.", story: "US-001" },
      { id: "AC-US1-02", text: "Rows show the user path.", story: "US-001" },
    ]);
    assert.deepEqual(parsed.tasks[0]?.criteria, ["AC-US1-01", "AC-US1-02", "AC-US1-09"]);
  });
});

describe("parseSpecweaveSpec traceability", () => {
  plainIt("keeps an AC tick as a declaration and the story heading it sits under", () => {
    const parsed = parseSpecweaveSpec(
      [
        "## User Stories",
        "### US-002: Search",
        "- [x] AC-01: Finds by id",
        "## Acceptance Criteria",
        "- [ ] AC-02: Pages",
      ].join("\n"),
    );
    assert.deepEqual(parsed.criteria, [
      { id: "AC-01", text: "Finds by id", checked: true, story: "US-002" },
      { id: "AC-02", text: "Pages" },
    ]);
  });
});

describe("foldSpecweaveLedger", () => {
  const tasks = parseSpecweaveSpec(SPEC).tasks;

  plainIt("follows the ledger's lease, terminal and owner rules", () => {
    const ledger = [
      ledgerLine({ t: "T-01", e: "claim", by: "a@host", at: hoursAgo(5) }),
      ledgerLine({ t: "T-01", e: "done", by: "a@host", at: hoursAgo(4), evidence: "abc123" }),
      ledgerLine({ t: "T-01", e: "claim", by: "b@host", at: hoursAgo(3) }),
      ledgerLine({ t: "T-02", e: "claim", by: "a@host", at: hoursAgo(1) }),
      ledgerLine({ t: "T-02", e: "block", by: "b@host", at: hoursAgo(0.5), note: "not mine" }),
      ledgerLine({ t: "T-03", e: "claim", by: "c@host", at: hoursAgo(3) }),
      ledgerLine({ t: "*", e: "note", by: "c@host", at: hoursAgo(2), note: "meta" }),
      "{not json",
    ].join("\n");
    const folded = foldSpecweaveLedger(tasks, ledger, NOW);
    const byId = Object.fromEntries(folded.tasks.map((task) => [task.id, task]));
    assert.equal(byId["T-01"]?.status, "done");
    assert.equal(byId["T-01"]?.changedAt, hoursAgo(4));
    // b cannot block a task a holds inside the two-hour lease.
    assert.equal(byId["T-02"]?.status, "claimed");
    assert.equal(byId["T-03"]?.status, "stale");
    assert.equal(folded.malformed, 1);
    // Owners and evidence never reach the summary.
    assert.notInclude(JSON.stringify(folded), "@host");
    assert.notInclude(JSON.stringify(folded), "abc123");
  });

  plainIt("keeps a bounded block reason", () => {
    const folded = foldSpecweaveLedger(
      tasks,
      ledgerLine({
        t: "T-03",
        e: "block",
        by: "c@host",
        at: hoursAgo(1),
        note: "waits on API key",
      }),
      NOW,
    );
    assert.equal(folded.tasks[2]?.status, "blocked");
    assert.equal(folded.tasks[2]?.note, "waits on API key");
  });
});

describe("foldSpecweaveLedger evidence and reasons", () => {
  const tasks = parseSpecweaveSpec(SPEC).tasks;

  plainIt("ignores done without evidence and skip without a reason, like SpecWeave", () => {
    const ledger = [
      ledgerLine({ t: "T-01", e: "claim", by: "a@host", at: hoursAgo(1.5) }),
      ledgerLine({ t: "T-01", e: "done", by: "a@host", at: hoursAgo(1.4) }),
      ledgerLine({ t: "T-02", e: "skip", by: "a@host", at: hoursAgo(1.3), note: "   " }),
      ledgerLine({ t: "T-03", e: "done", by: "a@host", at: hoursAgo(1.2), evidence: " " }),
      ledgerLine({ t: "T-03", e: "claim", by: "b@host", at: hoursAgo(1.1) }),
      ledgerLine({ t: "T-03", e: "done", by: "b@host", at: hoursAgo(1), evidence: "def456" }),
    ].join("\n");
    const byId = Object.fromEntries(
      foldSpecweaveLedger(tasks, ledger, NOW).tasks.map((task) => [task.id, task.status]),
    );
    assert.deepEqual(byId, { "T-01": "claimed", "T-02": "planned", "T-03": "done" });
  });

  plainIt("counts ledger lines past the cap as malformed", () => {
    const line = ledgerLine({ t: "*", e: "note", by: "a@host", at: hoursAgo(1), note: "x" });
    const folded = foldSpecweaveLedger(tasks, Array(10_002).fill(line).join("\n"), NOW);
    assert.equal(folded.malformed, 2);
  });
});

describe("parseVerifyReport", () => {
  plainIt("keeps only ok and ranAt", () => {
    assert.deepEqual(
      parseVerifyReport(
        JSON.stringify({ ok: false, ranAt: "2026-10-10T22:55:09.715Z", commands: [{ cmd: "x" }] }),
      ),
      { ok: false, ranAt: "2026-10-10T22:55:09.715Z" },
    );
    assert.isNull(parseVerifyReport("nope"));
    assert.isNull(parseVerifyReport(null));
  });
});

it.layer(NodeServices.layer)("readSpecweaveProgress", (it) => {
  it.effect("lists open and recently closed increments without paths or owners", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "specweave-progress-" });
      const increments = path.join(root, ".specweave", "increments");
      const seed = (name: string, files: Record<string, string>) =>
        Effect.forEach(Object.entries(files), ([file, text]) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(path.join(increments, name, file)), {
              recursive: true,
            });
            yield* fs.writeFileString(path.join(increments, name, file), text);
          }),
        );
      yield* seed("0901-billing-retries", {
        "metadata.json": JSON.stringify({ status: "active", lastActivity: hoursAgo(1) }),
        "spec.md": SPEC,
        "ledger.jsonl": ledgerLine({ t: "T-01", e: "claim", by: "a@host", at: hoursAgo(1) }),
        "reports/verify.json": JSON.stringify({ ok: true, ranAt: hoursAgo(2) }),
      });
      yield* seed("0900-old-closed", {
        "metadata.json": JSON.stringify({ status: "completed", lastActivity: hoursAgo(24 * 30) }),
        "spec.md": SPEC,
      });
      yield* seed("0899-just-closed", {
        "metadata.json": JSON.stringify({ status: "completed", lastActivity: hoursAgo(24) }),
        "spec.md": SPEC,
      });
      yield* seed("0898-no-tasks", {
        "metadata.json": JSON.stringify({ status: "planned" }),
        "spec.md": "# Nothing yet\n",
      });
      yield* seed("_archive", { "metadata.json": "{}" });

      const result = yield* readSpecweaveProgress(
        [
          { title: "Payments", workspaceRoot: root },
          { title: "Same root twice", workspaceRoot: root },
          { title: "Missing", workspaceRoot: path.join(root, "does-not-exist") },
        ],
        NOW,
      );
      assert.deepEqual(
        result.increments.map((increment) => [increment.id, increment.status, increment.readable]),
        [
          ["0901-billing-retries", "active", true],
          ["0899-just-closed", "completed", true],
          ["0898-no-tasks", "planned", false],
        ],
      );
      const first = result.increments[0]!;
      assert.equal(first.project, "Payments");
      assert.equal(first.title, "Billing retries");
      assert.deepEqual(first.verify, { ok: true, ranAt: hoursAgo(2) });
      assert.equal(first.tasks[0]?.status, "claimed");
      assert.isFalse(result.truncated);
      const text = JSON.stringify(result);
      assert.notInclude(text, root);
      assert.notInclude(text, "@host");
    }),
  );

  it.effect("tolerates bad files and reads tasks.md like SpecWeave does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "specweave-progress-" });
      const write = (file: string, data: string | Uint8Array) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* typeof data === "string"
            ? fs.writeFileString(file, data)
            : fs.writeFile(file, data);
        });
      const good = path.join(base, "good");
      const bad = path.join(base, "bad");
      const outside = path.join(base, "outside");
      const linked = path.join(base, "linked");
      const inc = (root: string, name: string, file: string) =>
        path.join(root, ".specweave", "increments", name, file);
      const active = JSON.stringify({ status: "active", lastActivity: hoursAgo(1) });

      // Invalid UTF-8 in one project must not take the others down.
      yield* write(inc(bad, "0001-latin", "metadata.json"), active);
      yield* write(
        inc(bad, "0001-latin", "spec.md"),
        new Uint8Array([...new TextEncoder().encode("# Caf"), 0xe9]),
      );
      // tasks.md wins over spec.md; tasks.md alone is enough.
      yield* write(inc(good, "0003-split", "metadata.json"), active);
      yield* write(inc(good, "0003-split", "spec.md"), SPEC);
      yield* write(
        inc(good, "0003-split", "tasks.md"),
        "### T-01 One\n- AC: AC-01\n### T-02 Two\n- AC: AC-02\n### T-03 Three\n### T-04 Four\n",
      );
      yield* write(inc(good, "0002-tasks-only", "metadata.json"), active);
      yield* write(inc(good, "0002-tasks-only", "tasks.md"), "### T-01 Only\n");
      // A ledger the reader rejects marks the increment unreadable.
      yield* write(inc(good, "0001-big-ledger", "metadata.json"), active);
      yield* write(inc(good, "0001-big-ledger", "spec.md"), SPEC);
      yield* write(inc(good, "0001-big-ledger", "ledger.jsonl"), "x".repeat(1_048_577));
      // Folder names the contract cannot carry are skipped.
      yield* write(inc(good, `0004-${"a".repeat(170)}`, "spec.md"), SPEC);
      // An increments folder linked outside the project is ignored.
      yield* write(inc(outside, "0009-elsewhere", "spec.md"), SPEC);
      yield* fs.makeDirectory(path.join(linked, ".specweave"), { recursive: true });
      yield* fs.symlink(
        path.join(outside, ".specweave", "increments"),
        path.join(linked, ".specweave", "increments"),
      );

      const result = yield* readSpecweaveProgress(
        [
          { title: "Bad", workspaceRoot: bad },
          { title: "Linked", workspaceRoot: linked },
          { title: "Good", workspaceRoot: good },
        ],
        NOW,
      );
      assert.deepEqual(
        result.increments.map((increment) => [
          increment.project,
          increment.id,
          increment.readable,
          increment.tasks.length,
        ]),
        [
          ["Bad", "0001-latin", false, 0],
          ["Good", "0003-split", true, 4],
          ["Good", "0002-tasks-only", true, 1],
          ["Good", "0001-big-ledger", false, 0],
        ],
      );
      assert.deepEqual(
        result.increments[1]!.criteria.map((criterion) => criterion.id),
        ["AC-01", "AC-02", "AC-03"],
      );
    }),
  );

  /** A temporary project holding these increments, each with metadata and a spec. */
  const seedProject = (
    increments: ReadonlyArray<{ readonly name: string; readonly metadata: object }>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "specweave-progress-" });
      yield* Effect.forEach(
        increments,
        ({ name, metadata }) =>
          Effect.gen(function* () {
            const folder = path.join(root, ".specweave", "increments", name);
            yield* fs.makeDirectory(folder, { recursive: true });
            yield* fs.writeFileString(path.join(folder, "metadata.json"), JSON.stringify(metadata));
            yield* fs.writeFileString(path.join(folder, "spec.md"), SPEC);
          }),
        { concurrency: 16 },
      );
      return root;
    });
  const numbered = (number: number, slug: string) =>
    `${String(number).padStart(4, "0")}-${slug}-${number}`;

  it.effect("finds an open increment older than hundreds of closed ones", () =>
    Effect.gen(function* () {
      const root = yield* seedProject([
        { name: "0001-ancient-open", metadata: { status: "active", lastActivity: hoursAgo(1) } },
        ...Array.from({ length: 450 }, (_, index) => ({
          name: numbered(index + 2, "closed"),
          metadata: { status: "completed", lastActivity: hoursAgo(24 * 60) },
        })),
      ]);
      const result = yield* readSpecweaveProgress(
        [{ title: "Umbrella", workspaceRoot: root }],
        NOW,
      );
      assert.deepEqual(
        result.increments.map((increment) => increment.id),
        ["0001-ancient-open"],
      );
      assert.isFalse(result.truncated);
    }),
  );

  it.effect("reads a closed increment's metadata past 64 KB as closed, not unknown", () =>
    Effect.gen(function* () {
      const root = yield* seedProject([
        { name: "0002-open", metadata: { status: "active", lastActivity: hoursAgo(1) } },
        {
          name: "0001-big-closed",
          metadata: {
            status: "completed",
            lastActivity: hoursAgo(24 * 60),
            acSyncEvents: Array.from({ length: 1_500 }, (_, index) => ({
              at: hoursAgo(24 * 60),
              note: `sync event ${index} with some detail`,
            })),
          },
        },
      ]);
      const result = yield* readSpecweaveProgress([{ title: "Big", workspaceRoot: root }], NOW);
      assert.deepEqual(
        result.increments.map((increment) => increment.id),
        ["0002-open"],
      );
    }),
  );

  it.effect("sorts increments by number past 9999", () =>
    Effect.gen(function* () {
      const open = { status: "active", lastActivity: hoursAgo(1) };
      const root = yield* seedProject([
        { name: "0998-early", metadata: open },
        { name: "9999-four-digits", metadata: open },
        { name: "10000-five-digits", metadata: open },
      ]);
      const result = yield* readSpecweaveProgress([{ title: "Big", workspaceRoot: root }], NOW);
      assert.deepEqual(
        result.increments.map((increment) => increment.id),
        ["10000-five-digits", "9999-four-digits", "0998-early"],
      );
    }),
  );

  it.effect("keeps open increments over recently closed ones when the cap is hit", () =>
    Effect.gen(function* () {
      const root = yield* seedProject([
        { name: "0001-old-open", metadata: { status: "active", lastActivity: hoursAgo(24 * 90) } },
        ...Array.from({ length: MAX_INCREMENTS_PER_PROJECT + 5 }, (_, index) => ({
          name: numbered(index + 100, "just-closed"),
          metadata: { status: "completed", lastActivity: hoursAgo(24) },
        })),
      ]);
      const result = yield* readSpecweaveProgress([{ title: "Busy", workspaceRoot: root }], NOW);
      const ids = result.increments.map((increment) => increment.id);
      assert.lengthOf(ids, MAX_INCREMENTS_PER_PROJECT);
      assert.isTrue(result.truncated);
      // Still newest first: the old open increment comes last, after the newest closed ones.
      assert.equal(ids.at(-1), "0001-old-open");
      assert.equal(ids[0], numbered(MAX_INCREMENTS_PER_PROJECT + 104, "just-closed"));
    }),
  );
});

plainIt(
  "folds first complete accepted-skip per case-insensitive AC/check without AC task cards",
  () => {
    const tasks = parseSpecweaveSpec(SPEC).tasks;
    const waiver = {
      t: "ac-03",
      e: "accept-skip",
      by: "worker",
      at: hoursAgo(2),
      check: "Wonder-Full",
      reason: "No license",
      acceptedBy: "Anton",
      acceptedAt: hoursAgo(3),
      authorization: "User message: accept this skip",
    };
    const taskEvent = ledgerLine({
      t: "T-01",
      e: "done",
      by: "worker",
      at: hoursAgo(4),
      evidence: "verified-output",
    });
    const ledger = [
      taskEvent,
      JSON.stringify({ ...waiver, at: hoursAgo(5), reason: "" }),
      JSON.stringify({
        ...waiver,
        t: "AC-03",
        check: "wonder-full",
        at: hoursAgo(1),
        reason: "Later duplicate",
      }),
      JSON.stringify(waiver),
    ].join("\n");
    const result = foldSpecweaveLedger(tasks, ledger, NOW);
    assert.deepEqual(result.tasks, foldSpecweaveLedger(tasks, taskEvent, NOW).tasks);
    assert.lengthOf(result.acceptedSkips, 1);
    assert.deepEqual(result.acceptedSkips[0], {
      ac: "AC-03",
      check: waiver.check,
      reason: waiver.reason,
      acceptedBy: waiver.acceptedBy,
      acceptedAt: waiver.acceptedAt,
      authorization: waiver.authorization,
      by: waiver.by,
      at: waiver.at,
    });
    assert.isFalse(result.cards.some((card) => card.id.toUpperCase() === "AC-03"));
    const bad = foldSpecweaveLedger(
      tasks,
      JSON.stringify({ ...waiver, acceptedAt: "not a date" }),
      NOW,
    );
    assert.lengthOf(bad.acceptedSkips, 0);
  },
);
