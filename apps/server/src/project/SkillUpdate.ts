/**
 * SkillUpdate — installed against latest for every skill a vskill lock
 * tracks, updates from each skill's recorded source, installs from a
 * connected repo, and each agent's readiness afterwards.
 *
 * "Latest" is the skill's SKILL.md at its source's head, read by
 * `SkillRepoSources`. The file's hash decides, not the commit: the lock's
 * `sourceCommitSha` is the repo's head at install time, so comparing commits
 * would flag every skill whenever its repo gains any commit. The same version
 * with other content therefore counts as different.
 *
 * An update or install is one vskill run with a fixed argv and no shell:
 *
 *   vskill install <owner>/<repo>/<name> -y [--global]
 *
 * It is the same command for both, because vskill's own `update` rewrites
 * only SKILL.md and exits 0 when it fetched nothing. The argv carries no
 * `@version`, which vskill would resolve on its registry. The result is read
 * back from the lock vskill wrote, never from its output. A pinned skill is
 * left alone: a reinstall would drop the pin.
 *
 * A source GitHub does not confirm as public is treated as private: the run
 * gets vskill's registry endpoints pointed at a closed local port, and a
 * vskill older than {@link PRIVATE_SOURCE_MIN_VSKILL} is refused, since it
 * could name the skill to the registry.
 *
 * Readiness extends the installed-versus-ready readback of the Skills view:
 * after a run the agents scan again and each agent's own list answers.
 *
 * @module project/SkillUpdate
 */
import {
  compareSkillSourceVersions,
  ProjectSkillsActionError,
  skillRepoRefusalMessage,
  type ProjectId,
  type ProjectSkillAgentReadiness,
  type ProjectSkillLock,
  type ProjectSkillRepo,
  type ProjectSkillRow,
  type ProjectSkillSourceStatus,
  type ProjectSkillSourceVersion,
  type ProjectSkillsSnapshot,
  type ProjectSkillsUpdateInput,
  type ProjectSkillsUpdateResult,
  type ProjectSkillUpdateOutcome,
  type ProviderInstanceId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import {
  actionError,
  outputTail,
  type RunCli,
  VSKILL_MISSING,
} from "./ProjectSkillsActionsCommon.ts";
import { parseVskillLock } from "./projectSkillsInventory.ts";
import type { SkillRepoSources, SkillSourceRead } from "./SkillRepoSources.ts";

const INSTALL_TIMEOUT = "180 seconds";
const VERSION_TIMEOUT = "20 seconds";
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const SOURCE_READS_AT_ONCE = 4;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** The first vskill that keeps a private source's skills off its registry in every step. */
export const PRIVATE_SOURCE_MIN_VSKILL = "1.2.10";

/** A local port nothing listens on: a registry call sent there fails at once. */
const CLOSED_ENDPOINT = "http://127.0.0.1:9";

interface SkillsFolder {
  readonly projectId: ProjectId;
  readonly cwd?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly userLevel?: boolean | undefined;
}

export interface SkillUpdatesDeps {
  readonly home: string;
  /** The server's environment; its `PATH` is handed to vskill. */
  readonly environment: NodeJS.ProcessEnv;
  /** The folder's skills as the Skills view reads them; `refresh` makes every agent scan again. */
  readonly readSnapshot: (
    input: SkillsFolder & { readonly refresh?: boolean },
  ) => Effect.Effect<ProjectSkillsSnapshot, ProjectSkillsActionError>;
  readonly resolveCwd: (input: SkillsFolder) => Effect.Effect<string, ProjectSkillsActionError>;
  readonly invalidate: (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
  }) => Effect.Effect<void>;
  readonly sources: Pick<SkillRepoSources, "readSkill" | "connected">;
  readonly findVskill: Effect.Effect<string | null>;
  readonly run: RunCli;
  /** Asks these agents to scan the other folders threads have open, so each composer offers the skill. */
  readonly rescanOpenFolders: (
    instanceIds: ReadonlyArray<ProviderInstanceId>,
  ) => Effect.Effect<void>;
}

const rowNamed = (snapshot: ProjectSkillsSnapshot, skill: string): ProjectSkillRow | undefined =>
  snapshot.rows.find((row) => row.name === skill) ??
  snapshot.rows.find((row) => row.aliases?.includes(skill));

/**
 * When each agent on this machine has the skill, from the scan made after
 * the change. Codex answers from its app server's own skill list. Claude Code
 * has no live list (the app mirrors its folders), so it reads "next session";
 * no running session reports its skills to the app today. Any other agent
 * whose fresh scan holds the skill reads it with its next message. An agent
 * that did not answer, or does not list the skill, is never called ready.
 */
export function skillReadiness(
  snapshot: ProjectSkillsSnapshot,
  skill: string,
): ReadonlyArray<ProjectSkillAgentReadiness> {
  const row = rowNamed(snapshot, skill);
  return snapshot.providers
    .filter((provider) => provider.state !== "unsupported")
    .map((provider): ProjectSkillAgentReadiness => {
      const base = {
        instanceId: provider.instanceId,
        driver: provider.driver,
        label: provider.label,
      };
      const listed =
        row?.providers.some((presence) => presence.instanceId === provider.instanceId) === true;
      if (provider.driver === "claudeAgent")
        return {
          ...base,
          readiness: "next-session",
          detail: listed
            ? "Claude Code reads its skills when a session starts."
            : "Claude Code does not have this skill in its folders.",
        };
      if (provider.state !== "ok")
        return {
          ...base,
          readiness: "next-session",
          detail: `${provider.label} did not answer the scan, so this is not confirmed.`,
        };
      if (!listed)
        return {
          ...base,
          readiness: "next-session",
          detail: `${provider.label} does not list this skill.`,
        };
      return provider.driver === "codex"
        ? { ...base, readiness: "loaded-now", detail: "Codex's own skill list reports it." }
        : {
            ...base,
            readiness: "next-message",
            detail: `${provider.label}'s skill folders hold it.`,
          };
    });
}

/** `owner/repo` when the lock records a plain GitHub source this page can reinstall from. */
function lockRepo(lock: ProjectSkillLock): string | null {
  const match = /^github:([^/#\s]+\/[^/#\s]+?)(?:\.git)?$/.exec(lock.source ?? "");
  return match && lock.skillId && lock.name && lock.skillId === `${match[1]}/${lock.name}`
    ? match[1]!
    : null;
}

function unsupportedReason(lock: ProjectSkillLock): string {
  const source = lock.source ?? "";
  if (/#plugin:|^marketplace:|^github-plugin:/.test(source))
    return "Installed as part of a plugin. Update the plugin instead.";
  if (source.startsWith("hosted-private:"))
    return "Hosted on the skill registry. Update it with vskill.";
  if (source.startsWith("local:")) return "Installed from a folder on this machine.";
  return "The lock records no GitHub repo for this skill.";
}

const installedOf = (lock: ProjectSkillLock): ProjectSkillSourceVersion => ({
  version: lock.version,
  commit: lock.sourceCommitSha ?? null,
  contentHash: lock.sha !== null && CONTENT_HASH.test(lock.sha) ? lock.sha : null,
});

const parseVersion = (text: string): readonly [number, number, number] | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** Whether `version` is at least `minimum`, both `X.Y.Z`. */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (have === null || need === null) return false;
  for (let index = 0; index < 3; index += 1)
    if (have[index] !== need[index]) return have[index]! > need[index]!;
  return true;
}

interface Tracked {
  readonly status: ProjectSkillSourceStatus;
  readonly lock: ProjectSkillLock;
  readonly repo: string | null;
  /** Null until GitHub has confirmed it; then treated as private. */
  readonly visibility: "public" | "private" | null;
}

export const makeSkillUpdates = Effect.fn("SkillUpdates.make")(function* (deps: SkillUpdatesDeps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writes = yield* Semaphore.make(1);
  const userLockPath = path.join(deps.home, ".agents", "vskill.lock");

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );

  const folderOf = (input: ProjectSkillsUpdateInput): SkillsFolder => ({
    projectId: input.projectId,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.userLevel === true ? { userLevel: true } : {}),
  });

  /** One entry of a lock file, as vskill wrote it. */
  const lockEntry = (lockPath: string, name: string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(lockPath).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        info.value.type !== "File" ||
        info.value.size > BigInt(MAX_LOCK_BYTES)
      )
        return null;
      const text = yield* fs.readFileString(lockPath).pipe(Effect.option);
      const entry = Option.isNone(text) ? undefined : parseVskillLock(text.value)?.get(name);
      return entry === undefined
        ? null
        : {
            installedAt: entry.installedAt,
            version: {
              version: entry.version,
              commit: entry.sourceCommitSha ?? null,
              contentHash: entry.sha !== null && CONTENT_HASH.test(entry.sha) ? entry.sha : null,
            } satisfies ProjectSkillSourceVersion,
          };
    });

  const track = (row: ProjectSkillRow, refresh: boolean): Effect.Effect<Tracked | null> =>
    Effect.gen(function* () {
      const lock = row.lock;
      if (lock === null) return null;
      const installed = installedOf(lock);
      const repo = lockRepo(lock);
      const base = { skill: row.name, lockScope: lock.lockScope, installed };
      if (repo === null)
        return {
          lock,
          repo,
          visibility: null,
          status: {
            ...base,
            repo: null,
            latest: null,
            state: "unsupported",
            detail: unsupportedReason(lock),
          },
        };
      if (lock.lockScope === "user" && path.resolve(lock.lockPath) !== path.resolve(userLockPath))
        return {
          lock,
          repo,
          visibility: null,
          status: {
            ...base,
            repo,
            latest: null,
            state: "unsupported",
            detail: `Recorded in the older ${lock.lockPath}. Reinstall it with vskill install --global first.`,
          },
        };
      const read: SkillSourceRead = yield* deps.sources.readSkill({
        repo,
        name: lock.name!,
        path: lock.sourceSkillPath,
        branch: lock.sourceBranch,
        refresh,
      });
      if (read.state !== "ok")
        return {
          lock,
          repo,
          visibility: null,
          status: {
            ...base,
            repo,
            latest: null,
            state: read.state === "needs-sign-in" ? "needs-sign-in" : "unknown",
            detail:
              read.state === "not-found"
                ? `${repo} no longer holds ${lock.name}, or this machine cannot see it.`
                : skillRepoRefusalMessage(read.state, repo, "this machine"),
          },
        };
      const latest: ProjectSkillSourceVersion = {
        version: read.skill.version,
        commit: read.skill.commit,
        contentHash: read.skill.contentHash,
      };
      const compared = compareSkillSourceVersions(installed, latest);
      const pinned =
        (compared === "update" || compared === "changed") && (lock.pinnedVersion ?? null) !== null;
      return {
        lock,
        repo,
        visibility: read.visibility,
        status: {
          ...base,
          repo,
          latest,
          state: pinned ? "pinned" : compared,
          ...(pinned ? { detail: `Pinned at ${lock.pinnedVersion}. Unpin it to update.` } : {}),
        },
      };
    });

  const trackAll = (snapshot: ProjectSkillsSnapshot, refresh: boolean) =>
    Effect.forEach(snapshot.rows, (row) => track(row, refresh), {
      concurrency: SOURCE_READS_AT_ONCE,
    }).pipe(Effect.map((tracked) => tracked.filter((entry): entry is Tracked => entry !== null)));

  const vskillEnv = (visibility: "public" | "private" | null): NodeJS.ProcessEnv => ({
    PATH: deps.environment.PATH ?? "",
    HOME: deps.home,
    ...(visibility === "public"
      ? {}
      : {
          VSKILL_NO_TELEMETRY: "1",
          VSKILL_API_BASE: CLOSED_ENDPOINT,
          VSKILL_API_URL: CLOSED_ENDPOINT,
        }),
  });

  type RunResult = Omit<ProjectSkillUpdateOutcome, "readiness">;

  /** One `vskill install` from a GitHub source, then the lock read back. */
  const install = (input: {
    readonly skill: string;
    readonly lockName: string;
    readonly repo: string;
    readonly visibility: "public" | "private" | null;
    readonly user: boolean;
    readonly cwd: string;
    readonly lockPath: string;
    readonly fresh: boolean;
  }): Effect.Effect<RunResult> =>
    Effect.gen(function* () {
      const before = yield* lockEntry(input.lockPath, input.lockName);
      const failed = (message: string): RunResult => ({
        skill: input.skill,
        outcome: "failed",
        before: before?.version ?? null,
        after: before?.version ?? null,
        message,
      });
      const vskill = yield* deps.findVskill;
      if (vskill === null) return failed(VSKILL_MISSING);
      const env = vskillEnv(input.visibility);
      if (input.visibility !== "public") {
        const version = yield* deps.run({
          command: vskill,
          args: ["--version"],
          cwd: deps.home,
          timeout: VERSION_TIMEOUT,
          env,
        });
        if (version.exitCode !== 0 || !isVersionAtLeast(version.stdout, PRIVATE_SOURCE_MIN_VSKILL))
          return failed(
            `${input.repo} is private, or GitHub did not confirm it is public. Update vskill to ${PRIVATE_SOURCE_MIN_VSKILL} or newer first: an older vskill can name the skill to its registry.`,
          );
      }
      const args = [
        "install",
        `${input.repo}/${input.lockName}`,
        "-y",
        ...(input.user ? ["--global"] : []),
      ];
      const result = yield* deps.run({
        command: vskill,
        args,
        cwd: input.cwd,
        timeout: INSTALL_TIMEOUT,
        env,
      });
      if (result.timedOut) return failed("vskill install did not finish in time.");
      if (result.exitCode === null) return failed("vskill could not be started.");
      if (result.exitCode !== 0) {
        const tail = outputTail(result);
        return failed(
          `vskill install exited with ${result.exitCode}${tail === "" ? "." : `: ${tail}`}`,
        );
      }
      const after = yield* lockEntry(input.lockPath, input.lockName);
      if (after === null)
        return failed(
          `vskill finished, but ${input.lockPath} has no entry for ${input.lockName}.`,
        );
      if (
        !input.fresh &&
        before !== null &&
        after.installedAt === before.installedAt &&
        after.version.contentHash === before.version.contentHash &&
        after.version.commit === before.version.commit
      )
        return {
          ...failed(
            `vskill finished, but the lock still records ${before.version.version ?? "the same copy"}${before.version.commit ? ` at ${before.version.commit.slice(0, 7)}` : ""}.`,
          ),
          after: after.version,
        };
      return {
        skill: input.skill,
        outcome: before === null ? "installed" : "updated",
        before: before?.version ?? null,
        after: after.version,
      };
    });

  const lockDirCwd = (lock: ProjectSkillLock) =>
    lock.lockScope === "user" ? deps.home : path.dirname(lock.lockPath);

  /** Makes every agent scan again and answers from that scan. */
  const settle = (input: ProjectSkillsUpdateInput, results: ReadonlyArray<RunResult>) =>
    Effect.gen(function* () {
      const folder = folderOf(input);
      const cwd = yield* deps.resolveCwd(folder);
      yield* deps.invalidate({ projectId: input.projectId, cwd });
      const snapshot = yield* deps.readSnapshot({ ...folder, refresh: true });
      const changed = results.some(
        (result) => result.outcome === "installed" || result.outcome === "updated",
      );
      if (changed)
        yield* deps.rescanOpenFolders(
          snapshot.providers
            .filter((provider) => provider.state !== "unsupported")
            .map((provider) => provider.instanceId),
        );
      const tracked = yield* trackAll(snapshot, false);
      return {
        checkedAt: yield* nowIso,
        statuses: tracked.map((entry) => entry.status),
        outcomes: results.map((result) => ({
          ...result,
          readiness:
            result.outcome === "installed" || result.outcome === "updated"
              ? skillReadiness(snapshot, result.skill)
              : [],
        })),
      } satisfies ProjectSkillsUpdateResult;
    });

  const runUpdate = (input: ProjectSkillsUpdateInput) =>
    Effect.gen(function* () {
      const snapshot = yield* deps.readSnapshot({ ...folderOf(input), refresh: false });
      const tracked = yield* trackAll(snapshot, true);
      const named = input.skills;
      const targets =
        named === undefined
          ? tracked.filter((entry) => ["update", "changed", "pinned"].includes(entry.status.state))
          : tracked.filter((entry) => named.includes(entry.status.skill));
      const results: RunResult[] = [];
      for (const name of named ?? [])
        if (!tracked.some((entry) => entry.status.skill === name))
          results.push({
            skill: name,
            outcome: "failed",
            before: null,
            after: null,
            message: "No vskill lock tracks this skill, so it has no source to update from.",
          });
      for (const entry of targets) {
        const { status, lock } = entry;
        if (status.state === "current") {
          results.push({
            skill: status.skill,
            outcome: "current",
            before: status.installed,
            after: status.installed,
          });
          continue;
        }
        if (entry.repo === null || (status.state !== "update" && status.state !== "changed")) {
          results.push({
            skill: status.skill,
            outcome: "skipped",
            before: status.installed,
            after: status.installed,
            ...(status.detail === undefined
              ? { message: "Its source could not be compared, so nothing was changed." }
              : { message: status.detail }),
          });
          continue;
        }
        results.push(
          yield* install({
            skill: status.skill,
            lockName: lock.name!,
            repo: entry.repo,
            visibility: entry.visibility,
            user: lock.lockScope === "user",
            cwd: lockDirCwd(lock),
            lockPath: lock.lockPath,
            fresh: false,
          }),
        );
      }
      return yield* settle(input, results);
    });

  const runInstall = (input: ProjectSkillsUpdateInput) =>
    Effect.gen(function* () {
      const ask = input.install;
      if (ask === undefined)
        return yield* actionError(input.projectId, "scope_unsupported", "Name the skill to install.");
      const connected: ReadonlyArray<ProjectSkillRepo> = yield* deps.sources.connected();
      const repo = connected.find((entry) => entry.repo.toLowerCase() === ask.repo.toLowerCase());
      if (repo === undefined)
        return yield* actionError(
          input.projectId,
          "scope_unsupported",
          `Connect ${ask.repo} on this machine first.`,
        );
      if (repo.state !== "ok")
        return yield* actionError(
          input.projectId,
          "agent_unavailable",
          skillRepoRefusalMessage(repo.state, repo.repo, "this machine"),
        );
      if (!repo.skills.some((skill) => skill.name === ask.skill))
        return yield* actionError(
          input.projectId,
          "skill_not_found",
          `${repo.repo} has no skill named ${ask.skill}.`,
        );
      const user = input.userLevel === true;
      const cwd = user ? deps.home : yield* deps.resolveCwd(folderOf(input));
      const result = yield* install({
        skill: ask.skill,
        lockName: ask.skill,
        repo: repo.repo,
        visibility: repo.visibility,
        user,
        cwd,
        lockPath: user ? userLockPath : path.join(cwd, "vskill.lock"),
        fresh: true,
      });
      return yield* settle(input, [result]);
    });

  const update = (
    input: ProjectSkillsUpdateInput,
  ): Effect.Effect<ProjectSkillsUpdateResult, ProjectSkillsActionError> => {
    if (input.operation === "status")
      return Effect.gen(function* () {
        const snapshot = yield* deps.readSnapshot({ ...folderOf(input), refresh: false });
        const tracked = yield* trackAll(snapshot, input.refresh === true);
        return { checkedAt: yield* nowIso, statuses: tracked.map((entry) => entry.status) };
      });
    // One vskill run at a time: each rewrites the same lock.
    return writes.withPermits(1)(input.operation === "install" ? runInstall(input) : runUpdate(input));
  };

  return { update };
});

export type SkillUpdates = Effect.Success<ReturnType<typeof makeSkillUpdates>>;
