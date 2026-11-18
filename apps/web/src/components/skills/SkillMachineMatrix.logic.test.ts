import type { ProjectSkillRow, ProjectSkillsSnapshot } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSkillMatrix, type SkillMatrixMachine } from "./SkillMachineMatrix.logic";

const presence = (extra: Record<string, unknown> = {}) => ({
  instanceId: "codex",
  driver: "codex",
  label: "Codex",
  path: "/home/.agents/skills/x/SKILL.md",
  scope: "user",
  enabled: true,
  ...extra,
});
const row = (
  name: string,
  extra: Record<string, unknown> = {},
  agent: Record<string, unknown> = {},
) =>
  ({
    name,
    status: "ok",
    attention: false,
    issues: [],
    path: null,
    scopes: ["user"],
    providers: [presence(agent)],
    lock: null,
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
    ...extra,
  }) as unknown as ProjectSkillRow;
const snapshot = (rows: ProjectSkillRow[], state = "ok") =>
  ({
    cwd: "~",
    checkedAt: "2026-11-18T10:00:00.000Z",
    rows,
    providers: [
      { instanceId: "codex", driver: "codex", label: "Codex", state, skills: rows.length },
    ],
    locks: [],
    doctor: "ok",
  }) as unknown as ProjectSkillsSnapshot;
const machine = (id: string, extra: Partial<SkillMatrixMachine> = {}): SkillMatrixMachine => ({
  id,
  label: id,
  current: false,
  linked: true,
  connected: true,
  error: null,
  pending: false,
  successful: true,
  snapshot: snapshot([]),
  ...extra,
});
const cellsOf = (matrix: ReturnType<typeof buildSkillMatrix>, name: string) =>
  matrix.rows.find((entry) => entry.name === name)?.cells.map((cell) => cell.kind);

describe("buildSkillMatrix", () => {
  it("lists one row per skill and one cell per machine", () => {
    const matrix = buildSkillMatrix([
      machine("desk", {
        current: true,
        snapshot: snapshot([row("notes", {}, { fileVersion: "1.2.0" }), row("draw")]),
      }),
      machine("mini", { snapshot: snapshot([row("notes", {}, { fileVersion: "1.1.0" })]) }),
    ]);
    expect(matrix.rows.map((entry) => entry.name)).toEqual(["draw", "notes"]);
    expect(matrix.rows[1]?.cells).toEqual([
      { kind: "installed", version: "1.2.0", differs: false },
      { kind: "installed", version: "1.1.0", differs: false },
    ]);
    expect(matrix.rows[0]?.cells).toEqual([
      { kind: "installed", version: null, differs: false },
      { kind: "missing" },
    ]);
    expect(matrix.columns.map((column) => [column.id, column.state, column.readAt])).toEqual([
      ["desk", "read", "2026-11-18T10:00:00.000Z"],
      ["mini", "read", "2026-11-18T10:00:00.000Z"],
    ]);
  });

  it("never reports an offline, unread or failed machine as missing", () => {
    const matrix = buildSkillMatrix([
      machine("desk", { current: true, snapshot: snapshot([row("notes")]) }),
      machine("offline", { connected: false, snapshot: null, successful: false }),
      machine("unlinked", { linked: false, snapshot: null, successful: false }),
      machine("pending", { pending: true, snapshot: null, successful: false }),
      machine("failed", { error: "Request timed out", snapshot: null, successful: false }),
      machine("signin", {
        error: "Not signed in on this machine",
        snapshot: null,
        successful: false,
      }),
      machine("denied", { error: "Permission denied", snapshot: null, successful: false }),
      machine("partial", { snapshot: snapshot([], "timeout") }),
    ]);
    expect(cellsOf(matrix, "notes")).toEqual([
      "installed",
      "offline",
      "unknown",
      "unknown",
      "unknown",
      "needs-sign-in",
      "unknown",
      "unknown",
    ]);
    expect(matrix.columns.map((column) => column.state)).toEqual([
      "read",
      "offline",
      "unlinked",
      "checking",
      "failed",
      "needs-sign-in",
      "failed",
      "partial",
    ]);
    expect(matrix.columns[1]?.readAt).toBeNull();
    expect(JSON.stringify(matrix)).not.toContain('"missing"');
  });

  it("keeps a skill a partial scan did find", () => {
    const matrix = buildSkillMatrix([
      machine("desk", { current: true, snapshot: snapshot([row("notes")]) }),
      machine("partial", {
        snapshot: snapshot([row("notes", {}, { fileVersion: "2.0.0" })], "timeout"),
      }),
    ]);
    expect(matrix.rows[0]?.cells[1]).toEqual({
      kind: "installed",
      version: "2.0.0",
      differs: false,
    });
  });

  it("does not call the page's own machine read once it has disconnected", () => {
    const matrix = buildSkillMatrix([
      // The page keeps its last snapshot; that is not a current read.
      machine("desk", { current: true, connected: false, snapshot: snapshot([row("notes")]) }),
      machine("mini", { snapshot: snapshot([row("notes"), row("draw")]) }),
    ]);
    expect(matrix.columns[0]).toMatchObject({ state: "offline", readAt: null });
    expect(cellsOf(matrix, "draw")).toEqual(["offline", "installed"]);
    expect(cellsOf(matrix, "notes")).toEqual(["offline", "installed"]);
  });

  it("does not call a claude.ai skill missing on any machine", () => {
    const synced = row(
      "anthropic-skills:pdf",
      {},
      { instanceId: "claude", driver: "claudeAgent", label: "Claude", scope: "claude.ai" },
    );
    const matrix = buildSkillMatrix([
      machine("desk", { current: true, snapshot: snapshot([synced]) }),
      // An older app does not read the synced folder at all.
      machine("old", { snapshot: snapshot([row("notes")]) }),
      machine("new", {
        snapshot: snapshot([
          row(
            "anthropic-skills:docx",
            {},
            { instanceId: "claude", driver: "claudeAgent", label: "Claude", scope: "claude.ai" },
          ),
        ]),
      }),
    ]);
    const pdf = matrix.rows.find((entry) => entry.name === "anthropic-skills:pdf");
    expect(pdf?.builtIn).toBe(true);
    // Never "Not on": the other machines may sync another account, or not read the folder.
    expect(pdf?.cells.map((cell) => cell.kind)).toEqual(["installed", "unreported", "unreported"]);
    // Built-in rows sort after the ones a person can install.
    expect(matrix.rows.map((entry) => entry.name)).toEqual([
      "notes",
      "anthropic-skills:docx",
      "anthropic-skills:pdf",
    ]);
  });

  it("offers an update only from a known newer version", () => {
    const machines = [
      machine("desk", {
        current: true,
        snapshot: snapshot([row("notes", {}, { fileVersion: "1.2.0" }), row("draw")]),
      }),
    ];
    const none = buildSkillMatrix(machines);
    expect(none.rows[1]?.cells[0]).toEqual({ kind: "installed", version: "1.2.0", differs: false });
    const matrix = buildSkillMatrix(machines, {
      latest: new Map([
        ["notes", "1.10.0"],
        ["draw", "3.0.0"],
      ]),
    });
    expect(matrix.rows[1]?.cells[0]).toEqual({
      kind: "installed",
      version: "1.2.0",
      differs: false,
      update: "1.10.0",
    });
    // No installed version to compare: nothing is claimed.
    expect(matrix.rows[0]?.cells[0]).toEqual({ kind: "installed", version: null, differs: false });
    const same = buildSkillMatrix(machines, { latest: new Map([["notes", "1.2.0"]]) });
    expect(same.rows[1]?.cells[0]).not.toHaveProperty("update");
  });

  it("never shows this machine's source update on another machine", () => {
    const matrix = buildSkillMatrix(
      [
        machine("desk", {
          current: true,
          snapshot: snapshot([row("notes", {}, { fileVersion: "1.0.0" })]),
        }),
        machine("mini", { snapshot: snapshot([row("notes", {}, { fileVersion: "1.0.0" })]) }),
      ],
      { latest: new Map([["notes", "2.0.0"]]) },
    );
    expect(matrix.rows[0]?.cells).toEqual([
      { kind: "installed", version: "1.0.0", differs: false, update: "2.0.0" },
      { kind: "installed", version: "1.0.0", differs: false },
    ]);
  });

  it("shows unknown, never missing, on a machine whose skill folders could not all be read", () => {
    const unreadable = {
      ...snapshot([]),
      providers: [
        {
          instanceId: "claude",
          driver: "claudeAgent",
          label: "Claude",
          state: "ok",
          skills: 0,
          incomplete: true,
        },
      ],
    } as unknown as ProjectSkillsSnapshot;
    const matrix = buildSkillMatrix([
      machine("desk", { current: true, snapshot: snapshot([row("notes")]) }),
      machine("mini", { snapshot: unreadable }),
    ]);
    expect(cellsOf(matrix, "notes")).toEqual(["installed", "unknown"]);
    expect(matrix.columns[1]?.state).toBe("partial");
  });
});
