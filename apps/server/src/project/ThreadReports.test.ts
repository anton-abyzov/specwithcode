// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { reportKey } from "@specweave-studio/shared/threadReport";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { specweaveStudioCheckpointPath } from "../orchestration-v2/SpecweaveCheckpoint.ts";
import { readThreadReports, resolveReportIncrement, saveThreadReport } from "./ThreadReports.ts";

const roots: string[] = [];
const REPORT = [
  "# Review cycle 2",
  "",
  "No critical or high findings remain.",
  "",
  ...Array.from({ length: 14 }, (_, index) => `- finding ${index + 1}`),
].join("\n");

async function temp(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function project(increments: ReadonlyArray<string> = []): Promise<string> {
  const root = await temp("studio-reports-");
  await NodeFSP.mkdir(NodePath.join(root, ".specweave"), { recursive: true });
  for (const increment of increments) {
    await NodeFSP.mkdir(NodePath.join(root, ".specweave/increments", increment), {
      recursive: true,
    });
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("resolveReportIncrement", () => {
  it("matches a bare increment number in the thread title to its folder", async () => {
    const root = await project(["0972-other", "0973-budget-vs-actuals"]);
    const home = await temp("studio-home-");
    expect(
      await resolveReportIncrement(root, {
        threadId: "t1",
        title: "Review cycle 2 of 0973",
        branch: null,
        home,
      }),
    ).toBe("0973-budget-vs-actuals");
  });

  it("never guesses when a number names no folder or two folders", async () => {
    const root = await project(["0973-a", "0973-b"]);
    const home = await temp("studio-home-");
    const source = { threadId: "t1", branch: null, home };
    expect(await resolveReportIncrement(root, { ...source, title: "Fix 0973" })).toBeNull();
    expect(await resolveReportIncrement(root, { ...source, title: "Ship in 2026" })).toBeNull();
  });

  it("prefers the increment SpecWeave recorded for the thread", async () => {
    const root = await project(["0973-budget", "0980-reports"]);
    const home = await temp("studio-home-");
    const pointer = specweaveStudioCheckpointPath("thread-9", home);
    await NodeFSP.mkdir(NodePath.dirname(pointer), { recursive: true });
    await NodeFSP.writeFile(pointer, JSON.stringify({ version: 1, incrementId: "0980-reports" }));
    expect(
      await resolveReportIncrement(root, {
        threadId: "thread-9",
        title: "Review 0973",
        branch: null,
        home,
      }),
    ).toBe("0980-reports");
  });

  it("uses increment folders the report names, and the branch", async () => {
    const root = await project(["0973-budget", "0974-export"]);
    const home = await temp("studio-home-");
    const source = { threadId: "t", title: "Review", home };
    expect(await resolveReportIncrement(root, { ...source, branch: "inc/0974-export-fix" })).toBe(
      "0974-export",
    );
    expect(
      await resolveReportIncrement(
        root,
        { ...source, branch: null },
        "Files are in .specweave/increments/0973-budget/reports.",
      ),
    ).toBe("0973-budget");
  });
});

describe("resolveReportIncrement from report text", () => {
  it("never lets an increment-shaped word in the report pick a folder by its number", async () => {
    const root = await project(["1500-auth-rework"]);
    const home = await temp("studio-home-");
    const source = { threadId: "t", title: "Audit", branch: null, home };
    expect(
      await resolveReportIncrement(root, source, "Files stay under the 1500-line limit."),
    ).toBeNull();
    // Named in full, it counts.
    expect(await resolveReportIncrement(root, source, "Done in 1500-auth-rework as planned.")).toBe(
      "1500-auth-rework",
    );
  });

  it("does not map another repo's recorded increment onto a local folder with its number", async () => {
    const root = await project(["0042-local-thing"]);
    const home = await temp("studio-home-");
    const pointer = specweaveStudioCheckpointPath("thread-x", home);
    await NodeFSP.mkdir(NodePath.dirname(pointer), { recursive: true });
    await NodeFSP.writeFile(pointer, JSON.stringify({ version: 1, incrementId: "0042-elsewhere" }));
    expect(
      await resolveReportIncrement(root, { threadId: "thread-x", title: "x", branch: null, home }),
    ).toBeNull();
  });
});

describe("resolveReportIncrement past 9999", () => {
  it("matches five-digit increment numbers and folders", async () => {
    const root = await project(["1000-other", "9999-last", "10001-export"]);
    const home = await temp("studio-home-");
    const source = { threadId: "t", branch: null, home };
    expect(await resolveReportIncrement(root, { ...source, title: "Review 10001" })).toBe(
      "10001-export",
    );
    expect(
      await resolveReportIncrement(root, {
        ...source,
        title: "Review",
        branch: "inc/10001-export-fix",
      }),
    ).toBe("10001-export");
    expect(await resolveReportIncrement(root, { ...source, title: "Ship 9999" })).toBe("9999-last");
  });

  it("never maps a five-digit folder onto a four-digit one sharing its first digits", async () => {
    const root = await project(["1000-other"]);
    const home = await temp("studio-home-");
    expect(
      await resolveReportIncrement(root, {
        threadId: "t",
        title: "Review",
        branch: "inc/10001-missing",
        home,
      }),
    ).toBeNull();
  });

  it("uses a five-digit increment number SpecWeave recorded for the thread", async () => {
    const root = await project(["10001-export", "10002-import"]);
    const home = await temp("studio-home-");
    const pointer = specweaveStudioCheckpointPath("thread-5", home);
    await NodeFSP.mkdir(NodePath.dirname(pointer), { recursive: true });
    await NodeFSP.writeFile(pointer, JSON.stringify({ version: 1, incrementId: "10002" }));
    expect(
      await resolveReportIncrement(root, { threadId: "thread-5", title: "x", branch: null, home }),
    ).toBe("10002-import");
  });
});

describe("saveThreadReport", () => {
  it("saves into the increment's reports folder once, with front matter", async () => {
    const root = await project(["0973-budget-vs-actuals"]);
    const home = await temp("studio-home-");
    const source = { threadId: "thread-1", title: "Review cycle 2 of 0973", branch: null, home };
    const now = new Date("2026-10-12T07:30:00.000Z");

    const first = await saveThreadReport(root, source, REPORT, now);
    expect(first.increment).toEqual({
      id: "0973-budget-vs-actuals",
      path: ".specweave/increments/0973-budget-vs-actuals",
    });
    expect(first.reports).toHaveLength(1);
    const saved = first.reports[0]!;
    expect(saved.key).toBe(reportKey("thread-1", REPORT));
    expect(saved.path).toMatch(
      /^\.specweave\/increments\/0973-budget-vs-actuals\/reports\/2026-10-12-review-cycle-2-[0-9a-f]{6}-[0-9a-f]{6}\.md$/,
    );
    const content = await NodeFSP.readFile(NodePath.join(root, saved.path), "utf8");
    expect(content).toContain('increment: "0973-budget-vs-actuals"');
    expect(content).toContain('thread: "thread-1"');
    expect(content.trimEnd().endsWith("- finding 14")).toBe(true);

    const again = await saveThreadReport(root, source, `${REPORT}\r\n`, now);
    expect(again.reports).toEqual(first.reports);
  });

  it("files reports with no increment under reports/threads", async () => {
    const root = await project();
    const home = await temp("studio-home-");
    const result = await saveThreadReport(
      root,
      { threadId: "t2", title: "Audit", branch: null, home },
      REPORT,
    );
    expect(result.increment).toBeNull();
    expect(result.folder).toBe(".specweave/reports/threads");
    expect(result.reports[0]!.path.startsWith(".specweave/reports/threads/")).toBe(true);
  });

  it("refuses a project without .specweave", async () => {
    const root = await temp("studio-plain-");
    await expect(
      saveThreadReport(root, { threadId: "t", title: "x", branch: null }, REPORT),
    ).rejects.toMatchObject({ code: "not_specweave" });
    expect(await readThreadReports(root, { threadId: "t", title: "x", branch: null })).toEqual({
      workspaceRoot: NodePath.resolve(root),
      specweave: false,
      increment: null,
      folder: null,
      reports: [],
    });
  });

  it("refuses a .specweave symlink", async () => {
    const outside = await project();
    const root = await temp("studio-link-");
    await NodeFSP.symlink(NodePath.join(outside, ".specweave"), NodePath.join(root, ".specweave"));
    await expect(
      saveThreadReport(root, { threadId: "t", title: "x", branch: null }, REPORT),
    ).rejects.toMatchObject({ code: "not_specweave" });
  });

  it("finds a thread's reports wherever they were saved, and only that thread's", async () => {
    const root = await project(["0973-budget"]);
    const home = await temp("studio-home-");
    await saveThreadReport(root, { threadId: "a", title: "Fix 0973", branch: null, home }, REPORT);
    await saveThreadReport(root, { threadId: "b", title: "Other", branch: null, home }, REPORT);
    const a = await readThreadReports(root, {
      threadId: "a",
      title: "Renamed",
      branch: null,
      home,
    });
    expect(a.increment?.id).toBe("0973-budget");
    expect(a.reports.map((report) => report.key)).toEqual([reportKey("a", REPORT)]);
  });

  it("saves a person's report where the card said, not where its text points", async () => {
    const root = await project(["0973-budget"]);
    const home = await temp("studio-home-");
    const source = { threadId: "t3", title: "Fix export", branch: null, home };
    const text = `${REPORT}\n\nSee .specweave/increments/0973-budget/spec.md.`;
    expect((await readThreadReports(root, source)).folder).toBe(".specweave/reports/threads");
    const manual = await saveThreadReport(root, source, text);
    expect(manual.reports[0]!.path.startsWith(".specweave/reports/threads/")).toBe(true);
    // Filing a finished worker's report on its own may follow the text.
    const auto = await saveThreadReport(root, { ...source, threadId: "t4" }, text, undefined, {
      resolveFromText: true,
    });
    expect(auto.increment?.id).toBe("0973-budget");
  });

  it("creates nothing outside the project through a symlinked reports folder", async () => {
    const root = await project();
    const outside = await temp("studio-outside-");
    await NodeFSP.symlink(outside, NodePath.join(root, ".specweave/reports"));
    await expect(
      saveThreadReport(root, { threadId: "t", title: "x", branch: null }, REPORT),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("ignores a file whose key prefix matches but whose front matter names another thread", async () => {
    const root = await project(["0973-budget"]);
    const home = await temp("studio-home-");
    const a = { threadId: "a", title: "Fix 0973", branch: null, home };
    const saved = await saveThreadReport(root, a, REPORT);
    const path = NodePath.join(root, saved.reports[0]!.path);
    await NodeFSP.writeFile(
      path,
      (await NodeFSP.readFile(path, "utf8")).replace('thread: "a"', 'thread: "someone-else"'),
    );
    expect((await readThreadReports(root, a)).reports).toEqual([]);
  });

  it("finds a report saved in a five-digit increment among many others", async () => {
    const folders = Array.from({ length: 60 }, (_, index) => `${9970 + index}-work-${index}`);
    const root = await project(folders);
    const home = await temp("studio-home-");
    // Another thread's report in an old increment is never returned.
    await saveThreadReport(
      root,
      { threadId: "other", title: "Fix 9971", branch: null, home },
      REPORT,
    );
    const source = { threadId: "five", title: "Fix 10025", branch: null, home };
    const saved = await saveThreadReport(root, source, REPORT);
    expect(saved.increment?.id).toBe("10025-work-55");
    const read = await readThreadReports(root, { ...source, title: "Renamed" });
    expect(read.increment?.id).toBe("10025-work-55");
    expect(read.reports.map((report) => report.key)).toEqual([reportKey("five", REPORT)]);
    expect(read.reports[0]!.path.startsWith(".specweave/increments/10025-work-55/reports/")).toBe(
      true,
    );
  });
});
