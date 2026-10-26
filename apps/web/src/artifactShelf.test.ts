import { describe, expect, it } from "vite-plus/test";

import {
  canonicalLinkKey,
  folderHint,
  formatShelfTime,
  organizeShelf,
  SHELF_SECTION_LIMIT,
  SHELF_STALE_AFTER_MS,
  searchShelf,
  shelfEntries,
  shelfStateLabel,
  type ShelfFileCheck,
  type ShelfInput,
} from "./artifactShelf";
import type { NativeArtifactReference } from "./nativeArtifacts";
import { isViewableArtifact, nativeArtifact, type ThreadArtifact } from "./threadArtifacts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function link(url: string, name: string, messageId = "m"): ThreadArtifact {
  return { key: url, kind: "link", url, host: new URL(url).hostname, name, messageId };
}

function file(path: string, messageId = "m"): ThreadArtifact {
  const basename = path.split("/").at(-1)!;
  return {
    key: `file:${path}`,
    kind: basename.endsWith(".md") ? "markdown" : basename.endsWith(".png") ? "image" : "file",
    name: basename,
    messageId,
    meta: { filePath: path, basename, workspaceRelativePath: null } as never,
  };
}

// Synthetic only: no real page, account or machine.
const PAGE_URL = "https://claude.ai/artifact/ExampleArtifact0001";
const PAGE_PATH = "/Users/example/work/probe.html";

function native(overrides: Partial<NativeArtifactReference> = {}): ThreadArtifact {
  return nativeArtifact({
    key: `claudeAgent:${overrides.url === undefined ? PAGE_URL : (overrides.url ?? `path:${PAGE_PATH}`)}`,
    provider: "claudeAgent",
    title: "Probe page",
    version: "1700000002-bbbb",
    seq: 2,
    localPath: PAGE_PATH,
    url: PAGE_URL,
    artifactId: "00000000-0000-4000-8000-000000000001",
    audience: "owner",
    itemId: "publish-2",
    publishedAt: NOW,
    source: "structured",
    ...overrides,
  });
}

function checks(entries: Record<string, ShelfFileCheck>): ReadonlyMap<string, ShelfFileCheck> {
  return new Map(Object.entries(entries));
}

function input(artifacts: ThreadArtifact[], overrides: Partial<ShelfInput> = {}): ShelfInput {
  return {
    artifacts,
    mentionedAt: () => NOW - DAY,
    pullRequests: new Map(),
    fileChecks: new Map(),
    pinned: new Set(),
    hidden: new Set(),
    now: NOW,
    ...overrides,
  };
}

describe("canonicalLinkKey", () => {
  it("treats every URL of one pull request as the same thing", () => {
    const keys = [
      "https://github.com/anton-abyzov/specweave/pull/2067",
      "https://github.com/anton-abyzov/specweave/pull/2067/files",
      "https://github.com/Anton-Abyzov/specweave/pull/2067#issuecomment-1",
    ].map(canonicalLinkKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("ignores www, a trailing slash, the fragment, tracking parameters and the scheme", () => {
    expect(canonicalLinkKey("https://www.gittrend.io/repo/?utm_source=x#top")).toBe(
      canonicalLinkKey("http://gittrend.io/repo"),
    );
    expect(canonicalLinkKey("https://example.com/a?page=2")).not.toBe(
      canonicalLinkKey("https://example.com/a?page=3"),
    );
  });
});

describe("shelfEntries", () => {
  it("lists each thing once, newest mention first", () => {
    const entries = shelfEntries(
      input([
        link("https://github.com/acme/app/pull/230/files", "pull/230", "new"),
        link("https://github.com/acme/app/pull/230", "pull/230", "old"),
        link("https://status.spec-weave.com/", "status"),
        link("https://status.spec-weave.com", "status"),
      ]),
    );
    expect(entries.map((entry) => entry.label)).toEqual(["app #230", "status"]);
    expect(entries[0]!.artifact.messageId).toBe("new");
  });

  it("names a pull request linked by a subpage like any other link to it", () => {
    const entries = shelfEntries(
      input([
        link("https://github.com/acme/app/pull/1149/files", "1149/files", "new"),
        link("https://github.com/acme/app/pull/1149", "pull/1149", "old"),
        link("https://github.com/acme/app/pull/7/checks", "the checks run"),
      ]),
    );
    expect(entries.map((entry) => entry.label)).toEqual(["app #1149", "the checks run"]);
  });

  it("names a pull request by its tracked title and folds it once merged or closed", () => {
    const merged = "https://github.com/acme/app/pull/1";
    const open = "https://github.com/acme/app/pull/2";
    const entries = shelfEntries(
      input([link(merged, "pull/1"), link(open, "pull/2")], {
        mentionedAt: () => NOW - 30 * DAY,
        pullRequests: new Map([
          [canonicalLinkKey(merged), { state: "merged", title: "Ship pins" }],
          [canonicalLinkKey(open), { state: "open", title: "Organize artifacts" }],
        ]),
      }),
    );
    expect(entries.map((entry) => [entry.label, entry.aged])).toEqual([
      ["Ship pins", "merged"],
      // Open stays current however long ago it was named.
      ["Organize artifacts", null],
    ]);
  });

  it("marks a file the host no longer has as missing, and a quiet one as stale", () => {
    const entries = shelfEntries(
      input([file("/tmp/gone.png"), file("/tmp/old.md", "old"), file("/tmp/new.md", "new")], {
        fileChecks: new Map([["/tmp/gone.png", { state: "missing" }]]),
        mentionedAt: (artifact) =>
          artifact.messageId === "old" ? NOW - SHELF_STALE_AFTER_MS - 1 : NOW,
      }),
    );
    expect(entries.map((entry) => entry.aged)).toEqual(["missing", "stale", null]);
  });
});

describe("organizeShelf", () => {
  it("puts pins first, a section per type, and folds Older and Hidden", () => {
    const entries = shelfEntries(
      input(
        [
          file("/Users/me/notes/STEPS.md"),
          link("https://github.com/acme/app/pull/9", "pull/9"),
          link("https://gittrend.io/x", "Gemini Nexus"),
          file("/tmp/report.html"),
          file("/tmp/hidden.md"),
          file("/tmp/old.md", "old"),
        ],
        {
          pinned: new Set(["link:gittrend.io/x"]),
          hidden: new Set(["file:/tmp/hidden.md"]),
          mentionedAt: (artifact) => (artifact.messageId === "old" ? NOW - 30 * DAY : NOW),
        },
      ),
    );
    const shelf = organizeShelf(entries, { query: "", expanded: new Set() });
    expect(
      shelf.sections.map((section) => [section.id, section.total, section.entries.length]),
    ).toEqual([
      ["pinned", 1, 1],
      ["pullRequests", 1, 1],
      ["files", 2, 2],
      ["older", 1, 0],
      ["hidden", 1, 0],
    ]);
    expect(shelf.visibleCount).toBe(5);
    expect(shelf.sections[2]!.entries[0]!.detail).toBe("me/notes");
  });

  it("shows the newest few per section until the section is opened", () => {
    const many = Array.from({ length: 40 }, (_, index) => file(`/tmp/f/${index}.md`));
    const entries = shelfEntries(input(many));
    const closed = organizeShelf(entries, { query: "", expanded: new Set() });
    expect(closed.sections[0]!.entries).toHaveLength(SHELF_SECTION_LIMIT);
    expect(closed.sections[0]!.total).toBe(40);
    const open = organizeShelf(entries, { query: "", expanded: new Set(["files"]) });
    expect(open.sections[0]!.entries).toHaveLength(40);
  });

  it("searches everything, hidden and older included, as one ranked list", () => {
    const entries = shelfEntries(
      input(
        [
          file("/tmp/competitors-2026-10-15.md"),
          link("https://chromeunboxed.com/a", "Chrome Unboxed"),
          file("/tmp/chrome-connection-paths.md"),
          file("/tmp/hidden-chrome.md"),
        ],
        { hidden: new Set(["file:/tmp/hidden-chrome.md"]) },
      ),
    );
    const shelf = organizeShelf(entries, { query: "chrome", expanded: new Set() });
    expect(shelf.sections).toHaveLength(1);
    expect(shelf.sections[0]!.entries.map((entry) => entry.label)).toEqual([
      "Chrome Unboxed",
      "chrome-connection-paths.md",
      "hidden-chrome.md",
    ]);
    expect(searchShelf(entries, "pull requests")).toHaveLength(0);
    expect(searchShelf(entries, "links chrome").map((entry) => entry.label)).toEqual([
      "Chrome Unboxed",
    ]);
  });
});

describe("native artifacts", () => {
  it("lists a published page in Reports by its title, version and folder, never in the viewer", () => {
    const [entry] = shelfEntries(input([native()]));
    expect(entry).toMatchObject({
      category: "reports",
      label: "Probe page",
      kindLabel: "Artifact",
      detail: "Version 2 · work",
      fullPath: PAGE_PATH,
      fileState: "unknown",
      aged: null,
    });
    expect(isViewableArtifact(entry!.artifact)).toBe(false);
  });

  it("folds the reply's own link to the page into the entry, so a pin made on either holds", () => {
    const entries = shelfEntries(
      input([native(), link(`${PAGE_URL}/`, "the page")], {
        pinned: new Set([canonicalLinkKey(PAGE_URL)]),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "Probe page", pinned: true });
  });

  it("reads remote-only when its source left the disk, and stays in Reports", () => {
    const entries = shelfEntries(
      input([native()], { fileChecks: checks({ [PAGE_PATH]: { state: "missing" } }) }),
    );
    expect(entries[0]).toMatchObject({ fileState: "remote-only", aged: null });
    expect(shelfStateLabel(entries[0]!)).toBe("Remote only");
    const shelf = organizeShelf(entries, { query: "", expanded: new Set() });
    expect(shelf.sections.map((section) => section.id)).toEqual(["reports"]);
  });

  it("reads missing, not remote-only, for a page that kept no link", () => {
    const [entry] = shelfEntries(
      input([native({ url: null })], { fileChecks: checks({ [PAGE_PATH]: { state: "missing" } }) }),
    );
    expect(entry).toMatchObject({ fileState: "missing", aged: "missing" });
    expect(entry!.id).not.toBe(canonicalLinkKey(PAGE_URL));
  });

  it("is found by its link, its path and the word artifact", () => {
    const entries = shelfEntries(input([native(), file("/tmp/notes.md")]));
    for (const query of ["ExampleArtifact0001", "work/probe", "artifact", "claude.ai"]) {
      expect(
        searchShelf(entries, query).map((entry) => entry.label),
        query,
      ).toEqual(["Probe page"]);
    }
  });
});

describe("file states", () => {
  it("folds only a missing file into Older: an offline machine or an open check leaves it in place", () => {
    const entries = shelfEntries(
      input(
        [
          file("/tmp/a/present.md"),
          file("/tmp/a/missing.md"),
          file("/tmp/a/offline.md"),
          file("/tmp/a/checking.md"),
          file("/tmp/a/unchecked.md"),
          file("/tmp/a/pinned-missing.md"),
        ],
        {
          mentionedAt: () => NOW,
          pinned: new Set(["file:/tmp/a/pinned-missing.md"]),
          fileChecks: checks({
            "/tmp/a/present.md": { state: "present" },
            "/tmp/a/missing.md": { state: "missing" },
            "/tmp/a/offline.md": { state: "unreachable", reason: "Example Mac is offline" },
            "/tmp/a/checking.md": { state: "unknown", checking: true },
            "/tmp/a/pinned-missing.md": { state: "missing" },
          }),
        },
      ),
    );
    expect(
      entries.map((entry) => [entry.label, entry.fileState, shelfStateLabel(entry), entry.aged]),
    ).toEqual([
      ["present.md", "present", null, null],
      ["missing.md", "missing", "Missing", "missing"],
      ["offline.md", "unreachable", "Unreachable", null],
      ["checking.md", "unknown", "Checking", null],
      ["unchecked.md", "unknown", "Not checked", null],
      ["pinned-missing.md", "missing", "Missing", "missing"],
    ]);
    expect(entries[2]!.stateReason).toBe("Example Mac is offline");
    const shelf = organizeShelf(entries, { query: "", expanded: new Set(["older"]) });
    expect(
      shelf.sections.map((section) => [section.id, section.entries.map((entry) => entry.label)]),
    ).toEqual([
      ["pinned", ["pinned-missing.md"]],
      ["files", ["present.md", "offline.md", "checking.md", "unchecked.md"]],
      ["older", ["missing.md"]],
    ]);
  });

  it("gives links and attachments no file state", () => {
    const [entry] = shelfEntries(input([link("https://example.com/a", "A")]));
    expect(entry!.fileState).toBeNull();
    expect(shelfStateLabel(entry!)).toBeNull();
  });

  it("finds a file by its full path, its kind and its state", () => {
    const entries = shelfEntries(
      input([file("/Users/example/specweave-umb/increments/1041-fix/reports/findings.md")], {
        fileChecks: checks({
          "/Users/example/specweave-umb/increments/1041-fix/reports/findings.md": {
            state: "unreachable",
          },
        }),
      }),
    );
    for (const query of ["1041-fix/reports", "document", "unreachable"]) {
      expect(searchShelf(entries, query), query).toHaveLength(1);
    }
  });
});

describe("folderHint", () => {
  it("keeps the last folder whole and reads inside the workspace from its name", () => {
    expect(
      folderHint(
        "/Users/example/specweave-umb/.specweave/increments/1041-fix-design-workspace/reports/findings.md",
      ),
    ).toEqual({
      head: "~/specweave-umb/.specweave/increments/1041-fix-design-workspace/",
      tail: "reports",
      full: "/Users/example/specweave-umb/.specweave/increments/1041-fix-design-workspace/reports",
    });
    expect(folderHint("/Users/example/repo/apps/web/a.ts", "/Users/example/repo/")).toEqual({
      head: "repo/apps/",
      tail: "web",
      full: "/Users/example/repo/apps/web",
    });
    expect(folderHint("/Users/example/repo/a.ts", "/Users/example/repo")).toEqual({
      head: "",
      tail: "repo",
      full: "/Users/example/repo",
    });
  });

  it("reads Windows paths and has nothing to say for a bare name or a root file", () => {
    expect(folderHint("C:\\Users\\example\\notes\\a.md")).toEqual({
      head: "C:\\Users\\example\\",
      tail: "notes",
      full: "C:\\Users\\example\\notes",
    });
    expect(folderHint("a.md")).toBeNull();
    expect(folderHint("/a.md")).toBeNull();
    expect(folderHint("/tmp/a.md")).toEqual({ head: "/", tail: "tmp", full: "/tmp" });
  });
});

describe("row text", () => {
  it("dates a row by the time today, the day this year and the full date before", () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime();
    expect(formatShelfTime(new Date(2026, 9, 24, 9, 5).getTime(), now, "en-US")).toBe("9:05 AM");
    expect(formatShelfTime(new Date(2026, 9, 2, 9, 5).getTime(), now, "en-US")).toBe("Oct 2");
    expect(formatShelfTime(new Date(2025, 9, 24, 9, 5).getTime(), now, "en-US")).toBe(
      "Oct 24, 2025",
    );
  });
});
