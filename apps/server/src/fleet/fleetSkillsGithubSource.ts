/**
 * Fleet skill installs from a GitHub repo (increment 1399, "Also add on").
 *
 * The fleet primary names one skill folder in one GitHub repo at one commit,
 * with the normalized SKILL.md hash it read there (`contentHash`). This
 * machine checks, before anything runs, that:
 *
 * - the same repo is connected here (Settings > Skills on this machine);
 * - this machine's own GitHub access reads that commit and finds the same
 *   SKILL.md (a private repo needs this machine's own `gh` sign-in; no token
 *   ever travels);
 * - no other source already installed a skill with that name here.
 *
 * It then runs one fixed argv, with no shell:
 *
 *   vskill install https://github.com/<repo>/tree/<commit>/<folder> -y [--global]
 *
 * or, with no vskill here (or one older than {@link GITHUB_SOURCE_MIN_VSKILL}),
 * `npx --yes vskill@latest` with the same arguments. vskill itself is never
 * installed here. A private source runs with vskill's registry pointed at a
 * closed local port. Success is the lock recording that commit and that hash;
 * vskill records the commit as the branch too, so the branch the primary
 * named is written back, and later updates compare against its head.
 *
 * Undo of a new install removes it with `vskill remove <name> --force`, and
 * only when the lock still records the copy this source installed. Undo of an
 * update is an install of the previous commit through the same checks.
 *
 * @module fleet/fleetSkillsGithubSource
 */
import { StudioFleetSkillError } from "@specweave-studio/contracts";
import type {
  StudioFleetSkillPrevious,
  StudioFleetSkillRefusal,
  StudioFleetSkillSource,
  StudioFleetSkillVia,
} from "@specweave-studio/contracts/studioFleet";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { parseVskillLock } from "../project/projectSkillsInventory.ts";
import type { SkillSourceRead } from "../project/SkillRepoSources.ts";
import { isVersionAtLeast } from "../project/SkillUpdate.ts";
import {
  type FleetSkillAsk,
  type FleetSkillRun,
  NPX_VSKILL_ARGS,
  runFailureText,
  skillLockName,
} from "./fleetSkills.ts";

/** The first vskill that installs a commit exactly and keeps private sources off its registry. */
export const GITHUB_SOURCE_MIN_VSKILL = "1.2.10";

const INSTALL_TIMEOUT = Duration.minutes(5);
const VERSION_TIMEOUT = Duration.seconds(20);
/** A local port nothing listens on: a registry call sent there fails at once. */
const CLOSED_ENDPOINT = "http://127.0.0.1:9";
const CONTENT_HASH = /^[0-9a-f]{64}$/;

export interface GithubSkillDeps {
  readonly home: string;
  readonly projectRoot: (projectId: string) => Effect.Effect<string | null>;
  readonly resolveVskill: Effect.Effect<string | null>;
  readonly resolveNpx: Effect.Effect<string | null>;
  readonly run: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly timeout: Duration.Duration;
    readonly env?: NodeJS.ProcessEnv;
  }) => Effect.Effect<FleetSkillRun>;
  /** The `owner/repo` ids connected on this machine. */
  readonly connectedRepos: Effect.Effect<ReadonlyArray<string>>;
  /** One SKILL.md read at one commit through this machine's own GitHub access. */
  readonly readSkill: (input: {
    readonly repo: string;
    readonly name: string;
    readonly path: string;
    readonly commit: string;
  }) => Effect.Effect<SkillSourceRead>;
  readonly readLockText: (file: string) => Effect.Effect<string | null>;
  /** Replaces the lock file's text atomically; false when it could not. */
  readonly writeLockText: (file: string, text: string) => Effect.Effect<boolean>;
  /** Whether any of these paths exists (a skill folder another tool owns). */
  readonly occupied: (paths: ReadonlyArray<string>) => Effect.Effect<boolean>;
  /** A digest of these destination files as they are now; refuses unsafe destinations. */
  readonly fingerprint: (input: {
    readonly ask: FleetSkillAsk;
    readonly root: string;
    readonly files: ReadonlyArray<string>;
  }) => Effect.Effect<string, StudioFleetSkillError>;
}

/**
 * This machine's connected repos and its own GitHub reads, for the fleet
 * worker. Absent in builds wired without it; the worker then refuses GitHub sources.
 */
export class FleetSkillGithubReads extends Context.Service<
  FleetSkillGithubReads,
  Pick<GithubSkillDeps, "connectedRepos" | "readSkill">
>()("specweave-studio/fleet/fleetSkillsGithubSource/FleetSkillGithubReads") {}

/** What was checked before the run, and what the run will do. */
export interface GithubSkillPlan {
  readonly repo: string;
  readonly name: string;
  readonly via: StudioFleetSkillVia;
  readonly command: string;
  readonly prefixArgs: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly lockPath: string;
  /** The copy from the same repo this replaces; null when the skill is new here. */
  readonly previous: StudioFleetSkillPrevious | null;
  /** The files the install writes or the removal takes away. */
  readonly files: ReadonlyArray<string>;
  readonly fingerprint: string;
  readonly removing: boolean;
}

export type GithubSkillRunResult =
  | {
      readonly ok: true;
      readonly installedVersion: string | null;
      readonly via: StudioFleetSkillVia;
      readonly previous: StudioFleetSkillPrevious | null;
      readonly removed: boolean;
    }
  | { readonly ok: false; readonly message: string };

const refuse = (reason: StudioFleetSkillRefusal, message: string) =>
  new StudioFleetSkillError({ reason, message });

const repoOf = (skill: string) => skill.split("/").slice(0, 2).join("/");
const folderOf = (source: StudioFleetSkillSource) => source.path.slice(0, -"/SKILL.md".length);

/** The one GitHub address vskill installs exactly this folder at exactly this commit from. */
export const githubSkillLink = (repo: string, source: StudioFleetSkillSource) =>
  `https://github.com/${repo}/tree/${source.commit}/${folderOf(source)}`;

interface LockedCopy {
  readonly version: string | null;
  readonly sha: string | null;
  readonly source: string | null;
  readonly path: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
}

const lockedCopy = (text: string | null, name: string): LockedCopy | null => {
  const entry = text === null ? undefined : parseVskillLock(text)?.get(name);
  return entry === undefined
    ? null
    : {
        version: entry.version,
        sha: entry.sha,
        source: entry.source,
        path: entry.sourceSkillPath ?? null,
        branch: entry.sourceBranch ?? null,
        commit: entry.sourceCommitSha ?? null,
      };
};

const sameRepo = (copy: LockedCopy, repo: string) =>
  copy.source?.toLowerCase() === `github:${repo}`.toLowerCase();

/** The lock text with `name`'s recorded branch set to `branch`, or null when it has no entry. */
export function lockWithBranch(text: string, name: string, branch: string): string | null {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(lock) || !isRecord(lock.skills) || !Object.hasOwn(lock.skills, name)) return null;
  const entry = lock.skills[name];
  if (!isRecord(entry)) return null;
  entry.sourceBranch = branch;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Everything checked before a GitHub-source install or removal runs; refuses with the reason. */
export const prepareGithubSkill = (deps: GithubSkillDeps, ask: FleetSkillAsk) =>
  Effect.gen(function* () {
    const source = ask.source;
    const name = skillLockName(ask.skill);
    const repo = repoOf(ask.skill);
    if (
      source === undefined ||
      !ask.contentHash ||
      !CONTENT_HASH.test(ask.contentHash) ||
      folderOf(source).split("/").at(-1) !== name ||
      ask.agents !== undefined
    )
      return yield* refuse(
        "invalid-skill",
        "Name the skill folder, its commit and its content hash in the same repo.",
      );
    let root = deps.home;
    if (ask.scope === "project") {
      const found = yield* deps.projectRoot(ask.projectId);
      if (found === null)
        return yield* refuse(
          "unknown-project",
          `This machine has no project ${ask.projectId}; name one of its own projects.`,
        );
      root = found;
    }
    const lockPath =
      ask.scope === "user" ? `${deps.home}/.agents/vskill.lock` : `${root}/vskill.lock`;
    const skillsDir =
      ask.scope === "user" ? `${deps.home}/.agents/skills` : `${root}/.agents/skills`;
    const claudeDir =
      ask.scope === "user" ? `${deps.home}/.claude/skills` : `${root}/.claude/skills`;
    const files = [`${skillsDir}/${name}/SKILL.md`, `${claudeDir}/${name}`, lockPath];
    const locked = lockedCopy(yield* deps.readLockText(lockPath), name);
    const removing = ask.action === "remove";

    if (removing) {
      if (locked === null || !sameRepo(locked, repo) || locked.sha !== ask.contentHash)
        return yield* refuse(
          "stale",
          `${name} changed on this machine since it was added, so Undo left it as it is.`,
        );
    } else {
      const connected = yield* deps.connectedRepos;
      if (!connected.some((entry) => entry.toLowerCase() === repo.toLowerCase()))
        return yield* refuse(
          "repo-not-connected",
          `${repo} is not connected on this machine. Connect it in its Skills settings first.`,
        );
      if (locked !== null ? !sameRepo(locked, repo) : yield* deps.occupied(files.slice(0, 2)))
        return yield* refuse(
          "name-taken",
          `Another skill named ${name} is already installed on this machine from somewhere else.`,
        );
      const read = yield* deps.readSkill({ repo, name, path: source.path, commit: source.commit });
      if (read.state === "needs-sign-in" || read.state === "not-found")
        return yield* refuse(
          "no-access",
          `This machine has no GitHub access to ${repo}. Sign in to GitHub on it with gh auth login.`,
        );
      if (read.state !== "ok")
        return yield* refuse(
          "install-failed",
          `GitHub could not be read from this machine (${read.state}). Try again later.`,
        );
      if (read.skill.contentHash !== ask.contentHash)
        return yield* refuse(
          "stale",
          `${repo} at ${source.commit.slice(0, 7)} does not hold the reviewed copy of ${name}.`,
        );
    }

    const installed = yield* deps.resolveVskill;
    const env: NodeJS.ProcessEnv = {
      VSKILL_NO_TELEMETRY: "1",
      // The registry is never asked about a GitHub source; a private one must not be named there.
      VSKILL_API_BASE: CLOSED_ENDPOINT,
      VSKILL_API_URL: CLOSED_ENDPOINT,
    };
    let runner: {
      command: string;
      prefixArgs: ReadonlyArray<string>;
      via: StudioFleetSkillVia;
    } | null = null;
    if (installed !== null) {
      const probe = yield* deps.run({
        command: installed,
        args: ["--version"],
        cwd: deps.home,
        timeout: VERSION_TIMEOUT,
        env,
      });
      if (probe.exitCode === 0 && isVersionAtLeast(probe.stdout, GITHUB_SOURCE_MIN_VSKILL))
        runner = { command: installed, prefixArgs: [], via: "vskill" };
    }
    if (runner === null) {
      const npx = yield* deps.resolveNpx;
      if (npx !== null) runner = { command: npx, prefixArgs: NPX_VSKILL_ARGS, via: "npx" };
    }
    if (runner === null)
      return yield* refuse(
        "vskill-missing",
        installed === null
          ? "Neither vskill nor npx is installed on this machine."
          : `vskill on this machine is older than ${GITHUB_SOURCE_MIN_VSKILL} and npx is missing. Update vskill there.`,
      );
    const previous: StudioFleetSkillPrevious | null =
      locked !== null && !removing && locked.version !== null
        ? {
            version: locked.version,
            commit: locked.commit,
            contentHash: locked.sha,
            branch: locked.branch,
            path: locked.path,
          }
        : null;
    // The preview and its apply must digest the same ask: neither flag is part of it.
    const { preview: _preview, expectedHash: _expected, ...reviewed } = ask;
    const fingerprint = yield* deps.fingerprint({
      ask: reviewed as FleetSkillAsk,
      root,
      files: [files[0]!, lockPath],
    });
    return {
      repo,
      name,
      via: runner.via,
      command: runner.command,
      prefixArgs: runner.prefixArgs,
      env,
      cwd: root,
      lockPath,
      previous,
      files,
      fingerprint,
      removing,
    } satisfies GithubSkillPlan;
  });

/**
 * The agents a GitHub-source install links: Claude through its skills folder,
 * Codex through ~/.agents/skills. Named, because vskill's "every agent" default
 * refuses the whole install when any one agent's skills folder is a link.
 */
export const GITHUB_SKILL_AGENTS = ["claude-code", "codex"] as const;

/** Runs the checked install or removal and reads the lock back; never fails, only reports. */
export const runGithubSkill = (
  deps: GithubSkillDeps,
  ask: FleetSkillAsk,
  plan: GithubSkillPlan,
): Effect.Effect<GithubSkillRunResult> =>
  Effect.gen(function* () {
    const source = ask.source!;
    const global = ask.scope === "user" ? ["--global"] : ["--local"];
    const args = plan.removing
      ? ["remove", plan.name, "--force", ...global]
      : [
          "install",
          githubSkillLink(plan.repo, source),
          "-y",
          ...(ask.scope === "user" ? ["--global"] : []),
          ...GITHUB_SKILL_AGENTS.flatMap((agent) => ["--agent", agent]),
        ];
    const run = yield* deps.run({
      command: plan.command,
      args: [...plan.prefixArgs, ...args],
      cwd: plan.cwd,
      timeout: INSTALL_TIMEOUT,
      env: plan.env,
    });
    const what = plan.removing ? "vskill remove" : "vskill install";
    if (run.timedOut || run.exitCode !== 0)
      return { ok: false as const, message: runFailureText(run, what) };
    const text = yield* deps.readLockText(plan.lockPath);
    const after = lockedCopy(text, plan.name);
    if (plan.removing)
      return after === null
        ? {
            ok: true as const,
            installedVersion: null,
            via: plan.via,
            previous: null,
            removed: true,
          }
        : {
            ok: false as const,
            message: `vskill finished, but its lock still lists ${plan.name}.`,
          };
    if (
      after === null ||
      !sameRepo(after, plan.repo) ||
      after.sha !== ask.contentHash ||
      after.commit !== source.commit ||
      after.path !== source.path
    )
      return {
        ok: false as const,
        message:
          after === null
            ? `vskill finished, but its lock has no entry for ${plan.name}.`
            : `vskill finished, but the lock records ${after.commit?.slice(0, 7) ?? "another copy"} from ${after.path ?? "an unknown path"}, not the reviewed ${source.commit.slice(0, 7)}.`,
      };
    // vskill records the commit as the branch; the branch goes back so updates compare its head.
    if (after.branch !== source.branch) {
      const next = text === null ? null : lockWithBranch(text, plan.name, source.branch);
      if (next === null || !(yield* deps.writeLockText(plan.lockPath, next)))
        return {
          ok: false as const,
          message: `${plan.name} was installed, but its branch could not be recorded in the lock.`,
        };
    }
    return {
      ok: true as const,
      installedVersion: after.version,
      via: plan.via,
      previous: plan.previous,
      removed: false,
    };
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({ ok: false as const, message: "The skill install stopped unexpectedly." }),
    ),
  );
