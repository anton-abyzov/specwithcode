import { describe, expect, it } from "vite-plus/test";

import {
  isPersonalAssistantProject,
  machineAssistantOf,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "./personalAssistant.ts";

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

  it("says Percy is the account's, and that a chat stays on its machine (1448 AC-23)", () => {
    expect(PERSONAL_ASSISTANT_PRIVATE_MESSAGE).toContain(
      "belongs to your SpecWithCode Connect account",
    );
    expect(PERSONAL_ASSISTANT_PRIVATE_MESSAGE).toContain(
      "the same on each machine where you turned it on",
    );
    expect(PERSONAL_ASSISTANT_PRIVATE_MESSAGE).toContain(
      "A Percy chat stays on the machine it was started on",
    );
  });

  it("no longer says an assistant is one machine's, or that nothing moves, copies or syncs", () => {
    for (const retired of ["private to its machine", "never move", "copy or sync"])
      expect(PERSONAL_ASSISTANT_PRIVATE_MESSAGE).not.toContain(retired);
  });
});
