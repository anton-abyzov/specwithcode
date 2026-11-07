// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway database for the export to read.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  changedSettingPaths,
  teamRulesActorOfSession,
  teamRulesRecordLines,
  writeTeamRulesRecordsFile,
} from "./TeamRulesRecords.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync), closeSync: vi.fn(actual.closeSync) };
});

const roots: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function database(setup: (db: NodeSqlite.DatabaseSync) => void) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "team-rules-records-"));
  roots.push(root);
  const path = NodePath.join(root, "fixture.sqlite");
  const db = new NodeSqlite.DatabaseSync(path);
  setup(db);
  db.close();
  return { root, path };
}

const SCHEMA = `
  CREATE TABLE orchestration_v2_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, command_id TEXT, thread_id TEXT NOT NULL,
    run_id TEXT, node_id TEXT, provider TEXT, raw_event_id TEXT, event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE team_rules_command_actors (command_id TEXT PRIMARY KEY, person TEXT NOT NULL, os_user TEXT, device_json TEXT NOT NULL);
  CREATE TABLE team_rules_settings_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, paths_json TEXT NOT NULL, person TEXT, os_user TEXT, device_json TEXT);
`;

const seeded = () =>
  database((db) => {
    db.exec(SCHEMA);
    const event = db.prepare(
      `INSERT INTO orchestration_v2_events (command_id, thread_id, event_type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
    );
    event.run("c1", "t1", "message.sent", "2026-11-01T10:00:00.000Z", '{"text":"PRIVATE MESSAGE"}');
    event.run(null, "t1", "turn.started", "2026-11-01T10:00:02.000Z", '{"secret":"PRIVATE"}');
    event.run("c2", "t2", "runtime-request.responded", "2026-11-03T10:00:00.000Z", "{}");
    db.prepare(`INSERT INTO team_rules_command_actors VALUES (?, ?, ?, ?)`).run(
      "c1",
      "device:phone-1",
      "anna",
      '{"sessionId":"s1","type":"mobile"}',
    );
    db.prepare(
      `INSERT INTO team_rules_settings_changes (occurred_at, paths_json, person, os_user, device_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "2026-11-01T10:00:01.000Z",
      '["defaultRuntimeMode"]',
      "owner",
      "anna",
      '{"sessionId":"s2"}',
    );
  });

describe("teamRulesRecordLines", () => {
  it("merges events and settings changes by time, with person and device", () => {
    const records = [...teamRulesRecordLines({ dbPath: seeded().path })].map((line) =>
      JSON.parse(line),
    );
    expect(records.map((record) => record.kind)).toEqual([
      "event",
      "settings-change",
      "event",
      "event",
    ]);
    expect(records[0].person).toBe("device:phone-1");
    expect(records[0].device).toEqual({ sessionId: "s1", type: "mobile" });
    expect(records[0].osUser).toBe("anna");
    expect(records[1].paths).toEqual(["defaultRuntimeMode"]);
    expect(records[2].person).toBeNull();
    expect(records[0].machine).toBeTypeOf("string");
  });

  it("never exports a payload", () => {
    const text = [...teamRulesRecordLines({ dbPath: seeded().path })].join("\n");
    expect(text).not.toContain("PRIVATE");
  });

  it("filters by time at both ends", () => {
    const lines = [
      ...teamRulesRecordLines({
        dbPath: seeded().path,
        since: "2026-11-01T10:00:01.000Z",
        until: "2026-11-02T00:00:00.000Z",
      }),
    ].map((line) => JSON.parse(line).at);
    expect(lines).toEqual(["2026-11-01T10:00:01.000Z", "2026-11-01T10:00:02.000Z"]);
  });

  it("reads a database from before the records tables", () => {
    const { path } = database((db) =>
      db.exec(`CREATE TABLE orchestration_v2_events (
        sequence INTEGER PRIMARY KEY, command_id TEXT, thread_id TEXT, run_id TEXT, provider TEXT,
        event_type TEXT, occurred_at TEXT, payload_json TEXT);
        INSERT INTO orchestration_v2_events (thread_id, event_type, occurred_at, payload_json)
        VALUES ('t', 'x', '2026-01-01T00:00:00.000Z', '{}')`),
    );
    const [line] = [...teamRulesRecordLines({ dbPath: path })];
    expect(JSON.parse(line!).person).toBeNull();
  });

  it("closes the record reader when the output already exists", () => {
    const { root, path } = seeded();
    const output = NodePath.join(root, "existing.jsonl");
    NodeFS.writeFileSync(output, "preserved");
    const close = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "close");
    expect(() => writeTeamRulesRecordsFile({ dbPath: path }, output)).toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(NodeFS.readFileSync(output, "utf8")).toBe("preserved");
  });

  it("closes the record reader and output after a write fails", () => {
    const { root, path } = seeded();
    const output = NodePath.join(root, "failed.jsonl");
    const close = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "close");
    const closeFile = vi.mocked(NodeFS.closeSync).mockClear();
    vi.mocked(NodeFS.writeSync).mockImplementationOnce(() => {
      throw new Error("synthetic ENOSPC");
    });
    expect(() => writeTeamRulesRecordsFile({ dbPath: path }, output)).toThrow("synthetic ENOSPC");
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeFile).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite an existing file and writes a private one", () => {
    const { root, path } = seeded();
    const output = NodePath.join(root, "records.jsonl");
    expect(writeTeamRulesRecordsFile({ dbPath: path }, output)).toBe(4);
    expect(NodeFS.readFileSync(output, "utf8").trim().split("\n")).toHaveLength(4);
    if (process.platform !== "win32") {
      expect(NodeFS.statSync(output).mode & 0o077).toBe(0);
    }
    expect(() => writeTeamRulesRecordsFile({ dbPath: path }, output)).toThrow();
  });
});

describe("changedSettingPaths", () => {
  it("names the paths and never the values", () => {
    const before = DEFAULT_SERVER_SETTINGS;
    const after = {
      ...before,
      defaultRuntimeMode: "auto-accept-edits" as const,
      agentInstructions: "PRIVATE INSTRUCTIONS",
    };
    const paths = changedSettingPaths(before, after);
    expect(paths).toContain("defaultRuntimeMode");
    expect(paths).toContain("agentInstructions");
    expect(paths.join(" ")).not.toContain("PRIVATE");
    expect(changedSettingPaths(before, before)).toEqual([]);
  });
});

describe("teamRulesActorOfSession", () => {
  it("names the approved principal over the subject", () => {
    expect(
      teamRulesActorOfSession({
        sessionId: "s",
        subject: "phone",
        principal: { kind: "device", id: "abc" },
        clientDeviceType: "mobile",
      }),
    ).toEqual({ person: "device:abc", device: { sessionId: "s", type: "mobile" } });
    expect(teamRulesActorOfSession({ sessionId: "s", subject: "owner" }).person).toBe("owner");
  });
});
