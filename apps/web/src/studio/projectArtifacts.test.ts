import type {
  DesignSummary,
  EnvironmentId,
  ProjectLibrarySnapshot,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ARTIFACT_SORT,
  nextArtifactSort,
  registeredArtifacts,
  sortArtifacts,
  type ArtifactSort,
  artifactAge,
  artifactKindOfFile,
  artifactMatchesType,
  artifactTypesPresent,
  collectProjectArtifacts,
  isShelfDeliverable,
  projectRelativePath,
  searchArtifacts,
  shelfArtifacts,
  type ProjectArtifactsInput,
} from "./projectArtifacts";

const ROOT = "/Users/me/app";
const env = "env-1" as EnvironmentId;
const thread = (id: string, title: string) => ({
  environmentId: env,
  threadId: id as ThreadId,
  title,
});

const library = (patch: Partial<ProjectLibrarySnapshot> = {}): ProjectLibrarySnapshot => ({
  workspaceRoot: ROOT,
  specweave: true,
  hub: null,
  hubProblem: null,
  artifacts: [],
  folders: [],
  outputs: [],
  ...patch,
});

const design = (id: string, updatedAt: string, kind: "design" | "slides" = "design") =>
  ({
    ref: {
      owner: { kind: "project", projectId: "p" },
      designId: id,
      path: `.specweave/design/${id}`,
    },
    kind,
    title: `Design ${id}`,
    revision: 1,
    updatedAt,
    pageCount: 1,
    designSystem: null,
    ownerLabel: "App",
    thread: { environmentId: env, threadId: "t-design" },
  }) as unknown as DesignSummary;

const input = (patch: Partial<ProjectArtifactsInput>): ProjectArtifactsInput => ({
  workspaceRoot: ROOT,
  library: null,
  designs: [],
  threadArtifacts: [],
  pinned: new Set(),
  ...patch,
});

describe("collectProjectArtifacts", () => {
  it("merges every source once, pinned first, then newest", () => {
    const artifacts = collectProjectArtifacts(
      input({
        library: library({
          artifacts: [
            {
              id: "h1",
              title: "Release notes",
              location: ".specweave/reports/notes.md",
              kind: "file",
              intentId: null,
              createdAt: "2026-10-01T00:00:00.000Z",
              modifiedAt: "2026-10-02T00:00:00.000Z",
              byteLength: 40,
              missing: false,
            },
          ],
          outputs: [
            {
              path: ".specweave/reports/notes.md",
              byteLength: 40,
              modifiedAt: "2026-10-20T00:00:00.000Z",
              increment: null,
            },
            {
              path: ".specweave/increments/1148-shelf/reports/light.png",
              byteLength: 900,
              modifiedAt: "2026-10-29T00:00:00.000Z",
              increment: "1148-shelf",
            },
          ],
        }),
        designs: [design("d1", "2026-10-25T00:00:00.000Z", "slides")],
        threadArtifacts: [
          {
            thread: thread("t1", "Screenshot thread"),
            entries: [
              {
                id: "file:/Users/me/app/.specweave/increments/1148-shelf/reports/light.png",
                kind: "image",
                name: "light.png",
                path: `${ROOT}/.specweave/increments/1148-shelf/reports/light.png`,
                at: Date.parse("2026-10-30T00:00:00.000Z"),
              },
              // Source files a thread read are not its artifacts.
              { id: "file:x", kind: "code", name: "a.ts", path: `${ROOT}/src/a.ts`, at: 1 },
              // Nor is a link it mentioned.
              { id: "link:x", kind: "link", name: "Docs", url: "https://example.com/docs" },
              {
                id: "link:claude.ai/artifact/abc",
                kind: "native",
                name: "Launch page",
                url: "https://claude.ai/artifact/abc",
                at: Date.parse("2026-10-10T00:00:00.000Z"),
              },
            ],
          },
        ],
        pinned: new Set(["file:.specweave/reports/notes.md"]),
      }),
    );

    expect(artifacts.map((item) => [item.id, item.kind, item.source])).toEqual([
      ["file:.specweave/reports/notes.md", "document", "registered"],
      ["file:.specweave/increments/1148-shelf/reports/light.png", "image", "output"],
      ["design:d1", "slides", "design"],
      ["link:claude.ai/artifact/abc", "page", "thread"],
    ]);
    const [notes, screenshot] = artifacts;
    // The registered title stays; the output's newer date and size are kept.
    expect(notes).toMatchObject({
      title: "Release notes",
      pinned: true,
      updatedAt: Date.parse("2026-10-20T00:00:00.000Z"),
    });
    // The thread that named the output is credited, with its newer date.
    expect(screenshot).toMatchObject({
      byteLength: 900,
      increment: "1148-shelf",
      thread: { title: "Screenshot thread" },
      updatedAt: Date.parse("2026-10-30T00:00:00.000Z"),
    });
  });

  it("lists nothing for an empty project, and undated artifacts last", () => {
    expect(collectProjectArtifacts(input({}))).toEqual([]);
    const artifacts = collectProjectArtifacts(
      input({
        library: library({
          artifacts: [
            {
              id: "l",
              title: "Spec",
              location: "https://example.com/spec",
              kind: "link",
              intentId: null,
              createdAt: "not a date",
              missing: false,
            },
          ],
        }),
        designs: [design("d2", "2026-01-01T00:00:00.000Z")],
      }),
    );
    expect(artifacts.map((item) => item.title)).toEqual(["Design d2", "Spec"]);
  });
});

describe("merging across checkouts", () => {
  it("joins a worktree thread's file to the project's output, and keeps the hub's missing flag", () => {
    const worktree = "/wt/app/1148-x";
    const artifacts = collectProjectArtifacts(
      input({
        library: library({
          artifacts: [
            {
              id: "gone",
              title: "Old notes",
              location: "notes/old.md",
              kind: "file",
              intentId: null,
              createdAt: "2026-10-01T00:00:00.000Z",
              missing: true,
            },
          ],
          outputs: [
            {
              path: ".specweave/reports/r.html",
              byteLength: 5,
              modifiedAt: "2026-10-20T00:00:00.000Z",
              increment: null,
            },
          ],
        }),
        threadArtifacts: [
          {
            thread: { ...thread("t9", "Worktree thread"), root: worktree },
            entries: [
              {
                id: "a",
                kind: "html",
                name: "r.html",
                path: `${worktree}/.specweave/reports/r.html`,
              },
              { id: "b", kind: "markdown", name: "old.md", path: `${ROOT}/notes/old.md` },
              { id: "c", kind: "image", name: "wip.png", path: `${worktree}/out/wip.png:3` },
            ],
          },
        ],
      }),
    );
    const byId = new Map(artifacts.map((item) => [item.id, item]));
    expect(byId.get("file:.specweave/reports/r.html")).toMatchObject({
      path: ".specweave/reports/r.html",
      thread: { title: "Worktree thread" },
    });
    expect(byId.get("file:notes/old.md")?.missing).toBe(true);
    // Not in the project yet: its own artifact, opened from the thread's worktree.
    expect(byId.get("file:t9:out/wip.png")).toMatchObject({ path: "out/wip.png", root: worktree });
    expect(byId.get("file:.specweave/reports/r.html")?.root).toBeNull();
    expect(artifacts).toHaveLength(3);
  });

  it("keeps two threads' unlanded files apart, and reads a worktree inside the project from it", () => {
    const nested = `${ROOT}/.specwithcode/worktrees/1150-b`;
    const artifacts = collectProjectArtifacts(
      input({
        threadArtifacts: [
          {
            thread: { ...thread("ta", "A"), root: "/wt/app/1150-a" },
            entries: [{ id: "a", kind: "html", name: "s.html", path: "/wt/app/1150-a/s.html" }],
          },
          {
            thread: { ...thread("tb", "B"), root: nested },
            entries: [{ id: "b", kind: "html", name: "s.html", path: `${nested}/s.html` }],
          },
        ],
      }),
    );
    expect(artifacts.map((item) => [item.id, item.path, item.root, item.thread?.title])).toEqual(
      expect.arrayContaining([
        ["file:ta:s.html", "s.html", "/wt/app/1150-a", "A"],
        ["file:tb:s.html", "s.html", nested, "B"],
      ]),
    );
    expect(artifacts).toHaveLength(2);
  });
});

describe("artifact types", () => {
  it("reads a file's kind from its name", () => {
    expect(artifactKindOfFile("a/report.html")).toBe("page");
    expect(artifactKindOfFile("a/shot.PNG")).toBe("image");
    expect(artifactKindOfFile("a/run.mp4")).toBe("video");
    expect(artifactKindOfFile("deck.pptx")).toBe("slides");
    expect(artifactKindOfFile("data.json")).toBe("data");
    expect(artifactKindOfFile("notes.md")).toBe("document");
  });

  it("filters and searches", () => {
    const artifacts = collectProjectArtifacts(
      input({
        designs: [design("d3", "2026-10-01T00:00:00.000Z")],
      }),
    );
    expect(artifacts.filter((item) => artifactMatchesType("designs", item))).toHaveLength(1);
    expect([...artifactTypesPresent(artifacts)].toSorted()).toEqual(["all", "designs"]);
    expect(searchArtifacts(artifacts, "nothing like it")).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("reads paths from the project root", () => {
    expect(projectRelativePath(`${ROOT}/docs/a.md`, `${ROOT}/`)).toBe("docs/a.md");
    expect(projectRelativePath("./docs/a.md", ROOT)).toBe("docs/a.md");
    expect(projectRelativePath("/tmp/out.png", ROOT)).toBe("/tmp/out.png");
    expect(projectRelativePath("C:\\app\\r\\a.md", "C:\\app")).toBe("r/a.md");
    expect(projectRelativePath("c:\\App\\r\\a.md", "C:\\app")).toBe("r/a.md");
    expect(projectRelativePath("/wt/x/a.md", ROOT, ["/wt/x"])).toBe("a.md");
  });

  it("words an age as the Threads list does", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(artifactAge(null, now)).toBe("");
    expect(artifactAge(now - 20_000, now)).toBe("now");
    expect(artifactAge(now - 5 * 60_000, now)).toBe("5m");
    expect(artifactAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(artifactAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(artifactAge(now - 14 * 86_400_000, now)).toBe("2w");
  });

  it("never lists a pull request, whichever source names it", () => {
    const url = "https://github.com/me/app/pull/7";
    const artifacts = collectProjectArtifacts(
      input({
        library: library({
          artifacts: [
            {
              id: "h1",
              title: "The PR",
              location: url,
              kind: "link",
              intentId: null,
              createdAt: "2026-10-28T00:00:00.000Z",
              missing: false,
            },
          ],
        }),
        threadArtifacts: [
          {
            thread: thread("t1", "Thread"),
            entries: [
              { id: "pr:github.com/me/app#7", kind: "link", name: "#7", url },
              { id: "native:x", kind: "native", name: "#7", url },
            ],
          },
        ],
      }),
    );
    expect(artifacts).toEqual([]);
  });

  it("keeps pull requests out of the hub's registered list", () => {
    const entry = (kind: string, location: string) => ({ kind, location });
    expect(
      registeredArtifacts([
        entry("link", "https://github.com/me/app/pull/7"),
        entry("link", "https://example.com/docs"),
        entry("file", "pull/7"),
      ]).map((item) => item.location),
    ).toEqual(["https://example.com/docs", "pull/7"]);
  });

  it("sorts by a column, with pinned first and missing values last", () => {
    const at = (day: number) => `2026-10-${day}T00:00:00.000Z`;
    const artifacts = collectProjectArtifacts(
      input({
        library: library({
          outputs: [
            { path: "b.md", byteLength: 30, modifiedAt: at(10), increment: null },
            { path: "a10.md", byteLength: 10, modifiedAt: at(12), increment: null },
            { path: "a2.md", byteLength: 20, modifiedAt: at(11), increment: null },
          ],
        }),
        pinned: new Set(["file:b.md"]),
      }),
    );
    const titles = (sort: ArtifactSort) => sortArtifacts(artifacts, sort).map((a) => a.title);
    expect(titles({ column: "name", descending: false })).toEqual(["b.md", "a2.md", "a10.md"]);
    expect(titles({ column: "size", descending: true })).toEqual(["b.md", "a2.md", "a10.md"]);
    expect(titles(DEFAULT_ARTIFACT_SORT)).toEqual(["b.md", "a10.md", "a2.md"]);
    expect(nextArtifactSort(DEFAULT_ARTIFACT_SORT, "modified").descending).toBe(false);
    expect(nextArtifactSort(DEFAULT_ARTIFACT_SORT, "name").descending).toBe(false);
  });
});

describe("shelfArtifacts", () => {
  const output = (path: string, at = "2026-11-08T20:00:00.000Z") => ({
    path,
    byteLength: 10,
    modifiedAt: at,
    increment: ".specweave/increments/0007-bot",
  });
  const collect = (pinned: ReadonlySet<string> = new Set()) =>
    collectProjectArtifacts(
      input({
        pinned,
        library: library({
          artifacts: [
            {
              id: "h1",
              title: "Backtest results",
              location: ".specweave/reports/results.json",
              kind: "file",
              intentId: null,
              createdAt: "2026-11-08T19:00:00.000Z",
              modifiedAt: "2026-11-08T19:00:00.000Z",
              byteLength: 40,
              missing: false,
            },
          ],
          outputs: [
            output(".specweave/increments/0007-bot/reports/task-T-04.txt"),
            output(".specweave/increments/0007-bot/reports/build.log"),
            output(".specweave/increments/0007-bot/reports/metrics.json"),
            output(".specweave/increments/0007-bot/reports/run.py"),
            output(".specweave/increments/0007-bot/reports/summary.md"),
            output(".specweave/increments/0007-bot/reports/report.html"),
            output(".specweave/increments/0007-bot/reports/equity.png"),
            output(".specweave/increments/0007-bot/reports/demo.mp4"),
            output(".specweave/increments/0007-bot/reports/findings.pdf"),
          ],
        }),
      }),
    );
  const titles = (pinned?: ReadonlySet<string>) =>
    shelfArtifacts(collect(pinned)).map((artifact) => artifact.title);

  it("shows deliverables and leaves task logs, code and unregistered data off the shelf", () => {
    expect(titles().toSorted()).toEqual(
      [
        "Backtest results",
        "demo.mp4",
        "equity.png",
        "findings.pdf",
        "report.html",
        "summary.md",
      ].toSorted(),
    );
  });

  it("keeps every log in the full list the Library shows", () => {
    expect(collect().map((artifact) => artifact.title)).toEqual(
      expect.arrayContaining(["task-T-04.txt", "build.log", "metrics.json", "run.py"]),
    );
  });

  it("puts a pinned log back on the shelf", () => {
    const pinned = new Set(["file:.specweave/increments/0007-bot/reports/task-T-04.txt"]);
    expect(titles(pinned)[0]).toBe("task-T-04.txt");
  });

  it("judges a published link and a design by kind, never by path", () => {
    expect(
      isShelfDeliverable({
        ...collect()[0]!,
        kind: "link",
        path: null,
        source: "thread",
        pinned: false,
      }),
    ).toBe(true);
  });
});
