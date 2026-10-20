/**
 * The card fold against the fixture SpecWeave's own ledger tests run
 * (repositories/anton-abyzov/specweave/tests/fixtures/cards/fold-fixture.json).
 * The copy here must stay byte-identical to that file; the last test checks
 * it whenever the sibling checkout is present.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  branchBoundIncrement,
  readThreadIncrementProgress,
  sanitizeCardLink,
} from "../../project/ThreadIncrementProgress.ts";
import { deriveCardLink, foldSpecweaveLedger, githubRepositoryUrl } from "../SpecweaveProgress.ts";

interface FixtureCase {
  readonly name: string;
  readonly origin?: string;
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly ledger: ReadonlyArray<Record<string, unknown>>;
  readonly expected: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
    readonly line: string;
    readonly link: string | null;
  }>;
}

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const FIXTURE = NodePath.join(here, "fixtures", "fold-fixture.json");
const cases = JSON.parse(NodeFS.readFileSync(FIXTURE, "utf8")) as FixtureCase[];
const NOW = Date.parse("2026-10-18T11:00:00Z");

describe("card fold fixture shared with SpecWeave", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    // Each event goes through the line parser, as ledger.jsonl does in production.
    const ledger = fixture.ledger.map((event) => JSON.stringify(event)).join("\n");
    const folded = foldSpecweaveLedger(
      fixture.tasks.map((task) => ({ ...task, criteria: [], checked: false })),
      ledger,
      NOW,
      { origin: fixture.origin ?? null },
    );
    expect(folded.cards).toEqual(fixture.expected);
    expect(folded.malformed).toBe(0);
  });

  it("keeps the mod summary to spec tasks, without links or evidence", () => {
    const folded = foldSpecweaveLedger(
      [{ id: "T-01", title: "Fold", criteria: [], checked: false }],
      [
        JSON.stringify({
          t: "T-01",
          e: "done",
          by: "claude@mbp",
          at: "2026-10-18T10:00:00Z",
          evidence: "secret-ish output HEAD abc1234",
        }),
        JSON.stringify({
          t: "C-01",
          e: "note",
          by: "claude@mbp",
          at: "2026-10-18T10:01:00Z",
          line: "x",
        }),
      ].join("\n"),
      NOW,
    );
    expect(folded.tasks.map((task) => task.id)).toEqual(["T-01"]);
    expect(JSON.stringify(folded.tasks)).not.toMatch(/abc1234|secret/u);
  });

  it("matches SpecWeave's copy of the fixture when that checkout is beside this one", () => {
    const candidates = [
      NodePath.resolve(here, "../../../../../../specweave/tests/fixtures/cards/fold-fixture.json"),
      NodePath.resolve(
        here,
        "../../../../../../specweave-cards/tests/fixtures/cards/fold-fixture.json",
      ),
    ];
    const source = candidates.find((file) => NodeFS.existsSync(file));
    if (source === undefined) return;
    expect(NodeFS.readFileSync(FIXTURE, "utf8")).toBe(NodeFS.readFileSync(source, "utf8"));
  });
});

describe("deriveCardLink", () => {
  it("keeps a log path outside the increments folder as written", () => {
    expect(deriveCardLink("log: /tmp/run.txt")).toBe("/tmp/run.txt");
  });

  it("returns null when evidence names nothing", () => {
    expect(deriveCardLink("exit 0")).toBeNull();
    expect(deriveCardLink(null)).toBeNull();
  });

  it("reads https and ssh GitHub origins", () => {
    expect(githubRepositoryUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(githubRepositoryUrl("git@github.com:o/r.git")).toBe("https://github.com/o/r");
    expect(githubRepositoryUrl("https://gitlab.com/o/r.git")).toBeNull();
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(increments: Record<string, { spec?: string; ledger?: string }>) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-cards-")),
  );
  roots.push(root);
  for (const [id, files] of Object.entries(increments)) {
    const folder = NodePath.join(root, ".specweave", "increments", id);
    await NodeFSP.mkdir(NodePath.join(folder, "reports"), { recursive: true });
    if (files.spec !== undefined)
      await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), files.spec);
    if (files.ledger !== undefined) {
      await NodeFSP.writeFile(NodePath.join(folder, "ledger.jsonl"), files.ledger);
    }
  }
  return root;
}

describe("sanitizeCardLink", () => {
  it("keeps https links on github.com and claude.ai only", async () => {
    const root = await project({ "0933-cards": {} });
    const folder = NodePath.join(root, ".specweave", "increments", "0933-cards");
    expect(await sanitizeCardLink("https://github.com/o/r/pull/1", folder)).toEqual({
      link: "https://github.com/o/r/pull/1",
    });
    expect(await sanitizeCardLink("https://claude.ai/artifact/abc", folder)).toEqual({
      link: "https://claude.ai/artifact/abc",
    });
    for (const bad of [
      "https://example.com/x",
      "http://github.com/o/r/pull/1",
      "https://user:pw@github.com/o/r",
      "https://github.com.evil.io/x",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      expect(await sanitizeCardLink(bad, folder)).toEqual({});
    }
  });

  it("keeps paths that resolve inside the increment folder and drops the rest", async () => {
    const root = await project({ "0933-cards": {} });
    const folder = NodePath.join(root, ".specweave", "increments", "0933-cards");
    const report = NodePath.join(folder, "reports", "task-T-01.txt");
    await NodeFSP.writeFile(report, "ok");
    await NodeFSP.writeFile(NodePath.join(root, "outside.txt"), "no");
    await NodeFSP.symlink(NodePath.join(root, "outside.txt"), NodePath.join(folder, "link.txt"));
    expect(await sanitizeCardLink("reports/task-T-01.txt", folder)).toEqual({ link: report });
    expect(await sanitizeCardLink(report, folder)).toEqual({ link: report });
    expect(await sanitizeCardLink("../../../outside.txt", folder)).toEqual({});
    expect(await sanitizeCardLink("link.txt", folder)).toEqual({});
    expect(await sanitizeCardLink("reports/missing.txt", folder)).toEqual({});
  });

  it("turns a bare sha into a commit", async () => {
    expect(await sanitizeCardLink("abc1234", "/nowhere")).toEqual({ commit: "abc1234" });
  });
});

const SPEC = `# Cards

## Acceptance Criteria
- [ ] AC-01: Rows link

## Tasks

### T-01 Fold
- AC: AC-01 | Files: a.ts | Test: npm test

### T-02 Render
- AC: AC-01 | Files: b.ts | Test: npm test
`;

describe("thread cards and binding by branch", () => {
  it("fills line, link and commit from the ledger", async () => {
    const ledger = [
      {
        t: "T-01",
        e: "claim",
        by: "claude@mbp",
        at: "2026-10-18T10:00:00Z",
        line: "Folded the ledger",
      },
      {
        t: "T-01",
        e: "done",
        by: "claude@mbp",
        at: "2026-10-18T10:10:00Z",
        evidence: "log: .specweave/increments/0933-cards/reports/task-T-01.txt",
      },
      {
        t: "T-02",
        e: "done",
        by: "claude@mbp",
        at: "2026-10-18T10:20:00Z",
        evidence: "HEAD abc1234",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const root = await project({ "0933-cards": { spec: SPEC, ledger } });
    const report = NodePath.join(
      root,
      ".specweave",
      "increments",
      "0933-cards",
      "reports",
      "task-T-01.txt",
    );
    await NodeFSP.writeFile(report, "exit 0");
    const [progress] = await readThreadIncrementProgress(
      root,
      [
        {
          threadId: "t1",
          title: null,
          branch: "inc/0933-studio-cards",
          worktreePath: null,
          home: root,
        },
      ],
      NOW,
    );
    expect(progress?.binding).toBe("branch");
    expect(progress?.tasks).toEqual([
      expect.objectContaining({ id: "T-01", line: "Folded the ledger", link: report }),
      expect.objectContaining({ id: "T-02", line: "Render", commit: "abc1234" }),
    ]);
    expect(progress?.tasks[1]).not.toHaveProperty("link");
  });

  it("binds an inc/NNNN branch only to a unique folder", async () => {
    const root = await project({ "0933-cards": {}, "0934-other": {}, "0935-a": {}, "0935-b": {} });
    expect(await branchBoundIncrement(root, "inc/0933-studio-cards")).toBe("0933-cards");
    expect(await branchBoundIncrement(root, "inc/0935-x")).toBeNull();
    expect(await branchBoundIncrement(root, "main")).toBeNull();
    expect(await branchBoundIncrement(root, null)).toBeNull();
  });

  it("binds a branch a ledger by names", async () => {
    const root = await project({
      "0931-design": {
        ledger: JSON.stringify({
          t: "T-01",
          e: "claim",
          by: "codex@m1:feature/weave",
          at: "2026-10-18T10:00:00Z",
        }),
      },
      "0932-loop": {
        ledger: JSON.stringify({
          t: "T-01",
          e: "claim",
          by: "claude@mbp",
          at: "2026-10-18T10:00:00Z",
          note: "feature/weave",
        }),
      },
    });
    expect(await branchBoundIncrement(root, "feature/weave")).toBe("0931-design");
    expect(await branchBoundIncrement(root, "feature/other")).toBeNull();
  });
});
