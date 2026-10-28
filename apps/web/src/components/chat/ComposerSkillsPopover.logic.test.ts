import type { ProjectSkillRow, ServerProviderSkill } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import {
  buildComposerSkillGroups,
  collectSessionSkillUses,
  composerSkillsDiscoveryError,
  composerSkillsFailureReason,
  composerSkillsHeading,
  composerSkillsRescanPlan,
  composerSkillsVersionsNote,
  composerSkillVersion,
  countSessionSkillsUsed,
  folderBasename,
  sessionSkillUsesKey,
  skillTokensInText,
} from "./ComposerSkillsPopover.logic";

const skill = (fields: Partial<ServerProviderSkill> & { name: string }): ServerProviderSkill =>
  ({
    path: `/home/me/.claude/skills/${fields.name}/SKILL.md`,
    scope: "user",
    enabled: true,
    ...fields,
  }) as ServerProviderSkill;

const presence = (fields: {
  instanceId?: string;
  path: string;
  name?: string;
  fileVersion?: string | null;
  pluginVersion?: string | null;
}) =>
  ({
    instanceId: fields.instanceId ?? "claudeAgent",
    driver: "claudeAgent",
    label: "Claude",
    path: fields.path,
    scope: "user",
    enabled: true,
    ...(fields.name ? { name: fields.name } : {}),
    fileVersion: fields.fileVersion ?? null,
    pluginVersion: fields.pluginVersion ?? null,
  }) as ProjectSkillRow["providers"][number];

const row = (fields: {
  name: string;
  aliases?: string[];
  lockVersion?: string | null;
  providers: ProjectSkillRow["providers"];
}): ProjectSkillRow =>
  ({
    name: fields.name,
    ...(fields.aliases ? { aliases: fields.aliases } : {}),
    status: "ok",
    attention: false,
    issues: [],
    path: fields.providers[0]?.path ?? null,
    scopes: [],
    providers: fields.providers,
    lock:
      fields.lockVersion === undefined
        ? null
        : {
            lockPath: "/p/vskill.lock",
            lockScope: "project",
            version: fields.lockVersion,
            tier: null,
            source: null,
            sha: null,
            installedAt: null,
          },
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
  }) as ProjectSkillRow;

const work = (toolName: string, input: unknown): TimelineEntry =>
  ({
    id: `work-${toolName}-${Math.random()}`,
    kind: "work",
    createdAt: "2026-10-28T00:00:00.000Z",
    entry: { structuredPayload: { type: "dynamic_tool", toolName, input } },
  }) as unknown as TimelineEntry;

const message = (role: "user" | "assistant", text: string): TimelineEntry =>
  ({
    id: `message-${text}`,
    kind: "message",
    createdAt: "2026-10-28T00:00:00.000Z",
    message: { role, text },
  }) as unknown as TimelineEntry;

describe("collectSessionSkillUses", () => {
  it("collects Claude Skill calls and $name tokens the person sent, first use first", () => {
    const uses = collectSessionSkillUses([
      message("user", "run $sw:do then fix it, not $5 or $10k"),
      work("Skill", { skill: "frontend-design", args: "x" }),
      work("Bash", { command: "ls" }),
      message("assistant", "I will use $not-from-the-user"),
      work("Skill", { skill: "sw:do" }),
      message("user", "again $sw:do"),
    ]);
    expect(uses).toEqual([
      { name: "sw:do", via: "tool" },
      { name: "frontend-design", via: "tool" },
    ]);
  });

  it("keeps token-only uses and gives a stable key", () => {
    const uses = collectSessionSkillUses([message("user", "$review please")]);
    expect(uses).toEqual([{ name: "review", via: "token" }]);
    expect(sessionSkillUsesKey(uses)).toBe("token:review");
    expect(skillTokensInText("price $20 and $x1 $x1")).toEqual(["x1"]);
  });
});

describe("composerSkillVersion", () => {
  const path = "/repo/.claude/skills/sw-do/SKILL.md";
  it("uses a verified scope-matching lock fallback, then plugin and file metadata", () => {
    expect(
      composerSkillVersion(
        {
          rows: [
            {
              ...row({
                name: "sw:do",
                lockVersion: "1.2.0",
                providers: [{ ...presence({ path }), scope: "project" }],
              }),
              drift: "match",
            },
          ],
        },
        "claudeAgent",
        { name: "sw:do", path },
      ),
    ).toEqual({ value: "1.2.0", source: "lockfile" });
    expect(
      composerSkillVersion(
        {
          rows: [
            row({
              name: "do",
              aliases: ["sw:do"],
              providers: [presence({ path, pluginVersion: "3.1.0", fileVersion: "0.9" })],
            }),
          ],
        },
        "claudeAgent",
        { name: "sw:do", path },
      ),
    ).toEqual({ value: "3.1.0", source: "plugin" });
    expect(
      composerSkillVersion(
        { rows: [row({ name: "sw:do", providers: [presence({ path, fileVersion: "0.9" })] })] },
        "claudeAgent",
        { name: "sw:do", path },
      ),
    ).toEqual({ value: "0.9", source: "file" });
  });

  it("is untracked when nothing records a version or no row matches", () => {
    expect(
      composerSkillVersion(
        { rows: [row({ name: "sw:do", providers: [presence({ path })] })] },
        "claudeAgent",
        { name: "sw:do", path },
      ),
    ).toEqual({ value: null, source: null });
    expect(composerSkillVersion({ rows: [] }, "claudeAgent", { name: "x", path })).toEqual({
      value: null,
      source: null,
    });
  });

  it("reads this agent's copy when agents report different versions", () => {
    const rows = [
      row({
        name: "review",
        providers: [
          presence({ instanceId: "codex", path: "/a/SKILL.md", fileVersion: "1.0.0" }),
          presence({ instanceId: "claudeAgent", path: "/b/SKILL.md", fileVersion: "2.0.0" }),
        ],
      }),
    ];
    expect(
      composerSkillVersion({ rows }, "claudeAgent", { name: "review", path: "/b/SKILL.md" }),
    ).toEqual({ value: "2.0.0", source: "file" });
  });

  it("keeps the selected copy's observed version when a merged row has another lock target", () => {
    const merged = {
      ...row({
        name: "review",
        lockVersion: "2.0.0",
        providers: [
          presence({ instanceId: "codex", path: "/a/SKILL.md", fileVersion: "1.0.0" }),
          presence({ instanceId: "claudeAgent", path: "/b/SKILL.md", fileVersion: "2.0.0" }),
        ],
      }),
      copies: 2,
      divergent: true,
      drift: "match" as const,
    };
    expect(
      composerSkillVersion({ rows: [merged] }, "codex", { name: "review", path: "/a/SKILL.md" }),
    ).toEqual({ value: "1.0.0", source: "file", note: "copies differ" });
    expect(
      composerSkillVersion({ rows: [merged] }, "codex", {
        name: "review",
        path: "/unknown/SKILL.md",
      }),
    ).toEqual({ value: null, source: null });
  });

  it("does not treat an unverified or foreign-scope lock as the loaded version", () => {
    const locked = row({ name: "review", lockVersion: "2.0.0", providers: [presence({ path })] });
    expect(
      composerSkillVersion({ rows: [locked] }, "claudeAgent", { name: "review", path }),
    ).toEqual({ value: null, source: null });
    expect(
      composerSkillVersion({ rows: [{ ...locked, drift: "match" }] }, "claudeAgent", {
        name: "review",
        path,
      }),
    ).toEqual({ value: null, source: null });
  });
});

describe("buildComposerSkillGroups", () => {
  const skills = [
    skill({ name: "zeta", scope: "project", path: "/repo/.claude/skills/zeta/SKILL.md" }),
    skill({ name: "alpha", scope: "repo", path: "/repo/.agents/skills/alpha/SKILL.md" }),
    skill({ name: "off-skill", scope: "user", enabled: false }),
    skill({ name: "mine", scope: "user" }),
    skill({
      name: "sw:do",
      scope: "user",
      path: "/home/me/.claude/plugins/cache/sw/skills/do/SKILL.md",
    }),
    skill({ name: "builtin", scope: "bundled" }),
  ];

  it("puts used skills first, then project, user, plugin and other, each once", () => {
    const groups = buildComposerSkillGroups({
      skills,
      instanceId: "claudeAgent",
      snapshot: null,
      uses: [
        { name: "mine", via: "token" },
        { name: "gone", via: "tool" },
        { name: "not-a-skill", via: "token" },
      ],
    });
    expect(groups.map((group) => [group.label, group.items.map((item) => item.name)])).toEqual([
      ["Used in this session", ["mine", "gone"]],
      ["Project", ["alpha", "zeta"]],
      ["User", ["off-skill"]],
      ["Plugin", ["sw:do"]],
      ["Other", ["builtin"]],
    ]);
    const gone = groups[0]!.items[1]!;
    expect(gone).toMatchObject({ missing: true, levelLabel: "Not listed", used: "tool" });
    expect(groups[2]!.items[0]).toMatchObject({ enabled: false });
    // No snapshot yet: versions are pending, not "untracked".
    expect(groups[1]!.items[0]!.version).toBeNull();
  });

  it("marks untracked once the snapshot answers, and filters by search", () => {
    const groups = buildComposerSkillGroups({
      skills,
      instanceId: "claudeAgent",
      snapshot: { rows: [] },
      uses: [],
      query: "ZET",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items[0]).toMatchObject({
      name: "zeta",
      version: { value: null, source: null },
    });
  });

  it("returns no groups for no skills", () => {
    expect(
      buildComposerSkillGroups({ skills: [], instanceId: null, snapshot: null, uses: [] }),
    ).toEqual([]);
  });
});

describe("heading and errors", () => {
  it("names the agent, machine and folder", () => {
    expect(
      composerSkillsHeading({
        agent: "Claude",
        machine: "M4",
        cwd: "/Users/me/worktrees/repo/skills-1124/",
      }),
    ).toBe("Claude on M4 · skills-1124");
    expect(composerSkillsHeading({ agent: "Codex", machine: null, cwd: null })).toBe("Codex");
    expect(folderBasename("C:\\work\\repo")).toBe("repo");
  });

  it("reports a provider error or a failed folder scan, not an empty list", () => {
    expect(
      composerSkillsDiscoveryError({
        providerStatus: "error",
        providerMessage: "claude: command not found",
        instanceId: "claudeAgent",
        snapshot: null,
      }),
    ).toBe("claude: command not found");
    expect(
      composerSkillsDiscoveryError({
        providerStatus: "ready",
        providerMessage: null,
        instanceId: "claudeAgent",
        snapshot: {
          providers: [
            {
              instanceId: "claudeAgent",
              state: "timeout",
              message: "The folder scan did not finish in time.",
            } as never,
          ],
        },
      }),
    ).toBe("The folder scan did not finish in time.");
    expect(
      composerSkillsDiscoveryError({
        providerStatus: "ready",
        providerMessage: null,
        instanceId: "claudeAgent",
        snapshot: { providers: [{ instanceId: "claudeAgent", state: "ok" } as never] },
      }),
    ).toBeNull();
  });
});

describe("countSessionSkillsUsed", () => {
  it("counts listed skills and tool-call uses, not $HOME-style tokens", () => {
    const skills = [skill({ name: "sw-do" }), skill({ name: "frontend-design" })];
    expect(
      countSessionSkillsUsed(skills, [
        { name: "HOME", via: "token" },
        { name: "sw-do", via: "token" },
        { name: "unlisted-tool-skill", via: "tool" },
      ]),
    ).toBe(2);
    expect(countSessionSkillsUsed(skills, [{ name: "PATH", via: "token" }])).toBe(0);
  });

  it("matches the size of the Used in this session group", () => {
    const skills = [skill({ name: "sw-do" })];
    const uses = [
      { name: "HOME", via: "token" as const },
      { name: "sw-do", via: "token" as const },
      { name: "gone", via: "tool" as const },
    ];
    const used = buildComposerSkillGroups({
      skills,
      instanceId: "claudeAgent",
      snapshot: null,
      uses,
      query: "",
    }).find((group) => group.id === "used");
    expect(used?.items.length).toBe(countSessionSkillsUsed(skills, uses));
  });
});

describe("composerSkillsVersionsNote", () => {
  it("shows a neutral line while the thread's folder is not recorded yet", () => {
    expect(
      composerSkillsVersionsNote({ reason: "cwd_not_allowed", error: "That folder is not..." }),
    ).toBe("Versions appear once this thread's folder is ready.");
    expect(composerSkillsVersionsNote({ reason: "read_failed", error: "Boom." })).toBe(
      "Versions unavailable: Boom.",
    );
  });

  it("reads the reason of a tagged failure only", () => {
    expect(composerSkillsFailureReason({ reason: "cwd_not_allowed" })).toBe("cwd_not_allowed");
    expect(composerSkillsFailureReason(new Error("x"))).toBeNull();
    expect(composerSkillsFailureReason(null)).toBeNull();
  });
});

describe("composerSkillsRescanPlan", () => {
  const base = {
    projectId: "p1",
    failureReason: null,
    hasSnapshot: true,
    instanceId: "claudeAgent",
    cwd: "/wt/a",
  };

  it("uses the server rescan for a folder the server accepts", () => {
    expect(composerSkillsRescanPlan(base)).toEqual({ server: true, providers: false });
  });

  it("refreshes the composer's own agent when the server refuses the folder", () => {
    expect(
      composerSkillsRescanPlan({ ...base, failureReason: "cwd_not_allowed", hasSnapshot: false }),
    ).toEqual({ server: false, providers: true });
  });

  it("refreshes the agent too while there is no answer yet", () => {
    expect(composerSkillsRescanPlan({ ...base, hasSnapshot: false })).toEqual({
      server: true,
      providers: true,
    });
  });

  it("refreshes the agent alone without a project, and nothing without a folder", () => {
    expect(composerSkillsRescanPlan({ ...base, projectId: null })).toEqual({
      server: false,
      providers: true,
    });
    expect(composerSkillsRescanPlan({ ...base, projectId: null, cwd: null })).toEqual({
      server: false,
      providers: false,
    });
  });
});
