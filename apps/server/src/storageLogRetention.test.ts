import { describe, expect, it } from "vitest";

import { removableLogFile } from "./storageLogRetention.ts";

describe("removableLogFile", () => {
  it("lets rotated files go wherever they are", () => {
    expect(removableLogFile("server.trace.ndjson.3")).toBe(true);
    expect(removableLogFile("server-child.log.1")).toBe(true);
    expect(removableLogFile("provider/events.log.2")).toBe(true);
  });

  it("lets the log of one terminal or one agent session go", () => {
    expect(removableLogFile("terminals/terminal_abc_def.log")).toBe(true);
    expect(removableLogFile("provider/session-123.log")).toBe(true);
  });

  it("keeps the live logs the app holds open", () => {
    expect(removableLogFile("server.trace.ndjson")).toBe(false);
    expect(removableLogFile("desktop.trace.ndjson")).toBe(false);
    expect(removableLogFile("server-child.log")).toBe(false);
    expect(removableLogFile("renderer-history.ndjson")).toBe(false);
    expect(removableLogFile("provider/events.log")).toBe(false);
  });

  it("keeps anything it does not know", () => {
    expect(removableLogFile("terminals/notes.txt")).toBe(false);
    expect(removableLogFile("terminals/deep/terminal.log")).toBe(false);
    expect(removableLogFile("other/session.log")).toBe(false);
    expect(removableLogFile("provider/session.ndjson")).toBe(false);
  });
});
