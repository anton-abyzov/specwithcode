import { describe, expect, it } from "vite-plus/test";

import { isPersonalAssistantProject, machineAssistantOf } from "./personalAssistant.ts";

const personal = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt,
  workspaceSettings: { kind: "personal" },
  ...extra,
});

describe("machine assistant", () => {
  it("is the earliest personal project that is not deleted, archived or not", () => {
    const projects = [
      { id: "code", createdAt: "2026-01-01T00:00:00Z", workspaceSettings: { kind: "code" } },
      personal("later", "2026-03-01T00:00:00Z"),
      personal("gone", "2026-01-15T00:00:00Z", { deletedAt: "2026-02-01T00:00:00Z" }),
      personal("first", "2026-02-01T00:00:00Z", {
        workspaceSettings: { kind: "personal", archived: true },
      }),
    ];
    expect(machineAssistantOf(projects)?.id).toBe("first");
    expect(machineAssistantOf([projects[0]!])).toBeUndefined();
  });

  it("breaks a creation-time tie by id, so every client picks the same one", () => {
    const at = "2026-02-01T00:00:00Z";
    expect(machineAssistantOf([personal("b", at), personal("a", at)])?.id).toBe("a");
  });

  it("reads the kind from settings or a flat field", () => {
    expect(isPersonalAssistantProject({ kind: "personal" })).toBe(true);
    expect(isPersonalAssistantProject({ workspaceSettings: { kind: "code" } })).toBe(false);
    expect(isPersonalAssistantProject(undefined)).toBe(false);
  });
});
