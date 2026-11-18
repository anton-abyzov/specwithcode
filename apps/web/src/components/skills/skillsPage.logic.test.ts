import type { ProjectSkillRow, ProjectSkillsSnapshot } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { skillSwitchFor } from "../settings/ProjectSkillActions.logic";
import { builtInSkillSource, emptySkillAgents, splitBuiltInSkillRows } from "./skillsPage.logic";

const presence = (driver: string, label: string, scope: string, path: string) => ({
  instanceId: driver,
  driver,
  label,
  path,
  scope,
  enabled: true,
});
const row = (name: string, providers: ReadonlyArray<unknown>) =>
  ({ name, providers }) as unknown as ProjectSkillRow;

const synced = presence(
  "claudeAgent",
  "Claude",
  "claude.ai",
  "/h/.claude/skills/synced/a_b/pdf/SKILL.md",
);
const system = presence("codex", "Codex", "system", "/h/.codex/skills/.system/plan/SKILL.md");
const mine = presence("codex", "Codex", "user", "/h/.agents/skills/notes/SKILL.md");

describe("the Skills page's built-in block", () => {
  it("keeps claude.ai-synced and Codex system skills apart from installed ones", () => {
    const split = splitBuiltInSkillRows([
      row("notes", [mine]),
      row("anthropic-skills:pdf", [synced]),
      row("plan", [system]),
      // A name a person also installed stays manageable.
      row("mixed", [system, mine]),
      row("lock-only", []),
    ]);
    expect(split.installed.map((entry) => entry.name)).toEqual(["notes", "mixed", "lock-only"]);
    expect(split.builtIn.map((entry) => entry.name)).toEqual(["anthropic-skills:pdf", "plan"]);
  });

  it("names where a built-in skill comes from", () => {
    expect(builtInSkillSource(row("anthropic-skills:pdf", [synced]))).toBe("claude.ai");
    expect(builtInSkillSource(row("plan", [system]))).toBe("Codex");
  });

  it("offers no switch for a claude.ai-synced skill", () => {
    const control = skillSwitchFor(synced as never, { userLevel: true });
    expect(control.available).toBe(false);
    expect(control).toMatchObject({ reason: expect.stringContaining("claude.ai") });
  });
});

describe("emptySkillAgents", () => {
  const snapshot = (providers: ReadonlyArray<unknown>) =>
    ({ providers }) as unknown as ProjectSkillsSnapshot;
  it("names each agent the machine has that reports no skills", () => {
    expect(
      emptySkillAgents(
        snapshot([
          { instanceId: "claude", label: "Claude", state: "ok", skills: 0 },
          { instanceId: "codex", label: "Codex", state: "ok", skills: 6 },
          { instanceId: "cached", label: "Cursor", state: "cached", skills: 0 },
          // A scan that failed or timed out did not report zero.
          { instanceId: "slow", label: "Grok", state: "timeout", skills: 0 },
          { instanceId: "off", label: "Pi", state: "unsupported", skills: 0 },
        ]),
      ),
    ).toEqual(["Claude", "Cursor"]);
  });
});
