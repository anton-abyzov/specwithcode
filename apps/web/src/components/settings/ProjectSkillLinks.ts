/**
 * Links for one skill in Settings > Skills: its source file on GitHub, its
 * verified-skill.com page and versions, and where Skill Studio files it.
 * Everything is built from the row the server read; nothing is fetched.
 */
import type { ProjectSkillPresence, ProjectSkillRow } from "@specweave-studio/contracts";

import { projectSkillLevel, projectSkillSourceLinks } from "./ProjectSkillsSettings.logic";

export const VERIFIED_SKILL_ORIGIN = "https://verified-skill.com";

const GITHUB_REPO_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const SKILL_ID = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)$/;

export interface ProjectSkillLinks {
  /** The SKILL.md in its repository, else the repository itself. */
  readonly sourceUrl: string | null;
  /** True when {@link sourceUrl} points at the file, not just the repository. */
  readonly sourceIsFile: boolean;
  readonly repoUrl: string | null;
  /** `https://verified-skill.com/skills/{owner}/{repo}/{skill}`, each segment encoded. */
  readonly registryUrl: string | null;
  readonly versionsUrl: string | null;
  /** `owner/repo/name` for vskill and fleet installs; null for a local skill. */
  readonly skillId: string | null;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
}

/** The registry page for `owner/repo/name`. */
export function verifiedSkillUrl(skillId: string): string | null {
  const match = SKILL_ID.exec(skillId);
  if (!match) return null;
  return `${VERIFIED_SKILL_ORIGIN}/skills/${match
    .slice(1, 4)
    .map((segment) => encodeURIComponent(segment!))
    .join("/")}`;
}

/**
 * Source file: `{repo}/blob/{commit|branch|HEAD}/{sourceSkillPath}`, falling
 * back to the repository. Registry: the 3-segment page, only for skills
 * vskill installed with a tier (others have no page), plus `/versions`.
 */
export function projectSkillLinks(row: ProjectSkillRow): ProjectSkillLinks {
  const lock = row.lock;
  const parsed = projectSkillSourceLinks(row);
  const lockRepo = lock?.sourceRepoUrl?.trim() ?? "";
  const repoMatch = GITHUB_REPO_URL.exec(lockRepo);
  const repoUrl = repoMatch
    ? `https://github.com/${repoMatch[1]}/${repoMatch[2]}`
    : (parsed?.repoUrl ?? null);
  const ref = [lock?.sourceCommitSha, lock?.sourceBranch]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "" && GIT_REF.test(value) && !value.includes(".."));
  const skillPath = lock?.sourceSkillPath ? encodePath(lock.sourceSkillPath.trim()) : "";
  const sourceIsFile = repoUrl !== null && repoUrl.startsWith("https://github.com/") && !!skillPath;
  const sourceUrl = sourceIsFile
    ? `${repoUrl}/blob/${encodePath(ref ?? "HEAD")}/${skillPath}`
    : repoUrl;
  const skillId = lock?.skillId?.trim() || null;
  const registryUrl = lock?.tier
    ? ((skillId ? verifiedSkillUrl(skillId) : null) ?? parsed?.registryUrl ?? null)
    : null;
  return {
    sourceUrl,
    sourceIsFile,
    repoUrl,
    registryUrl,
    versionsUrl: registryUrl ? `${registryUrl}/versions` : null,
    skillId: skillId && SKILL_ID.test(skillId) ? skillId : null,
  };
}

export interface ProjectSkillStudioTarget {
  readonly source: "project" | "personal" | "plugin";
  /** Studio's group: the plugin, or the agent folder such as `.claude`. */
  readonly plugin: string;
  readonly skill: string;
}

const STUDIO_PLUGIN = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,198}$/;
const STUDIO_SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Where Skill Studio lists the copy this agent loads, as Studio's scanner names it. */
export function projectSkillStudioTarget(
  presence: Pick<ProjectSkillPresence, "path" | "scope">,
): ProjectSkillStudioTarget | null {
  const parts = presence.path.split(/[\\/]/).filter(Boolean);
  if (parts.at(-1) !== "SKILL.md" || parts.length < 3) return null;
  const skill = parts.at(-2)!;
  const cache = parts.lastIndexOf("cache");
  let target: ProjectSkillStudioTarget | null = null;
  if (cache > 0 && parts[cache - 1] === "plugins" && parts.length > cache + 2) {
    target = { source: "plugin", plugin: parts[cache + 2]!, skill };
  } else if (parts.at(-3) === "skills" && parts.length >= 4) {
    const level = projectSkillLevel(presence.scope, presence.path);
    target = {
      source: level === "project" ? "project" : "personal",
      plugin: parts.at(-4)!,
      skill,
    };
  }
  if (!target || !STUDIO_PLUGIN.test(target.plugin) || !STUDIO_SKILL.test(target.skill))
    return null;
  return target;
}
