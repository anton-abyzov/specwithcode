import type { ProjectSkillLock, ProjectSkillRow } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectSkillLinks, projectSkillStudioTarget, verifiedSkillUrl } from "./ProjectSkillLinks";

function rowWith(lock: Partial<ProjectSkillLock> | null, name = "deploy"): ProjectSkillRow {
  return {
    name,
    status: "ok",
    attention: false,
    issues: [],
    path: null,
    scopes: [],
    providers: [],
    lock:
      lock === null
        ? null
        : {
            lockPath: "/work/app/vskill.lock",
            lockScope: "project",
            version: "1.2.0",
            tier: "VERIFIED",
            source: "github:acme/tools",
            sha: null,
            installedAt: null,
            ...lock,
          },
    drift: "match",
    copies: 1,
    divergent: false,
    doctor: [],
  };
}

describe("projectSkillLinks", () => {
  it("opens the SKILL.md at the locked commit, else the branch, else HEAD", () => {
    const base = {
      sourceRepoUrl: "https://github.com/acme/tools",
      sourceSkillPath: "skills/deploy/SKILL.md",
    };
    expect(
      projectSkillLinks(rowWith({ ...base, sourceCommitSha: "abc123", sourceBranch: "main" }))
        .sourceUrl,
    ).toBe("https://github.com/acme/tools/blob/abc123/skills/deploy/SKILL.md");
    expect(projectSkillLinks(rowWith({ ...base, sourceBranch: "release/2" })).sourceUrl).toBe(
      "https://github.com/acme/tools/blob/release/2/skills/deploy/SKILL.md",
    );
    const head = projectSkillLinks(rowWith(base));
    expect(head.sourceUrl).toBe("https://github.com/acme/tools/blob/HEAD/skills/deploy/SKILL.md");
    expect(head.sourceIsFile).toBe(true);
  });

  it("falls back to the repository without a skill path, and ignores unsafe refs", () => {
    const repoOnly = projectSkillLinks(rowWith({}));
    expect(repoOnly.sourceUrl).toBe("https://github.com/acme/tools");
    expect(repoOnly.sourceIsFile).toBe(false);
    expect(
      projectSkillLinks(
        rowWith({
          sourceRepoUrl: "https://github.com/acme/tools.git",
          sourceSkillPath: "../skills/a b/SKILL.md",
          sourceBranch: "../../evil",
        }),
      ).sourceUrl,
    ).toBe("https://github.com/acme/tools/blob/HEAD/skills/a%20b/SKILL.md");
    expect(projectSkillLinks(rowWith(null)).sourceUrl).toBeNull();
  });

  it("builds the encoded 3-segment registry page and its versions page", () => {
    const links = projectSkillLinks(rowWith({ skillId: "acme/tools/deploy" }, "sw:deploy"));
    expect(links.registryUrl).toBe("https://verified-skill.com/skills/acme/tools/deploy");
    expect(links.versionsUrl).toBe("https://verified-skill.com/skills/acme/tools/deploy/versions");
    expect(links.skillId).toBe("acme/tools/deploy");
    expect(verifiedSkillUrl("acme/tools/sw:do")).toBe(
      "https://verified-skill.com/skills/acme/tools/sw%3Ado",
    );
    expect(verifiedSkillUrl("acme/deploy")).toBeNull();
  });

  it("has no registry page for a skill vskill installed without a tier", () => {
    const links = projectSkillLinks(rowWith({ tier: null, skillId: "acme/tools/deploy" }));
    expect(links.registryUrl).toBeNull();
    expect(links.versionsUrl).toBeNull();
    // It still has registry versions to change to.
    expect(links.skillId).toBe("acme/tools/deploy");
  });
});

describe("projectSkillStudioTarget", () => {
  it("names the agent folder for project and user skills, and the plugin for cached plugins", () => {
    expect(
      projectSkillStudioTarget({
        path: "/work/app/.claude/skills/deploy/SKILL.md",
        scope: "project",
      }),
    ).toEqual({ source: "project", plugin: ".claude", skill: "deploy" });
    expect(
      projectSkillStudioTarget({ path: "/home/me/.agents/skills/gws/SKILL.md", scope: "user" }),
    ).toEqual({ source: "personal", plugin: ".agents", skill: "gws" });
    expect(
      projectSkillStudioTarget({
        path: "/home/me/.claude/plugins/cache/specweave/sw/1.0.0/skills/do/SKILL.md",
        scope: "user",
      }),
    ).toEqual({ source: "plugin", plugin: "sw", skill: "do" });
  });

  it("refuses paths it cannot place", () => {
    expect(projectSkillStudioTarget({ path: "/work/app/SKILL.md", scope: "project" })).toBeNull();
    expect(
      projectSkillStudioTarget({ path: "/work/app/notes/deploy/README.md", scope: "project" }),
    ).toBeNull();
    expect(
      projectSkillStudioTarget({ path: "/work/app/-x/skills/deploy/SKILL.md", scope: "project" }),
    ).toBeNull();
  });
});
