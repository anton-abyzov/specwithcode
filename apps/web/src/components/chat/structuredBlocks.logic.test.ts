import { describe, expect, it } from "vite-plus/test";

import {
  formatSeconds,
  humanizeKey,
  isoDateTime,
  parseJsonData,
  parseKeyValueBlock,
  parseStatusBlock,
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
