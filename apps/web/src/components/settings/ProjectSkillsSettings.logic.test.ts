import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillPresence,
  type ProjectSkillRow,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterProjectSkillRows,
  projectSkillAttentionCount,
  projectSkillProviderBadges,
  projectSkillStatusBadge,
} from "./ProjectSkillsSettings.logic";

function presence(label: string, path: string, enabled = true): ProjectSkillPresence {
  return {
    instanceId: ProviderInstanceId.make(label.toLowerCase()),
    driver: ProviderDriverKind.make(label.toLowerCase()),
    label,
    path,
    scope: "user",
    enabled,
  };
}

function row(name: string, extra: Partial<ProjectSkillRow> = {}): ProjectSkillRow {
  return {
    name,
    status: "ok",
    attention: false,
    issues: [],
    path: `/home/me/.agents/skills/${name}/SKILL.md`,
    scopes: ["user"],
    providers: [presence("Claude", `/home/me/.agents/skills/${name}/SKILL.md`)],
    lock: null,
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
    ...extra,
  };
}

const rows = [
  row("deploy"),
  row("notes-sync", {
    status: "drift",
    attention: true,
    lock: {
      lockPath: "/home/me/.agents/vskill.lock",
      lockScope: "user",
      version: "1.0.0",
      tier: "VERIFIED",
      source: "github:anton-abyzov/vskill",
      sha: "137323e3e9d4",
      installedAt: null,
    },
  }),
  row("review", {
    providers: [presence("Codex", "/work/.agents/skills/review/SKILL.md")],
    doctor: ["2 byte-identical copies"],
    attention: true,
  }),
];

describe("filterProjectSkillRows", () => {
  it("matches every search token across name, source and provider", () => {
    expect(
      filterProjectSkillRows(rows, { query: "vskill notes", problemsOnly: false }).map(
        (entry) => entry.name,
      ),
    ).toEqual(["notes-sync"]);
    expect(
      filterProjectSkillRows(rows, { query: "CODEX", problemsOnly: false }).map(
        (entry) => entry.name,
      ),
    ).toEqual(["review"]);
  });

  it("keeps only rows that need attention when problems only is on", () => {
    expect(
      filterProjectSkillRows(rows, { query: "", problemsOnly: true }).map((entry) => entry.name),
    ).toEqual(["notes-sync", "review"]);
    expect(projectSkillAttentionCount(rows)).toBe(2);
  });
});

describe("projectSkillStatusBadge", () => {
  it("labels drift and flags doctor-only findings on ok rows", () => {
    expect(projectSkillStatusBadge(rows[0]!)).toEqual({ label: "ok", variant: "success" });
    expect(projectSkillStatusBadge(rows[1]!)).toEqual({ label: "drift", variant: "warning" });
    expect(projectSkillStatusBadge(rows[2]!)).toEqual({ label: "check", variant: "warning" });
    expect(projectSkillStatusBadge(row("x", { status: "duplicate", attention: true }))).toEqual({
      label: "duplicate",
      variant: "error",
    });
  });
});

describe("projectSkillProviderBadges", () => {
  it("shows one badge per agent and marks agents that switched it off", () => {
    const badges = projectSkillProviderBadges(
      row("gws", {
        providers: [
          presence("Claude", "/a/SKILL.md"),
          presence("Claude", "/b/SKILL.md"),
          presence("Codex", "/a/SKILL.md", false),
        ],
      }),
    );
    expect(badges.map((badge) => [badge.label, badge.enabled])).toEqual([
      ["Claude", true],
      ["Codex", false],
    ]);
    expect(badges[0]!.title).toBe("Claude\nuser: /a/SKILL.md\nuser: /b/SKILL.md");
    expect(badges[1]!.title).toBe("Codex (switched off)\nuser: /a/SKILL.md (off)");
  });
});
