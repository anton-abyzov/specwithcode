import { describe, expect, it } from "vite-plus/test";

import {
  formatSeconds,
  humanizeKey,
  isoDateTime,
  parseJsonData,
  parseKeyValueBlock,
  parseStatusBlock,
  pathBreakSegments,
  tableColumns,
} from "./structuredBlocks.logic";

describe("parseJsonData", () => {
  it("reads objects and arrays, not scalars or broken JSON", () => {
    expect(parseJsonData('{"queue": {"pending": 1}}')).toEqual({ queue: { pending: 1 } });
    expect(parseJsonData("[1, 2]")).toEqual([1, 2]);
    expect(parseJsonData("42")).toBeNull();
    expect(parseJsonData('{"a": ')).toBeNull();
    expect(parseJsonData("{}")).toBeNull();
    expect(parseJsonData('{"id": 12345678901234567890}')).toBeNull();
  });
});

describe("tableColumns", () => {
  it("lists columns for records of scalars", () => {
    expect(
      tableColumns([
        { id: 1, name: "a" },
        { id: 2, state: "ok" },
      ]),
    ).toEqual(["id", "name", "state"]);
  });
  it("refuses nested records and plain lists", () => {
    expect(tableColumns([{ id: 1, nested: { a: 1 } }])).toBeNull();
    expect(tableColumns([1, 2])).toBeNull();
  });
});

describe("value formatting", () => {
  it("turns keys into words", () => {
    expect(humanizeKey("oldest_due_age_seconds")).toBe("Oldest due age seconds");
    expect(humanizeKey("lastClaimAt")).toBe("Last claim at");
  });
  it("formats seconds and ISO times", () => {
    expect(formatSeconds(1534)).toBe("25m 34s");
    expect(formatSeconds(7_260)).toBe("2h 1m");
    expect(isoDateTime("2026-10-21T08:22:41.586Z")?.toISOString()).toBe("2026-10-21T08:22:41.586Z");
    expect(isoDateTime("2026-10-21")).toBeNull();
  });
});

describe("parseStatusBlock", () => {
  it("reads a title and states with details", () => {
    expect(
      parseStatusBlock(
        "title: Nightly\nok: Build | 2m\n- warn: Disk at 82%\nfail: Deploy — waiting",
      ),
    ).toEqual({
      title: "Nightly",
      items: [
        { state: "ok", label: "Build", detail: "2m" },
        { state: "warn", label: "Disk at 82%", detail: null },
        { state: "fail", label: "Deploy", detail: "waiting" },
      ],
    });
  });
  it("gives up on lines it does not know", () => {
    expect(parseStatusBlock("ok: Build\nthis is prose")).toBeNull();
    expect(parseStatusBlock("maybe: Build")).toBeNull();
    expect(parseStatusBlock("title: Only a title")).toBeNull();
  });
});

describe("parseKeyValueBlock", () => {
  it("groups entries under headings", () => {
    expect(
      parseKeyValueBlock("# Queue\nPending: 1\nEscalated: 2\n# Worker\nLast claim: 08:22"),
    ).toEqual([
      {
        heading: "Queue",
        entries: [
          { key: "Pending", value: "1" },
          { key: "Escalated", value: "2" },
        ],
      },
      { heading: "Worker", entries: [{ key: "Last claim", value: "08:22" }] },
    ]);
  });
  it("gives up on prose", () => {
    expect(parseKeyValueBlock("Pending: 1\nnot a pair")).toBeNull();
  });
});

describe("pathBreakSegments", () => {
  const segments = (text: string) => {
    const result = pathBreakSegments(text);
    expect(result.join("")).toBe(text);
    return result;
  };

  it("breaks a path after each slash and after separators inside names", () => {
    expect(
      segments("/Users/example/Projects/specweave-umb/.specweave/increments/1049-files/spec.md"),
    ).toEqual([
      "/Users/",
      "example/",
      "Projects/",
      "specweave-",
      "umb/",
      ".specweave/",
      "increments/",
      "1049-",
      "files/",
      "spec.",
      "md",
    ]);
  });

  it("keeps a URL's scheme and a drive letter whole", () => {
    const url = segments("https://claude.ai/artifact/ExampleArtifact0001");
    expect(url).toEqual(["https://", "claude.", "ai/", "artifact/", "ExampleArtifact0001"]);
    expect(url.some((segment) => segment.endsWith(":"))).toBe(false);
    expect(segments("C:\\Users\\example\\notes.md")).toEqual([
      "C:\\",
      "Users\\",
      "example\\",
      "notes.",
      "md",
    ]);
  });

  it("breaks identifiers next to a letter only", () => {
    expect(segments("env:host-1")).toEqual(["env:", "host-", "1"]);
    expect(segments("snake_case_id")).toEqual(["snake_", "case_", "id"]);
    expect(segments("build-2026-10-24")).toEqual(["build-", "2026-10-24"]);
    expect(segments("-flag")).toEqual(["-flag"]);
    expect(segments("a--b")).toEqual(["a--b"]);
    expect(segments("end.")).toEqual(["end."]);
  });

  it("keeps numbers, dates, times and addresses whole", () => {
    for (const text of ["0.75", "v1.2", "2026-10-24", "08:11:52", "192.168.0.1", "1_000_000"]) {
      expect(segments(text)).toEqual([text]);
    }
  });

  it("never leaves a slash alone at a line end or splits a slash run", () => {
    expect(segments("/tmp")).toEqual(["/tmp"]);
    expect(segments("//server/share")).toEqual(["//server/", "share"]);
    expect(segments("see /tmp/example")).toEqual(["see /tmp/", "example"]);
    expect(segments("a// b")).toEqual(["a// b"]);
    expect(segments("dir/")).toEqual(["dir/"]);
  });

  it("leaves plain text and empty text as one segment", () => {
    expect(segments("")).toEqual([""]);
    expect(segments("Done in 2m 10s")).toEqual(["Done in 2m 10s"]);
  });

  it("keeps graphemes whole", () => {
    expect(segments("👩‍💻/notes")).toEqual(["👩‍💻/", "notes"]);
    expect(segments("a/\u0301b")).toEqual(["a/\u0301b"]);
    expect(segments("a/\u{1F3FD}")).toEqual(["a/\u{1F3FD}"]);
    expect(segments("𝐀-b")).toEqual(["𝐀-", "b"]);
  });

  it("gives up on very long text or too many breaks", () => {
    expect(segments("a/".repeat(3000))).toHaveLength(1);
    expect(segments("a/".repeat(513))).toHaveLength(513);
    expect(segments("a/".repeat(514))).toHaveLength(1);
  });
});
