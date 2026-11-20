import type { ProjectSkillRow, ServerProviderSkill } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import {
  buildComposerSkillGroups,
  COMPOSER_SKILLS_PAGE_SIZE,
  composerSkillCatalog,
  composerSkillFilesNamed,
  composerSkillsListScope,
  composerSkillsSourceLine,
  pageComposerSkillGroups,
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
      ["Bundled", ["builtin"]],
    ]);
    const gone = groups[0]!.items[1]!;
    expect(gone).toMatchObject({ missing: true, levelLabel: "Not in this list", used: "tool" });
    expect(groups[2]!.items[0]).toMatchObject({ enabled: false });
    // No snapshot yet: versions are pending, never a claim.
    expect(groups[1]!.items[0]!.version).toBeNull();
    expect(groups[1]!.items[0]!.detail).toBe("Checking…");
    // The agent reported these paths itself, so the level is its own word.
    expect(groups[1]!.items[0]!.location).toEqual({ kind: "reported" });
  });

  it("reads no version once the snapshot answers without one, and filters by search", () => {
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

describe("composerSkillCatalog", () => {
  it("keeps each advertised name as its own skill: a name is not proof of one file", () => {
    const command = skill({ name: "unslop", path: "acp://command/unslop" });
    const advertised = skill({ name: "workspace-skill", path: "acp://skill/workspace-skill" });
    // Another presence's aliases must not fold two advertised commands into one.
    const snapshot = {
      rows: [
        row({
          name: "canonical",
          aliases: ["unslop", "workspace-skill"],
          providers: [
            presence({ instanceId: "copilot", path: "/work/.agents/skills/canonical/SKILL.md" }),
          ],
        }),
      ],
    };
    expect(composerSkillCatalog([command, advertised], "copilot", null)).toEqual([
      command,
      advertised,
    ]);
    expect(composerSkillCatalog([command, advertised], "copilot", snapshot)).toEqual([
      command,
      advertised,
    ]);
    // The same name advertised twice is still one skill.
    expect(composerSkillCatalog([command, { ...command }], "copilot", snapshot)).toHaveLength(1);
  });
  it("excludes plugin commands and hidden copies exactly like Settings", () => {
    const valid = skill({ name: "valid" });
    expect(
      composerSkillCatalog(
        [
          valid,
          skill({ name: "command", path: "/plugins/commands/setup.md" }),
          skill({ name: "trash", path: "/skills/.trash/test/SKILL.md" }),
        ],
        "codex",
        null,
      ),
    ).toEqual([valid]);
  });
  it("counts user and system skill-creator copies once, preserving an enabled native path", () => {
    const user = skill({ name: "skill-creator", enabled: false });
    const system = skill({
      name: "skill-creator",
      path: "/home/me/.codex/skills/.system/skill-creator/SKILL.md",
      scope: "system",
    });
    expect(composerSkillCatalog([user, system], "codex", null)).toEqual([system]);
  });
  it("joins alias names only when this instance's exact copies share a Settings row", () => {
    const first = skill({ name: "one" });
    const second = skill({ name: "alias" });
    const snapshot = {
      rows: [
        row({
          name: "canonical",
          providers: [presence({ path: first.path }), presence({ path: second.path })],
        }),
      ],
    };
    expect(composerSkillCatalog([first, second], "claudeAgent", snapshot)).toEqual([first]);
    expect(composerSkillCatalog([first, second], "codex", snapshot)).toHaveLength(2);
  });
  it("searches full descriptions behind short summaries, across tokens", () => {
    const groups = buildComposerSkillGroups({
      skills: [
        skill({
          name: "launch",
          shortDescription: "Write copy",
          description: "Marketing campaigns for football",
        }),
      ],
      instanceId: "codex",
      snapshot: null,
      uses: [],
      query: "football marketing",
    });
    expect(groups.flatMap((group) => group.items).map((item) => item.name)).toEqual(["launch"]);
  });
});

describe("skills an agent only advertises by name", () => {
  const advertised = (name: string) =>
    skill({ name, path: `acp://command/${name}`, scope: "agent" });
  const file = (fields: {
    instanceId?: string;
    path: string;
    scope: string;
    name?: string;
    fileVersion?: string | null;
    otherCopies?: ReadonlyArray<{ path: string; scope: string | null }>;
  }) =>
    ({
      ...presence({
        instanceId: fields.instanceId ?? "copilot",
        path: fields.path,
        ...(fields.name ? { name: fields.name } : {}),
        fileVersion: fields.fileVersion ?? null,
      }),
      scope: fields.scope,
      discovery: "folder-scan",
      ...(fields.otherCopies ? { otherCopies: fields.otherCopies } : {}),
    }) as ProjectSkillRow["providers"][number];
  const locked = (base: ProjectSkillRow, source: string, lockScope = "project") =>
    ({
      ...base,
      lock: { ...base.lock!, lockScope, source },
    }) as ProjectSkillRow;
  const build = (
    skills: ReadonlyArray<ServerProviderSkill>,
    rows: ProjectSkillRow[] | null,
    extra: { snapshotPending?: boolean; query?: string } = {},
  ) =>
    buildComposerSkillGroups({
      skills,
      instanceId: "copilot",
      snapshot: rows ? { rows } : null,
      uses: [],
      ...extra,
    });
  const only = (groups: ReturnType<typeof build>) => groups.flatMap((group) => group.items)[0]!;

  it("shows the one matching file's scope, version and lock, and says it is a match", () => {
    const notes = locked(
      row({
        name: "notes",
        lockVersion: "1.0.12",
        providers: [
          file({
            path: "/work/.agents/skills/notes/SKILL.md",
            scope: "project",
            fileVersion: "1.0.12",
          }),
        ],
      }),
      "github:acme/skills",
    );
    const groups = build([advertised("notes")], [notes]);
    expect(groups.map((group) => group.label)).toEqual(["Project"]);
    const item = only(groups);
    expect(item).toMatchObject({
      level: "project",
      levelLabel: "Project",
      inSettings: true,
      version: { value: "1.0.12", source: "file" },
      detail: "Matching file · v1.0.12 · lock: acme/skills",
    });
    expect(item.location.kind).toBe("matched");
    expect(JSON.stringify(groups)).not.toMatch(/untracked/i);
  });

  it("falls back to a clean lock's version when the matching file states none", () => {
    const notes = {
      ...locked(
        row({
          name: "notes",
          lockVersion: "1.0.12",
          providers: [file({ path: "/work/.agents/skills/notes/SKILL.md", scope: "project" })],
        }),
        "github:acme/skills",
      ),
      drift: "match",
    } as ProjectSkillRow;
    const item = only(build([advertised("notes")], [notes]));
    expect(item).toMatchObject({
      version: { value: "1.0.12", source: "lockfile" },
      detail: "Matching file · v1.0.12 from lock · lock: acme/skills",
    });
    expect(JSON.stringify(item)).not.toMatch(/untracked/i);
  });

  it("says which version the lock holds when the matching file states another", () => {
    const notes = locked(
      row({
        name: "notes",
        lockVersion: "1.0.0",
        providers: [
          file({
            path: "/work/.agents/skills/notes/SKILL.md",
            scope: "project",
            fileVersion: "1.1.0",
          }),
        ],
      }),
      "github:acme/skills",
    );
    expect(only(build([advertised("notes")], [notes]))).toMatchObject({
      version: { value: "1.1.0", source: "file", note: "locked v1.0.0" },
      detail: "Matching file · v1.1.0 · locked v1.0.0 · lock: acme/skills",
    });
  });

  it("does not settle on one file, or on none, when the scan could not open every folder", () => {
    const notes = row({
      name: "notes",
      providers: [
        file({
          path: "/work/.agents/skills/notes/SKILL.md",
          scope: "project",
          fileVersion: "1.0.0",
        }),
      ],
    });
    const partial = (rows: ProjectSkillRow[]) =>
      only(
        buildComposerSkillGroups({
          skills: [advertised("notes")],
          instanceId: "copilot",
          snapshot: {
            rows,
            providers: [
              {
                instanceId: "copilot",
                driver: "acpRegistry",
                label: "Copilot",
                state: "unsupported",
                skills: rows.length,
                incomplete: true,
              },
            ] as never,
          },
          uses: [],
        }),
      );
    expect(partial([notes])).toMatchObject({
      level: "several",
      levelLabel: "1 file found",
      version: { value: null, source: null },
      detail:
        "Found at Project v1.0.0. Some skill folders could not be opened, so another copy may exist.",
    });
    expect(partial([]).detail).toBe(
      "Listed by the agent. No file found, but some skill folders could not be opened.",
    );
    // A complete scan still settles on the one file.
    expect(only(build([advertised("notes")], [notes])).location.kind).toBe("matched");
  });

  it("opens Settings under the row's own name when the advertised name differs in case", () => {
    const unlocked = row({
      name: "notes",
      providers: [file({ path: "/work/.agents/skills/notes/SKILL.md", scope: "project" })],
    });
    expect(only(build([advertised("Notes")], [unlocked]))).toMatchObject({
      name: "Notes",
      settingsName: "notes",
      inSettings: true,
    });
    expect(only(build([advertised("notes")], [unlocked])).settingsName).toBeUndefined();
  });

  it("says when no lock of the file's own scope lists it", () => {
    const unlocked = row({
      name: "notes",
      providers: [file({ path: "/work/.agents/skills/notes/SKILL.md", scope: "project" })],
    });
    expect(only(build([advertised("notes")], [unlocked])).detail).toBe(
      "Matching file · no version · no lock entry",
    );
    // A user-scope lock says nothing about a project file.
    const foreign = locked(
      row({
        name: "notes",
        lockVersion: "2.0.0",
        providers: [file({ path: "/work/.agents/skills/notes/SKILL.md", scope: "project" })],
      }),
      "github:acme/skills",
      "user",
    );
    expect(only(build([advertised("notes")], [foreign])).detail).toBe(
      "Matching file · no version · no lock entry",
    );
  });

  it("reads Location unknown, never absent or a scope, when no file carries the name", () => {
    const item = only(build([advertised("ghost")], []));
    expect(item).toMatchObject({
      level: "unknown",
      levelLabel: "Location unknown",
      inSettings: false,
      location: { kind: "unknown" },
    });
    expect(item.detail).toMatch(/^Listed by the agent\./);
    expect(build([advertised("ghost")], []).map((group) => group.label)).toEqual([
      "Location unknown",
    ]);
  });

  it("never picks between two matching files", () => {
    const notes = row({
      name: "notes",
      providers: [
        file({
          path: "/work/.agents/skills/notes/SKILL.md",
          scope: "project",
          fileVersion: "1.2.0",
          otherCopies: [{ path: "/home/me/.agents/skills/notes/SKILL.md", scope: "user" }],
        }),
      ],
    });
    const item = only(build([advertised("notes")], [notes]));
    expect(item).toMatchObject({ level: "several", levelLabel: "2 matching files" });
    expect(item.version).toEqual({ value: null, source: null });
    expect(item.detail).toBe(
      "Found at Project v1.2.0, User. The agent does not report which it uses.",
    );
    expect(item.location).toMatchObject({ kind: "several" });
  });

  it("treats names that differ only in case as a collision, not as one file", () => {
    const rows = [
      row({
        name: "Notes",
        providers: [file({ path: "/work/.agents/skills/Notes/SKILL.md", scope: "project" })],
      }),
      row({
        name: "notes",
        providers: [file({ path: "/home/me/.agents/skills/notes/SKILL.md", scope: "user" })],
      }),
    ];
    expect(composerSkillFilesNamed({ rows }, "copilot", "notes")).toHaveLength(2);
    expect(only(build([advertised("notes")], rows)).level).toBe("several");
  });

  it("matches only this agent instance's files, and only the name that instance uses", () => {
    const rows = [
      // Another agent's file under the same name.
      row({
        name: "notes",
        providers: [
          file({
            instanceId: "claudeAgent",
            path: "/work/.claude/skills/notes/SKILL.md",
            scope: "project",
          }),
        ],
      }),
      // A row whose alias matches, but this agent lists the file under another name.
      row({
        name: "canonical",
        aliases: ["notes"],
        providers: [
          file({
            path: "/work/.agents/skills/canonical/SKILL.md",
            scope: "project",
            name: "other",
          }),
        ],
      }),
    ];
    expect(composerSkillFilesNamed({ rows }, "copilot", "notes")).toEqual([]);
    expect(only(build([advertised("notes")], rows)).level).toBe("unknown");
    // A second instance of the same agent, with its own home, has its own files.
    expect(composerSkillFilesNamed({ rows }, "claudeAgent", "notes")).toHaveLength(1);
  });

  it("claims nothing while the inventory loads, and nothing after it failed", () => {
    expect(only(build([advertised("notes")], null))).toMatchObject({
      level: "pending",
      levelLabel: "Checking…",
      version: null,
      inSettings: false,
    });
    const unread = only(build([advertised("notes")], null, { snapshotPending: false }));
    expect(unread).toMatchObject({ level: "unread", levelLabel: "Not checked", inSettings: false });
    expect(unread.detail).toMatch(/location is not known/);
  });

  it("finds a skill by the words of its detail line, such as its lock source", () => {
    const notes = locked(
      row({
        name: "notes",
        lockVersion: "1.0.0",
        providers: [file({ path: "/work/.agents/skills/notes/SKILL.md", scope: "project" })],
      }),
      "github:acme/skills",
    );
    const groups = build([advertised("notes"), advertised("ghost")], [notes], { query: "acme" });
    expect(groups.flatMap((group) => group.items).map((item) => item.name)).toEqual(["notes"]);
  });

  it("renders a payload without the new fields as before: no match by other copies", () => {
    const legacy = row({
      name: "notes",
      providers: [
        {
          ...presence({ instanceId: "copilot", path: "/work/.agents/skills/notes/SKILL.md" }),
          scope: "project",
        } as ProjectSkillRow["providers"][number],
      ],
    });
    const item = only(build([advertised("notes")], [legacy]));
    expect(item.location.kind).toBe("matched");
    expect(item.level).toBe("project");
  });
});

describe("pageComposerSkillGroups", () => {
  const many = (count: number, scope: string, prefix: string) =>
    Array.from({ length: count }, (_, index) =>
      skill({
        name: `${prefix}-${String(index + 1).padStart(2, "0")}`,
        scope,
        path: `/x/${scope}/skills/${prefix}-${index}/SKILL.md`,
      }),
    );
  const skills = [...many(15, "project", "proj"), ...many(30, "user", "user")];
  const groups = (query?: string) =>
    buildComposerSkillGroups({
      skills,
      instanceId: "claudeAgent",
      snapshot: null,
      uses: [],
      ...(query ? { query } : {}),
    });

  it("cuts pages across groups and keeps each group's whole count on its heading", () => {
    const first = pageComposerSkillGroups(groups(), 1);
    expect(COMPOSER_SKILLS_PAGE_SIZE).toBe(20);
    expect(first.page).toMatchObject({ page: 1, pageCount: 3, total: 45, from: 1, to: 20 });
    expect(first.groups.map((group) => [group.label, group.items.length, group.total])).toEqual([
      ["Project", 15, 15],
      ["User", 5, 30],
    ]);
    const second = pageComposerSkillGroups(groups(), 2);
    expect(second.groups.map((group) => [group.label, group.items.length, group.total])).toEqual([
      ["User", 20, 30],
    ]);
    expect(second.groups[0]!.items[0]!.name).toBe("user-06");
    expect(pageComposerSkillGroups(groups(), 3).page).toMatchObject({ from: 41, to: 45 });
  });

  it("searches every skill before paging, so a match on a later page is found", () => {
    const page = pageComposerSkillGroups(groups("user-29"), 1);
    expect(page.groups.flatMap((group) => group.items).map((item) => item.name)).toEqual([
      "user-29",
    ]);
    expect(page.page).toMatchObject({ total: 1, pageCount: 1 });
  });

  it("falls back to the last page when the list shrank under the current page", () => {
    expect(pageComposerSkillGroups(groups("proj"), 3).page).toMatchObject({ page: 1, total: 15 });
  });

  it("returns one empty page for no groups", () => {
    expect(pageComposerSkillGroups([], 1)).toMatchObject({ groups: [], page: { total: 0 } });
  });
});

describe("where the list comes from", () => {
  it("calls a list of advertised commands the agent's machine-wide list", () => {
    expect(
      composerSkillsListScope({
        skills: [{ path: "acp://command/notes" }],
        workspaceDiscovery: null,
      }),
    ).toBe("machine");
    expect(
      composerSkillsListScope({ skills: [{ path: "/x/SKILL.md" }], workspaceDiscovery: "machine" }),
    ).toBe("machine");
    expect(
      composerSkillsListScope({ skills: [{ path: "/x/SKILL.md" }], workspaceDiscovery: undefined }),
    ).toBe("folder");
  });

  it("says a machine-wide list was not checked for this folder", () => {
    expect(
      composerSkillsSourceLine({ agent: "Copilot", machine: "Desk", listScope: "machine" }),
    ).toBe(
      "Copilot's own list for Desk, not checked for this folder. Files, versions and locks come from the app's scan of its skill folders.",
    );
    expect(
      composerSkillsSourceLine({ agent: "Claude", machine: "Desk", listScope: "folder" }),
    ).toBe("Claude's own list for this folder.");
  });
});
