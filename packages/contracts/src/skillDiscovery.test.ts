import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectSkillPresence, ProjectSkillsSnapshot } from "./projectSkills.ts";
import { ServerProviderSkill } from "./server.ts";

const presence = {
  instanceId: "copilot",
  driver: "acpRegistry",
  label: "GitHub Copilot",
  path: "/work/.agents/skills/notes/SKILL.md",
  scope: "project",
  enabled: true,
};
const snapshot = (providers: ReadonlyArray<unknown>) => ({
  cwd: "/work",
  checkedAt: "2026-11-20T10:00:00.000Z",
  rows: [
    {
      name: "notes",
      status: "ok",
      attention: false,
      issues: [],
      path: presence.path,
      scopes: ["project"],
      providers,
      lock: null,
      drift: "unlocked",
      copies: 1,
      divergent: false,
      doctor: [],
    },
  ],
  providers: [],
  locks: [],
  doctor: "ok",
});

describe("skill discovery fields across app versions", () => {
  it("reads a payload from a machine that sends neither field", () => {
    const decoded = Schema.decodeUnknownSync(ProjectSkillsSnapshot)(snapshot([presence]));
    expect(decoded.rows[0]?.providers[0]).not.toHaveProperty("discovery");
    expect(decoded.rows[0]?.providers[0]).not.toHaveProperty("otherCopies");
  });

  it("reads the new fields on a presence and on a provider skill", () => {
    const fields = {
      discovery: "folder-scan",
      otherCopies: [{ path: "/home/.agents/skills/notes/SKILL.md", scope: "user" }],
    };
    expect(
      Schema.decodeUnknownSync(ProjectSkillPresence)({ ...presence, ...fields }),
    ).toMatchObject(fields);
    expect(
      Schema.decodeUnknownSync(ServerProviderSkill)({
        name: "notes",
        path: presence.path,
        enabled: true,
        ...fields,
      }),
    ).toMatchObject(fields);
  });

  it("ignores a field it does not know, as an older reader does with these", () => {
    // The schemas are plain structs, so an unknown key is dropped, not refused.
    const decoded = Schema.decodeUnknownSync(ProjectSkillsSnapshot)(
      snapshot([{ ...presence, aFieldFromANewerApp: { anything: true } }]),
    );
    expect(decoded.rows[0]?.providers[0]).not.toHaveProperty("aFieldFromANewerApp");
    expect(decoded.rows[0]?.providers[0]?.path).toBe(presence.path);
  });
});
