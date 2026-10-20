import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  collectProjectPullRequests,
  formatLibraryDate,
  formatLibrarySize,
  libraryBaseName,
  libraryFileType,
  libraryKindLabel,
  libraryMatchesType,
  openPullRequestCount,
  pullRequestGroup,
} from "./projectPaneModel";

type ThreadOverrides = Omit<Partial<EnvironmentThreadShell>, "id"> & { id?: string };
function thread(overrides: ThreadOverrides = {}): EnvironmentThreadShell {
  return {
    id: "worker-1",
    environmentId: "host-1",
    projectId: "project-1",
    title: "Worker",
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    ...overrides,
  } as EnvironmentThreadShell;
}

type Link = NonNullable<EnvironmentThreadShell["pullRequests"]>[number];
function link(number: number, overrides: Record<string, unknown> = {}): Link {
  return {
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "opened",
    linkedAt: "2026-10-09T10:00:00Z",
    snapshot: {
      title: `Change ${number}`,
      state: "open",
      isDraft: false,
      updatedAt: "2026-10-09T10:00:00Z",
    },
    ...overrides,
  } as unknown as Link;
}

describe("library files", () => {
  it("sorts files into the Type filter's buckets", () => {
    expect(libraryFileType("notes/plan.md")).toBe("documents");
    expect(libraryFileType("shot.PNG")).toBe("images");
    expect(libraryFileType("ledger.jsonl")).toBe("data");
    expect(libraryFileType("src/app.tsx")).toBe("code");
    expect(libraryFileType("Makefile")).toBe("documents");
    expect(libraryFileType(".gitignore")).toBe("documents");
  });

  it("names the Kind column as a file manager does", () => {
    expect(libraryKindLabel({ kind: "directory", name: "reports" })).toBe("Folder");
    expect(libraryKindLabel({ kind: "link", name: "https://x.test" })).toBe("Link");
    expect(libraryKindLabel({ kind: "file", name: "spec.md" })).toBe("Markdown");
    expect(libraryKindLabel({ kind: "file", name: "deck.key" })).toBe("KEY file");
    expect(libraryKindLabel({ kind: "file", name: "LICENSE" })).toBe("File");
  });

  it("keeps folders under every filter and links only under Links", () => {
    expect(libraryMatchesType("images", { kind: "directory", name: "docs" })).toBe(true);
    expect(libraryMatchesType("links", { kind: "link", name: "x" })).toBe(true);
    expect(libraryMatchesType("documents", { kind: "link", name: "x" })).toBe(false);
    expect(libraryMatchesType("code", { kind: "file", name: "a.ts" })).toBe(true);
    expect(libraryMatchesType("code", { kind: "file", name: "a.md" })).toBe(false);
    expect(libraryMatchesType("all", { kind: "file", name: "a.md" })).toBe(true);
  });

  it("formats sizes in decimal units", () => {
    expect(formatLibrarySize(undefined)).toBe("");
    expect(formatLibrarySize(512)).toBe("512 bytes");
    expect(formatLibrarySize(4_200)).toBe("4.2 KB");
    expect(formatLibrarySize(48_000)).toBe("48 KB");
    expect(formatLibrarySize(1_400_000)).toBe("1.4 MB");
  });

  it("shows the time for today and the date otherwise", () => {
    const now = new Date(2026, 9, 10, 15, 0, 0);
    expect(formatLibraryDate(new Date(2026, 9, 10, 9, 5).toISOString(), now)).toMatch(/^Today at /);
    expect(formatLibraryDate(new Date(2026, 8, 2, 9, 5).toISOString(), now)).not.toMatch(
      /Today|2026/,
    );
    expect(formatLibraryDate(new Date(2025, 8, 2, 9, 5).toISOString(), now)).toMatch(/2025/);
    expect(formatLibraryDate("not a date", now)).toBe("");
    expect(formatLibraryDate(undefined, now)).toBe("");
  });

  it("takes the last path segment as the name", () => {
    expect(libraryBaseName(".specweave/reports/")).toBe("reports");
    expect(libraryBaseName("plan.md")).toBe("plan.md");
  });
});

describe("project pull requests", () => {
  it("lists each pull request once, under the thread that linked it last", () => {
    const first = thread({
      id: "a",
      title: "First",
      pullRequests: [link(7, { linkedAt: "2026-10-08T00:00:00Z" })],
    });
    const second = thread({
      id: "b",
      title: "Second",
      pullRequests: [link(7, { linkedAt: "2026-10-09T00:00:00Z" })],
    });
    const prs = collectProjectPullRequests([first, second]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 7, threadTitle: "Second", state: "open" });
  });

  it("skips deleted threads and dismissed links, and sorts newest first", () => {
    const prs = collectProjectPullRequests([
      thread({
        pullRequests: [
          link(1, {
            snapshot: { title: "Old", state: "merged", updatedAt: "2026-10-01T00:00:00Z" },
          }),
          link(2, {
            snapshot: {
              title: "New",
              state: "open",
              isDraft: true,
              updatedAt: "2026-10-09T12:00:00Z",
            },
          }),
          link(3, { source: "stack-dismissed" }),
        ],
      }),
      thread({ id: "gone", deletedAt: "2026-10-09T00:00:00Z", pullRequests: [link(4)] }),
    ]);
    expect(prs.map((pr) => [pr.number, pr.state])).toEqual([
      [2, "draft"],
      [1, "merged"],
    ]);
    expect(openPullRequestCount(prs)).toBe(1);
  });

  it("falls back to the repository and number when there is no snapshot", () => {
    const [pr] = collectProjectPullRequests([
      thread({ title: "", pullRequests: [link(9, { snapshot: null })] }),
    ]);
    expect(pr).toMatchObject({
      title: "acme/app #9",
      state: "open",
      threadTitle: "Untitled thread",
    });
  });

  it("names every machine whose threads link a pull request", () => {
    const labels: Record<string, string> = { m4: "M4", minis: "Minis" };
    const prs = collectProjectPullRequests(
      [
        thread({ id: "a", environmentId: "m4" as never, pullRequests: [link(7), link(8)] }),
        thread({ id: "b", environmentId: "minis" as never, pullRequests: [link(7)] }),
      ],
      (environmentId) => labels[environmentId] ?? environmentId,
    );
    expect(Object.fromEntries(prs.map((pr) => [pr.number, pr.machines]))).toEqual({
      7: ["M4", "Minis"],
      8: ["M4"],
    });
    expect(collectProjectPullRequests([thread({ pullRequests: [link(7)] })])[0]).not.toHaveProperty(
      "machines",
    );
  });

  it("groups drafts with open pull requests", () => {
    expect(pullRequestGroup("draft")).toBe("Open");
    expect(pullRequestGroup("merged")).toBe("Merged");
    expect(pullRequestGroup("closed")).toBe("Closed");
  });
});
