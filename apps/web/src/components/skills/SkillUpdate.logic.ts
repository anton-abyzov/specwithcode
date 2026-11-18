/**
 * Words and small decisions behind skill search, connected repos and updates
 * on one machine. Every phrase here is looked up by its English text.
 */
import type {
  EnvironmentId,
  ProjectId,
  ProjectSkillReadiness,
  ProjectSkillSourceStatus,
  ProjectSkillUpdateOutcome,
  ProjectSkillUpdateState,
  SkillRepoRefusalReason,
  ThreadId,
} from "@specweave-studio/contracts";

/** The machine and folder a skills view shows. */
export interface SkillFolderScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly userLevel?: boolean | undefined;
}

/** The folder part of a request, with nothing left undefined. */
export function skillFolderInput(scope: SkillFolderScope) {
  return {
    projectId: scope.projectId,
    ...(scope.cwd ? { cwd: scope.cwd } : {}),
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.userLevel ? { userLevel: true } : {}),
  };
}

export const SKILL_CHANGE_PERMISSION = "Needs permission to change files and run vskill here.";
export const SKILL_REPO_PERMISSION = "Needs permission to change settings on this machine.";

export const READINESS_LABELS: Readonly<Record<ProjectSkillReadiness, string>> = {
  "loaded-now": "Loaded now",
  "next-message": "Next message",
  "next-session": "Next session",
};

export const READINESS_VARIANTS: Readonly<
  Record<ProjectSkillReadiness, "success" | "info" | "outline">
> = {
  "loaded-now": "success",
  "next-message": "info",
  "next-session": "outline",
};

export const UPDATE_STATE_LABELS: Readonly<Record<ProjectSkillUpdateState, string>> = {
  current: "Up to date",
  update: "Update available",
  changed: "Changed at source",
  pinned: "Pinned",
  unsupported: "Not updated from here",
  "needs-sign-in": "Needs GitHub sign-in",
  unknown: "Not checked",
};

export const UPDATE_STATE_VARIANTS: Readonly<
  Record<ProjectSkillUpdateState, "success" | "info" | "warning" | "outline">
> = {
  current: "success",
  update: "info",
  changed: "info",
  pinned: "outline",
  unsupported: "outline",
  "needs-sign-in": "warning",
  unknown: "outline",
};

/** The sentence for a repo that could not be read; takes `{machine}` and `{repo}`. */
export const REPO_REFUSAL_PHRASES: Readonly<Record<SkillRepoRefusalReason, string>> = {
  invalid: "Name the repo as owner/repo or paste its GitHub link.",
  "needs-sign-in": "Sign in to GitHub on {machine} to read {repo}",
  "not-found": "GitHub has no {repo} for the account signed in on {machine}.",
  "rate-limited":
    "GitHub is limiting reads from {machine}. Sign in to GitHub there or try again later.",
  unreachable: "GitHub could not be reached from {machine}.",
};

/** What a run did to one skill; takes `{skill}` and `{version}`. */
export const OUTCOME_PHRASES: Readonly<Record<ProjectSkillUpdateOutcome["outcome"], string>> = {
  installed: "Installed {skill} {version}",
  updated: "Updated {skill} to {version}",
  current: "{skill} is already up to date",
  skipped: "Skipped {skill}",
  failed: "{skill} was not changed",
};

/** Whether Update does something for this skill. */
export function isSkillUpdatable(status: ProjectSkillSourceStatus): boolean {
  return status.state === "update" || status.state === "changed";
}

/** Agents to rescan after a run, each once, in the order the machine reported them. */
export function outcomeAgents(outcomes: ReadonlyArray<ProjectSkillUpdateOutcome>): string[] {
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.outcome === "failed" || outcome.outcome === "skipped") continue;
    for (const agent of outcome.readiness) seen.add(agent.instanceId);
  }
  return [...seen];
}
