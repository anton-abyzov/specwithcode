import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterServerRows, serverListRows, serverRowSteps, snapshotIncomplete } from "./serverRows";

const base: NativeConnectionsSnapshot = {
  observedAt: "2026-11-18T00:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [],
  connections: [],
};
const entry = (
  provider: "codex" | "claude",
  name: string,
  more: Partial<NativeConnectionsSnapshot["connections"][number]> = {},
): NativeConnectionsSnapshot["connections"][number] => ({
  id: `${provider}:${name}`,
  name,
  provider,
  sourceId: `${provider}-user`,
  scope: "user",
  transport: "http",
  state: "configured",
  shadowed: false,
  ...more,
});

describe("serverListRows", () => {
  it("makes one row per name, sorted, with the entry each tool uses", () => {
    const rows = serverListRows({
      ...base,
      connections: [
        entry("codex", "Zeta"),
        entry("claude", "alpha", { state: "disabled", parked: true }),
        entry("codex", "alpha"),
        // An overridden user entry is not the one Claude Code runs.
        entry("claude", "Zeta", { id: "claude:shadowed", shadowed: true }),
      ],
      otherTools: [
        {
          tool: "cursor",
          status: "read",
          connections: [
            { id: "cursor:alpha", name: "alpha", transport: "http", state: "configured" },
          ],
        },
        { tool: "gemini", status: "missing", connections: [] },
      ],
    });
    expect(rows.map((row) => row.name)).toEqual(["alpha", "Zeta"]);
    expect(rows[0]!.entries.map((value) => value.tool)).toEqual(["codex", "claude", "cursor"]);
    expect(rows[0]!.off).toBe(false);
    expect(rows[1]!.entries.map((value) => value.tool)).toEqual(["codex"]);
  });

  it("marks a server off only when every tool has it off", () => {
    const rows = serverListRows({
      ...base,
      connections: [entry("codex", "a", { state: "disabled" }), entry("claude", "a")],
    });
    expect(rows[0]!.off).toBe(false);
    expect(
      serverListRows({ ...base, connections: [entry("codex", "a", { state: "disabled" })] })[0]!
        .off,
    ).toBe(true);
  });

  it("keeps plugin, folder and project entries out of the edits", () => {
    const [row] = serverListRows({
      ...base,
      connections: [
        entry("codex", "a", { plugin: "Figma" }),
        entry("claude", "a", { project: "site" }),
      ],
    });
    expect(row!.entries.map((value) => value.origin.kind)).toEqual(["plugin", "folder"]);
    expect(serverRowSteps(row!, "remove")).toEqual([]);
    const [project] = serverListRows({
      ...base,
      connections: [entry("claude", "b", { scope: "project", sourceId: "claude-project" })],
    });
    expect(project!.thisProject).toBe(true);
    expect(serverRowSteps(project!, "disable")).toEqual([]);
  });
});

describe("serverRowSteps", () => {
  const [row] = serverListRows({
    ...base,
    connections: [
      entry("codex", "a"),
      // Claude Code has no off switch of its own: only a kept-aside entry turns back on.
      entry("claude", "a", { state: "disabled" }),
    ],
    otherTools: [
      {
        tool: "opencode",
        status: "read",
        connections: [{ id: "opencode:a", name: "a", transport: "http", state: "disabled" }],
      },
    ],
  });
  it("turns off only what is on", () => {
    expect(serverRowSteps(row!, "disable")).toEqual([
      { tool: "codex", input: { action: "disable", connectionId: "codex:a" } },
    ]);
  });
  it("turns on only what SpecWithCode can turn back on", () => {
    expect(serverRowSteps(row!, "enable").map((step) => step.tool)).toEqual(["opencode"]);
  });
  it("removes it from every tool that has it", () => {
    expect(serverRowSteps(row!, "remove").map((step) => step.tool)).toEqual([
      "codex",
      "claude",
      "opencode",
    ]);
  });
});

describe("list helpers", () => {
  it("searches names and tool labels", () => {
    const rows = serverListRows({
      ...base,
      connections: [entry("codex", "linear"), entry("claude", "notion")],
    });
    const label = (tool: string) => (tool === "codex" ? "Codex" : "Claude Code");
    expect(filterServerRows(rows, " LIN ", label).map((row) => row.name)).toEqual(["linear"]);
    expect(filterServerRows(rows, "claude", label).map((row) => row.name)).toEqual(["notion"]);
    expect(filterServerRows(rows, "", label)).toHaveLength(2);
  });
  it("knows when a scan may have missed servers", () => {
    expect(snapshotIncomplete(base)).toBe(false);
    expect(snapshotIncomplete({ ...base, truncated: true })).toBe(true);
    expect(
      snapshotIncomplete({
        ...base,
        sources: [{ id: "codex-user", provider: "codex", scope: "user", status: "invalid" }],
      }),
    ).toBe(true);
    expect(
      snapshotIncomplete({
        ...base,
        sources: [{ id: "codex-user", provider: "codex", scope: "user", status: "missing" }],
      }),
    ).toBe(false);
  });
});
