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
  projectSkillFacets,
  projectSkillLevel,
  projectSkillLevelLabel,
  projectSkillLevels,
  projectSkillProviderBadges,
  projectSkillReadLines,
  projectSkillScopeChips,
  projectSkillSourceLinks,
  projectSkillStatusBadge,
  projectSkillTierLabel,
  projectSkillVersions,
  pickSkillsMember,
  withSelectedFacetOptions,
} from "./ProjectSkillsSettings.logic";

function presence(
  label: string,
  path: string,
  enabled = true,
  scope: string | null = "user",
): ProjectSkillPresence {
  return {
    instanceId: ProviderInstanceId.make(label.toLowerCase()),
    driver: ProviderDriverKind.make(label.toLowerCase()),
    label,
    path,
    scope,
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
    expect(badges[0]!.title).toBe("Claude\nUser: /a/SKILL.md\nUser: /b/SKILL.md");
    expect(badges[1]!.title).toBe("Codex (switched off)\nUser: /a/SKILL.md (off)");
  });
});

describe("agent, level and tier filters", () => {
  const mixed = [
    row("user-claude"),
    row("repo-codex", {
      scopes: ["repo"],
      providers: [presence("Codex", "/work/.agents/skills/repo-codex/SKILL.md", true, "repo")],
    }),
    row("both", {
      scopes: ["project", "user"],
      providers: [
        presence("Claude", "/work/.claude/skills/both/SKILL.md", true, "project"),
        presence("Codex", "/home/me/.agents/skills/both/SKILL.md", true, "user"),
      ],
      lock: {
        lockPath: "/work/vskill.lock",
        lockScope: "project",
        version: "1.0.0",
        tier: "verified",
        source: "github:acme/both",
        sha: null,
        installedAt: null,
      },
    }),
    row("lock-only", {
      status: "missing",
      providers: [],
      scopes: [],
      path: null,
      lock: {
        lockPath: "/home/me/.agents/vskill.lock",
        lockScope: "user",
        version: null,
        tier: null,
        source: "github:acme/ghost",
        sha: null,
        installedAt: null,
      },
    }),
  ];
  const names = (filter: Parameters<typeof filterProjectSkillRows>[1]) =>
    filterProjectSkillRows(mixed, filter).map((entry) => entry.name);
  const base = { query: "", problemsOnly: false };

  it("treats Codex repo skills as project level and lock-only rows at their lockfile level", () => {
    expect(projectSkillLevels(mixed[1]!)).toEqual(["project"]);
    expect(projectSkillLevels(mixed[3]!)).toEqual(["user"]);
  });

  it("filters by agent, by level, and by both on the same copy", () => {
    expect(names({ ...base, providers: ["codex"] })).toEqual(["repo-codex", "both"]);
    expect(names({ ...base, levels: ["project"] })).toEqual(["repo-codex", "both"]);
    expect(names({ ...base, levels: ["user"] })).toEqual(["user-claude", "both", "lock-only"]);
    // `both` has Claude at project level and Codex at user level, not Claude at user level.
    expect(names({ ...base, providers: ["claude"], levels: ["user"] })).toEqual(["user-claude"]);
    expect(names({ ...base, providers: ["claude", "codex"], levels: ["project"] })).toEqual([
      "repo-codex",
      "both",
    ]);
  });

  it("filters by tier, including skills vskill did not install", () => {
    expect(names({ ...base, tiers: ["VERIFIED"] })).toEqual(["both"]);
    expect(names({ ...base, tiers: ["unlocked"] })).toEqual(["user-claude", "repo-codex"]);
    expect(names({ ...base, tiers: ["untiered"] })).toEqual(["lock-only"]);
  });

  it("counts each chip option", () => {
    const facets = projectSkillFacets(mixed);
    expect(facets.providers.map((option) => [option.label, option.count])).toEqual([
      ["Claude", 2],
      ["Codex", 2],
    ]);
    expect(facets.levels.map((option) => [option.label, option.count])).toEqual([
      ["Project", 2],
      ["User", 3],
    ]);
    expect(facets.tiers.map((option) => [option.label, option.count])).toEqual([
      ["Verified", 1],
      ["No tier", 1],
      ["Not from vskill", 2],
    ]);
  });

  it("keeps a selected value no row has as a selected chip with count 0", () => {
    const codexOnly = projectSkillFacets([mixed[1]!]);
    const agents = withSelectedFacetOptions(codexOnly.providers, ["claudeAgent"], (value) =>
      value === "claudeAgent" ? "Claude" : value,
    );
    expect(agents.map((option) => [option.value, option.label, option.count])).toEqual([
      ["codex", "Codex", 1],
      ["claudeAgent", "Claude", 0],
    ]);
    // A value with no known label shows as itself; a value already offered is not repeated.
    expect(
      withSelectedFacetOptions(codexOnly.providers, ["codex", "mystery"], (value) => value).map(
        (option) => [option.label, option.count],
      ),
    ).toEqual([
      ["Codex", 1],
      ["mystery", 0],
    ]);
    expect(
      withSelectedFacetOptions(codexOnly.levels, ["plugin"], projectSkillLevelLabel).map(
        (option) => [option.label, option.count],
      ),
    ).toEqual([
      ["Project", 1],
      ["Plugin", 0],
    ]);
    expect(
      withSelectedFacetOptions(codexOnly.tiers, ["VERIFIED"], projectSkillTierLabel).map(
        (option) => [option.label, option.count],
      ),
    ).toEqual([
      ["Not from vskill", 1],
      ["Verified", 0],
    ]);
    expect(withSelectedFacetOptions(codexOnly.tiers, [], projectSkillTierLabel)).toBe(
      codexOnly.tiers,
    );
  });
});

describe("projectSkillSourceLinks", () => {
  const locked = (name: string, source: string, tier: string | null = "VERIFIED") =>
    row(name, {
      lock: {
        lockPath: "/home/me/.agents/vskill.lock",
        lockScope: "user",
        version: "1.0.0",
        tier,
        source,
        sha: null,
        installedAt: null,
      },
    });

  it("links a GitHub source to its repository and its verified-skill.com page", () => {
    expect(
      projectSkillSourceLinks(locked("excalidraw-skill", "github:yctimlin/mcp_excalidraw")),
    ).toEqual({
      label: "yctimlin/mcp_excalidraw",
      repoUrl: "https://github.com/yctimlin/mcp_excalidraw",
      registryUrl: "https://verified-skill.com/skills/yctimlin/mcp_excalidraw/excalidraw-skill",
    });
  });

  it("uses the plugin name for marketplace sources and the skill name for plugin skills", () => {
    expect(
      projectSkillSourceLinks(locked("frontend:build", "marketplace:anton-abyzov/vskill#frontend")),
    ).toEqual({
      label: "anton-abyzov/vskill #frontend",
      repoUrl: "https://github.com/anton-abyzov/vskill",
      registryUrl: "https://verified-skill.com/skills/anton-abyzov/vskill/frontend",
    });
    expect(
      projectSkillSourceLinks(
        locked("nanobanana", "github:resciencelab/opc-skills#plugin:nanobanana"),
      )?.registryUrl,
    ).toBe("https://verified-skill.com/skills/resciencelab/opc-skills/nanobanana");
  });

  it("skips the registry link without a tier and leaves unknown sources as text", () => {
    expect(projectSkillSourceLinks(locked("x", "github:acme/x", null))?.registryUrl).toBeNull();
    expect(projectSkillSourceLinks(locked("x", "local:/opt/skills/x"))).toEqual({
      label: "local:/opt/skills/x",
      repoUrl: null,
      registryUrl: null,
    });
    expect(projectSkillSourceLinks(row("x"))).toBeNull();
  });
});

describe("versions, levels and labels", () => {
  const lock = {
    lockPath: "/home/me/.agents/vskill.lock",
    lockScope: "user" as const,
    version: "1.0.0",
    tier: "VERIFIED",
    source: "github:owner/repo",
    sha: null,
    installedAt: null,
  };

  it("shows the file version beside the lock and flags a lock out of date", () => {
    const current = row("gws", {
      lock,
      providers: [
        { ...presence("Claude", "/home/me/.claude/skills/gws/SKILL.md"), fileVersion: "1.0.0" },
      ],
    });
    expect(projectSkillVersions(current)).toEqual({
      lock: "1.0.0",
      files: [{ version: "1.0.0", labels: ["Claude"] }],
      lockOutOfDate: false,
      differ: false,
    });
    const behind = row("obsidian-brain", {
      lock,
      providers: [
        {
          ...presence("Claude", "/home/me/.claude/skills/obsidian-brain/SKILL.md"),
          fileVersion: "1.1.0",
        },
        {
          ...presence("Codex", "/home/me/.agents/skills/obsidian-brain/SKILL.md"),
          fileVersion: "1.1.0",
        },
      ],
    });
    expect(projectSkillVersions(behind)).toMatchObject({
      files: [{ version: "1.1.0", labels: ["Claude", "Codex"] }],
      lockOutOfDate: true,
    });
    expect(filterProjectSkillRows([behind], { query: "1.1.0", problemsOnly: false })).toHaveLength(
      1,
    );
  });

  it("prefers the plugin manifest version and reads different versions on a duplicate", () => {
    const skew = row("sw:do", {
      status: "duplicate",
      attention: true,
      divergent: true,
      providers: [
        {
          ...presence(
            "Claude",
            "/home/me/.claude/plugins/cache/specweave/sw/3.0.23/skills/do/SKILL.md",
          ),
          fileVersion: "3.0.0",
          pluginVersion: "3.0.23",
        },
        {
          ...presence(
            "Codex",
            "/home/me/.codex/plugins/cache/specweave/sw/3.0.20/skills/do/SKILL.md",
          ),
          fileVersion: "3.0.0",
          pluginVersion: "3.0.20",
        },
      ],
    });
    expect(projectSkillVersions(skew).files.map((file) => file.version)).toEqual([
      "3.0.23",
      "3.0.20",
    ]);
    expect(projectSkillStatusBadge(skew)).toEqual({
      label: "different versions",
      variant: "error",
    });
    expect(projectSkillStatusBadge({ ...skew, providers: [skew.providers[0]!] })).toEqual({
      label: "duplicate",
      variant: "error",
    });
  });

  it("normalises the level by path and labels bundled and system skills", () => {
    expect(
      projectSkillLevel(
        "user",
        "/home/me/.codex/plugins/cache/specweave/sw/3.0.20/skills/do/SKILL.md",
      ),
    ).toBe("plugin");
    expect(projectSkillLevel("user", "/home/me/.agents/skills/gws/SKILL.md")).toBe("user");
    expect(projectSkillLevel("bundled")).toBe("bundled");
    expect(projectSkillLevelLabel("bundled")).toBe("Bundled");
    expect(projectSkillLevelLabel("system")).toBe("System");
    const pluginCopy = row("sw:do", {
      providers: [
        presence("Codex", "/home/me/.codex/plugins/cache/specweave/sw/3.0.20/skills/do/SKILL.md"),
      ],
    });
    expect(projectSkillLevels(pluginCopy)).toEqual(["plugin"]);
    const facets = projectSkillFacets([
      pluginCopy,
      row("pdf", {
        providers: [
          presence("Grok", "/home/me/.grok/bundled/skills/pdf/SKILL.md", true, "bundled"),
        ],
      }),
      row("imagegen", {
        providers: [
          presence("Codex", "/home/me/.codex/skills/.system/imagegen/SKILL.md", true, "system"),
        ],
      }),
    ]);
    expect(facets.levels.map((option) => option.label)).toEqual(["Plugin", "Bundled", "System"]);
  });

  it("labels stale lock entries without attention and marks agent-only copies", () => {
    expect(
      projectSkillStatusBadge(
        row("resume-tailoring-skill", { status: "missing", staleLock: true, providers: [], lock }),
      ),
    ).toEqual({ label: "stale lock entry", variant: "secondary" });
    const hidden = row("pdf", {
      providers: [
        {
          ...presence("Grok", "/home/me/.grok/bundled/skills/pdf/SKILL.md", true, "bundled"),
          userInvocable: false,
        },
      ],
    });
    const [badge] = projectSkillProviderBadges(hidden);
    expect(badge).toMatchObject({ enabled: true, agentOnly: true });
    expect(badge?.title).toContain("not in its slash menu");
  });
});

describe("pickSkillsMember", () => {
  const offline = { environmentId: "m3", physicalProjectKey: "m3:fleet" };
  const local = { environmentId: "m4", physicalProjectKey: "m4:easychamp" };
  const connected = { environmentId: "ministorm", physicalProjectKey: "ministorm:easychamp" };
  const isConnected = (id: string) => id === "m4" || id === "ministorm";
  const base = { machine: null, checkout: undefined, primaryEnvironmentId: "m4", isConnected };

  it("reads this Mac's copy with All environments, even when an offline copy is listed first", () => {
    expect(pickSkillsMember([offline, connected, local], base)).toBe(local);
  });

  it("falls back to a connected machine when this Mac has no copy", () => {
    expect(pickSkillsMember([offline, connected], base)).toBe(connected);
  });

  it("keeps a machine the user picked, even when it is offline", () => {
    expect(pickSkillsMember([local, offline], { ...base, machine: "m3" })).toBe(offline);
  });

  it("keeps a picked checkout", () => {
    expect(pickSkillsMember([local, offline], { ...base, checkout: "m3:fleet" })).toBe(offline);
  });

  it("returns null when nothing matches", () => {
    expect(pickSkillsMember([local], { ...base, machine: "m1" })).toBeNull();
  });
});

describe("scope chips", () => {
  it("lists each level once, project first, and marks a level only a lower-priority copy has", () => {
    const both = row("notes", {
      providers: [
        presence("Claude", "/home/me/.claude/skills/notes/SKILL.md", true, "user"),
        {
          ...presence("Copilot", "/work/.agents/skills/notes/SKILL.md", true, "project"),
          otherCopies: [
            { path: "/home/me/.agents/skills/notes/SKILL.md", scope: "user" },
            { path: "/home/me/.claude/plugins/cache/x/skills/notes/SKILL.md", scope: "user" },
          ],
        },
      ],
    });
    expect(projectSkillScopeChips(both)).toEqual([
      { level: "project", label: "Project", alsoFound: false },
      // An agent lists a user copy itself, so that level is not "also found".
      { level: "user", label: "User", alsoFound: false },
      { level: "plugin", label: "Plugin", alsoFound: true },
    ]);
  });

  it("counts a lock-only row at its lock's level and a plain row at its own", () => {
    expect(projectSkillScopeChips(row("deploy"))).toEqual([
      { level: "user", label: "User", alsoFound: false },
    ]);
    const lockOnly = row("ghost", {
      providers: [],
      lock: {
        lockPath: "/work/vskill.lock",
        lockScope: "project",
        version: "1.0.0",
        tier: null,
        source: null,
        sha: null,
        installedAt: null,
      },
    });
    expect(projectSkillScopeChips(lockOnly)).toEqual([
      { level: "project", label: "Project", alsoFound: false },
    ]);
  });
});

describe("agent badges and discovery", () => {
  it("marks a badge whose every copy the app found by scanning, with what that means", () => {
    const scanned = row("notes", {
      providers: [
        {
          ...presence("Copilot", "/work/.agents/skills/notes/SKILL.md", true, "project"),
          discovery: "folder-scan",
          otherCopies: [{ path: "/home/me/.agents/skills/notes/SKILL.md", scope: "user" }],
        },
        presence("Claude", "/work/.claude/skills/notes/SKILL.md", true, "project"),
      ],
    });
    const [claude, copilot] = projectSkillProviderBadges(scanned).toSorted((a, b) =>
      a.label.localeCompare(b.label),
    );
    expect(claude).toMatchObject({ label: "Claude", folderScan: false });
    expect(claude!.title).not.toMatch(/scan/);
    expect(copilot).toMatchObject({ label: "Copilot", folderScan: true });
    expect(copilot!.title.split("\n")).toEqual([
      "Copilot",
      "Project: /work/.agents/skills/notes/SKILL.md",
      "Also found, User: /home/me/.agents/skills/notes/SKILL.md",
      "Found by the app's scan of Copilot's skill folders. Copilot's own list is not checked for this folder.",
      "The first file is the one the app's scan order puts first. Copilot does not report which copy it uses.",
    ]);
  });
});

describe("agent read lines", () => {
  const provider = (label: string, extra: Record<string, unknown>) => ({
    instanceId: ProviderInstanceId.make(label.toLowerCase()),
    driver: ProviderDriverKind.make(label.toLowerCase()),
    label,
    state: "ok" as const,
    skills: 1,
    ...extra,
  });
  it("gives no line to an agent that was read in full", () => {
    expect(projectSkillReadLines({ providers: [provider("Claude", {})], rows: [] })).toEqual([]);
  });

  it("says a folder was scanned even when the scan found no skill in it", () => {
    const lines = projectSkillReadLines({
      providers: [
        provider("Copilot", { state: "unsupported", skills: 0, discovery: "folder-scan" }),
        provider("Grok", { state: "unsupported" }),
      ],
      rows: [],
    });
    expect(lines.map((line) => [line.label, line.kind])).toEqual([
      ["Copilot", "note"],
      ["Grok", "note"],
    ]);
    expect(lines[0]!.text).toMatch(/not checked for this folder/);
    expect(lines[0]!.text).not.toBe(lines[1]!.text);
  });

  it("puts agents that could not answer first, and never says a skill is absent", () => {
    const scanned = row("notes", {
      providers: [
        {
          ...presence("Copilot", "/work/.agents/skills/notes/SKILL.md", true, "project"),
          discovery: "folder-scan",
        },
      ],
    });
    const lines = projectSkillReadLines({
      providers: [
        provider("Copilot", { state: "unsupported" }),
        provider("Grok", { state: "unsupported" }),
        provider("Codex", { state: "timeout" }),
        provider("Cursor", { state: "error", message: "Not installed." }),
        provider("Gemini", { state: "unsupported", incomplete: true }),
        provider("Pi", { state: "cached" }),
        provider("Claude", {}),
      ],
      rows: [scanned],
    });
    expect(lines.map((line) => [line.label, line.kind])).toEqual([
      ["Codex", "partial"],
      ["Cursor", "partial"],
      ["Gemini", "partial"],
      ["Pi", "partial"],
      ["Copilot", "note"],
      ["Grok", "note"],
    ]);
    const text = (label: string) => lines.find((line) => line.label === label)!.text;
    expect(text("Codex")).toBe(
      "The folder scan did not finish. A skill it does not show here may still be installed.",
    );
    expect(text("Cursor")).toBe(
      "Could not be read (Not installed). A skill it does not show here may still be installed.",
    );
    expect(text("Gemini")).toMatch(/^Some of its skill folders could not be opened\./);
    expect(text("Copilot")).toMatch(/not checked for this folder/);
    expect(text("Grok")).toBe(
      "Reports one skill list for the whole machine, not one for this folder.",
    );
    expect(lines.map((line) => line.text).join(" ")).not.toMatch(
      /not installed here|absent|not listed/i,
    );
  });
});
