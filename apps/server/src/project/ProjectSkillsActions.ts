/**
 * ProjectSkillsActions — the Skills control center's writes and version reads.
 *
 * Versions come from vskill: `vskill versions <owner/repo/name> --json` and
 * `vskill outdated --json`. Version changes run vskill with a fixed argv and
 * the platform process adapter, then read the version back from the lock file instead of trusting
 * vskill's words (its `pin`, `unpin` and `update` print no JSON):
 *
 *   vskill install <owner/repo/name>@<X.Y.Z> -y [--global]   (installs and pins)
 *   vskill pin <name> <X.Y.Z>        (project locks only)
 *   vskill unpin <name>              (project locks only)
 *
 * Update to latest installs the newest listed version, then drops the pin
 * that install sets unless the skill was pinned before, editing that same
 * lock file (as the fleet worker does), so the result is one known version.
 * An install with `pin: false` (Undo of a change to a skill that was not
 * pinned) drops the pin the same way.
 * `vskill update` and `vskill enable|disable` are never run: `disable`
 * uninstalls Claude plugins.
 *
 * `vskill install` writes the lock in the folder it runs in (the user's
 * `~/.agents/vskill.lock` with `--global`), so installs run in the lock's
 * own folder. `pin` and `unpin` find the lock by walking up to the nearest
 * `.specweave/config.json`; before they run, the lock they would pick is
 * worked out the same way, and a run that would land in another project's
 * lock is refused. A user skill still recorded only in the older
 * `~/vskill.lock` is refused too: `--global` would write the other lock.
 *
 * Skill and plugin switches live in `ProjectSkillsToggles`. Every write is a
 * preview first; the apply carries what the preview saw (the lock's or the
 * settings file's hash) and is refused with `stale` when it changed. Writes
 * in one folder run one at a time, and each ends by dropping the folder's
 * cached Skills read and asking the agents to scan it again.
 *
 * @module project/ProjectSkillsActions
 */
import type {
  ProjectSkillsActionInput,
  ProjectSkillsActionResult,
  ProjectSkillsVersions,
  ProjectSkillsVersionsInput,
} from "@specweave-studio/contracts";
import { ProjectSkillsActionError } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { isFleetSkillVersion, lockEntryOf, lockWithoutPin } from "../fleet/fleetSkills.ts";
import { sha256 } from "../nodeCrypto.ts";
import {
  actionError,
  cliFailure,
  findVskillBinary,
  makeRunCli,
  type ProjectSkillsActionsDeps,
  type SkillsActionContext,
  VSKILL_MISSING,
} from "./ProjectSkillsActionsCommon.ts";
import { makeSkillsToggles } from "./ProjectSkillsToggles.ts";

const INSTALL_TIMEOUT = "180 seconds";
const READ_TIMEOUT = "45 seconds";
const PIN_TIMEOUT = "60 seconds";
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

/** The fixed argv of every vskill run here. */
export const vskillArgs = {
  versions: (skillId: string) => ["versions", skillId, "--json"],
  outdated: (user: boolean) => ["outdated", "--json", ...(user ? ["--global"] : [])],
  install: (skillId: string, version: string, user: boolean) => [
    "install",
    `${skillId}@${version}`,
    "-y",
    ...(user ? ["--global"] : []),
  ],
  pin: (name: string, version: string) => ["pin", name, version],
  unpin: (name: string) => ["unpin", name],
} as const;

const VersionsOutput = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      version: Schema.String,
      certTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
      createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      installed: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const OutdatedEntry = Schema.Struct({
  name: Schema.String,
  latest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  updateAvailable: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
  pinnedVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const OutdatedOutput = Schema.fromJsonString(
  Schema.Union([
    Schema.Array(OutdatedEntry),
    Schema.Struct({ results: Schema.Array(OutdatedEntry) }),
  ]),
);
const decodeVersions = Schema.decodeUnknownOption(VersionsOutput);
const decodeOutdated = Schema.decodeUnknownOption(OutdatedOutput);

/** `vskill versions --json`, newest first, or undefined when the output is not that. */
export function parseVersionsOutput(stdout: string) {
  const parsed = decodeVersions(stdout.trim());
  return Option.isNone(parsed)
    ? undefined
    : parsed.value.map((entry) => ({
        version: entry.version,
        certTier: entry.certTier ?? null,
        createdAt: entry.createdAt ?? null,
        installed: entry.installed ?? false,
      }));
}

/** This skill's line of `vskill outdated --json`, or null. */
export function parseOutdatedOutput(stdout: string, name: string) {
  const parsed = decodeOutdated(stdout.trim());
  if (Option.isNone(parsed)) return null;
  const entries = Array.isArray(parsed.value)
    ? parsed.value
    : (parsed.value as { readonly results: ReadonlyArray<typeof OutdatedEntry.Type> }).results;
  const entry = entries.find((candidate) => candidate.name === name);
  return entry === undefined
    ? null
    : {
        latest: entry.latest ?? null,
        updateAvailable: entry.updateAvailable ?? false,
        pinned: entry.pinned ?? (entry.pinnedVersion ?? null) !== null,
        pinnedVersion: entry.pinnedVersion ?? null,
      };
}

/** The lock a version action works on, from the row the Skills view showed. */
interface LockTarget {
  readonly lockPath: string;
  readonly lockDir: string;
  readonly scope: "project" | "user";
  readonly name: string;
  readonly skillId: string;
}

export class ProjectSkillsActions extends Context.Service<
  ProjectSkillsActions,
  {
    readonly versions: (
      input: ProjectSkillsVersionsInput,
    ) => Effect.Effect<ProjectSkillsVersions, ProjectSkillsActionError>;
    readonly action: (
      input: ProjectSkillsActionInput,
    ) => Effect.Effect<ProjectSkillsActionResult, ProjectSkillsActionError>;
    /** The versions the registry lists for `owner/repo/name`, or undefined when vskill could not say. */
    readonly registryVersions: (
      skillId: string,
    ) => Effect.Effect<ReadonlyArray<string> | undefined>;
  }
>()("specweave-studio/project/ProjectSkillsActions") {}

export const makeProjectSkillsActions = Effect.fn("ProjectSkillsActions.make")(function* (
  deps: ProjectSkillsActionsDeps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* makeRunCli;
  const toggles = yield* makeSkillsToggles(deps, run);
  const locks = new Map<string, Semaphore.Semaphore>();
  /** One write at a time per folder. */
  const serialized = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) => {
    let semaphore = locks.get(cwd);
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(1);
      locks.set(cwd, semaphore);
    }
    return semaphore.withPermits(1)(effect);
  };

  const vskillEnv = { PATH: deps.environment.PATH ?? "", HOME: deps.home };
  const vskillLocation = {
    home: deps.home,
    pathEnv: deps.environment.PATH,
    platform: deps.platform,
    appData: deps.environment.APPDATA,
    pathExt: deps.environment.PATHEXT,
  };
  const findVskill = (projectId: SkillsActionContext["projectId"]) =>
    findVskillBinary(vskillLocation).pipe(
      Effect.flatMap((found) =>
        found === null
          ? Effect.fail(actionError(projectId, "agent_unavailable", VSKILL_MISSING))
          : Effect.succeed(found),
      ),
    );

  const lockTargetOf = (ctx: SkillsActionContext) =>
    Effect.gen(function* () {
      const lock = ctx.row.lock;
      if (lock === null || !lock.skillId || !lock.name)
        return yield* actionError(ctx.projectId, "not_registry_skill");
      return {
        lockPath: lock.lockPath,
        lockDir: path.dirname(lock.lockPath),
        scope: lock.lockScope,
        name: lock.name,
        skillId: lock.skillId,
      } satisfies LockTarget;
    });

  const readLock = (lockPath: string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(lockPath).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        info.value.type !== "File" ||
        info.value.size > BigInt(MAX_LOCK_BYTES)
      )
        return null;
      return yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => null));
    });

  /** The lock `vskill` itself picks when run in `dir`: the nearest `.specweave/config.json` root's. */
  const vskillLockFrom = (dir: string) =>
    Effect.gen(function* () {
      let current = path.resolve(dir);
      while (true) {
        const marker = yield* fs.stat(path.join(current, ".specweave")).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (
          marker &&
          (yield* fs
            .exists(path.join(current, ".specweave", "config.json"))
            .pipe(Effect.orElseSucceed(() => false)))
        )
          return path.join(current, "vskill.lock");
        const parent = path.dirname(current);
        if (parent === current) return path.join(path.resolve(dir), "vskill.lock");
        current = parent;
      }
    });

  const runCwd = (target: LockTarget) => (target.scope === "user" ? deps.home : target.lockDir);

  /** The user lock `vskill install --global` writes. */
  const userLockPath = path.join(deps.home, ".agents", "vskill.lock");

  /** Writes must land in the lock the row came from. */
  const guardLock = (ctx: SkillsActionContext, target: LockTarget, pinning: boolean) =>
    Effect.gen(function* () {
      if (target.scope === "user") {
        if (path.resolve(target.lockPath) !== path.resolve(userLockPath))
          return yield* actionError(
            ctx.projectId,
            "scope_unsupported",
            `${target.name} is recorded in the older ${target.lockPath}; vskill install --global writes ${userLockPath}, so this change would land in another lock. Reinstall it with vskill install --global first.`,
          );
        return;
      }
      // `install` writes the lock in its own cwd; only pin and unpin walk up to a project root.
      if (!pinning) return;
      const picked = yield* vskillLockFrom(target.lockDir);
      if (path.resolve(picked) !== path.resolve(target.lockPath))
        return yield* actionError(
          ctx.projectId,
          "scope_unsupported",
          `Run from ${target.lockDir}, vskill would change ${picked}, not ${target.lockPath}.`,
        );
    });

  const listVersions = (ctx: SkillsActionContext, target: LockTarget, vskill: string) =>
    Effect.gen(function* () {
      const result = yield* run({
        command: vskill,
        args: vskillArgs.versions(target.skillId),
        cwd: runCwd(target),
        timeout: READ_TIMEOUT,
        env: vskillEnv,
      });
      const versions = result.exitCode === 0 ? parseVersionsOutput(result.stdout) : undefined;
      if (versions === undefined)
        return yield* cliFailure(ctx.projectId, result, "vskill versions");
      return versions;
    });

  const versions = (input: ProjectSkillsVersionsInput) =>
    Effect.gen(function* () {
      const ctx = yield* deps.resolveRow(input);
      const target = yield* lockTargetOf(ctx);
      const vskill = yield* findVskill(ctx.projectId);
      const [list, outdatedRun, lockText] = yield* Effect.all(
        [
          listVersions(ctx, target, vskill),
          run({
            command: vskill,
            args: vskillArgs.outdated(target.scope === "user"),
            cwd: runCwd(target),
            timeout: READ_TIMEOUT,
            env: vskillEnv,
          }),
          readLock(target.lockPath),
        ],
        { concurrency: "unbounded" },
      );
      // `outdated` exits 1 when anything is out of date; its output is still the answer.
      const outdated =
        outdatedRun.exitCode === 0 || outdatedRun.exitCode === 1
          ? parseOutdatedOutput(outdatedRun.stdout, target.name)
          : null;
      const entry = lockText === null ? null : lockEntryOf(lockText, target.name);
      return {
        skill: ctx.row.name,
        skillId: target.skillId,
        lockScope: target.scope,
        installedVersion: entry?.version ?? ctx.row.lock?.version ?? null,
        pinnedVersion: entry === null ? (ctx.row.lock?.pinnedVersion ?? null) : entry.pinnedVersion,
        versions: list,
        outdated,
      } satisfies ProjectSkillsVersions;
    });

  /** Drops `name`'s pin in this exact lock file, written beside it and renamed over it. */
  const dropPin = (ctx: SkillsActionContext, lockPath: string, name: string) =>
    Effect.gen(function* () {
      const file = yield* fs.realPath(lockPath).pipe(Effect.orElseSucceed(() => lockPath));
      const text = yield* readLock(file);
      const millis = yield* Clock.currentTimeMillis;
      const next =
        text === null
          ? null
          : lockWithoutPin(text, name, DateTime.formatIso(DateTime.makeUnsafe(millis)));
      if (next === null)
        return yield* actionError(
          ctx.projectId,
          "cli_failed",
          `The pin of ${name} could not be dropped.`,
        );
      const mode = yield* fs.stat(file).pipe(
        Effect.map((info) => Number(info.mode) & 0o777),
        Effect.orElseSucceed(() => 0o644),
      );
      const temporary = `${file}.skills-${millis}.tmp`;
      yield* fs.writeFileString(temporary, next, { flag: "wx", mode }).pipe(
        Effect.andThen(fs.rename(temporary, file)),
        Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
        Effect.mapError(() =>
          actionError(ctx.projectId, "cli_failed", `The pin of ${name} could not be dropped.`),
        ),
      );
    });

  const versionAction = (
    ctx: SkillsActionContext,
    input: ProjectSkillsActionInput,
    action: Extract<
      ProjectSkillsActionInput["action"],
      { readonly kind: "install-version" | "pin" | "unpin" | "update-latest" }
    >,
  ) =>
    Effect.gen(function* () {
      const target = yield* lockTargetOf(ctx);
      if ((action.kind === "pin" || action.kind === "unpin") && target.scope !== "project")
        return yield* actionError(
          ctx.projectId,
          "scope_unsupported",
          "Pin and unpin change project locks only; this skill is locked for the user.",
        );
      yield* guardLock(ctx, target, action.kind === "pin" || action.kind === "unpin");
      const vskill = yield* findVskill(ctx.projectId);
      const user = target.scope === "user";
      const shaOf = (text: string | null) => (text === null ? "absent" : sha256([text], "hex"));

      let version: string | null = null;
      if (action.kind === "install-version" || action.kind === "pin") version = action.version;
      if (action.kind === "install-version" || action.kind === "update-latest") {
        const list = yield* listVersions(ctx, target, vskill);
        if (action.kind === "update-latest") {
          const latest = list[0]?.version;
          if (latest === undefined || !isFleetSkillVersion(latest))
            return yield* actionError(
              ctx.projectId,
              "version_not_found",
              "The registry lists no version of this skill.",
            );
          version = latest;
        } else if (!list.some((entry) => entry.version === action.version))
          return yield* actionError(
            ctx.projectId,
            "version_not_found",
            `The registry lists no ${action.version} of ${target.skillId}.`,
          );
      }
      /** The argv and words for the lock as it reads now; update-latest keeps a pin only if one was set. */
      const planFor = (lockText: string | null) => {
        const before = lockText === null ? null : lockEntryOf(lockText, target.name);
        const keepPin =
          action.kind === "update-latest"
            ? (before?.pinnedVersion ?? null) !== null
            : action.kind !== "install-version" || action.pin !== false;
        const argv =
          action.kind === "pin"
            ? vskillArgs.pin(target.name, action.version)
            : action.kind === "unpin"
              ? vskillArgs.unpin(target.name)
              : vskillArgs.install(target.skillId, version!, user);
        const summary =
          action.kind === "pin"
            ? `Pin ${target.name} at ${action.version} in ${target.lockPath}.`
            : action.kind === "unpin"
              ? `Unpin ${target.name} in ${target.lockPath}.`
              : action.kind === "install-version"
                ? `Install ${target.skillId}@${version}${keepPin ? " and pin it" : ", then drop the pin the install sets"} (${user ? "user" : "project"} lock ${target.lockPath}).`
                : `Update ${target.skillId} to ${version}${keepPin ? " and keep it pinned" : ", then drop the pin the install sets"} (${target.lockPath}).`;
        return { keepPin, argv, summary };
      };
      if (input.preview) {
        const lockText = yield* readLock(target.lockPath);
        const { argv, summary } = planFor(lockText);
        return {
          preview: {
            argv: ["vskill", ...argv],
            files: [target.lockPath],
            summary,
            liveness: "next-session",
            expected: {
              lockSha: shaOf(lockText),
              ...(version === null ? {} : { targetVersion: version }),
            },
          },
        } satisfies ProjectSkillsActionResult;
      }

      return yield* serialized(
        ctx.cwd,
        Effect.gen(function* () {
          // Read inside the queue, so a second apply of the same preview sees the first one's lock.
          const lockText = yield* readLock(target.lockPath);
          if (input.expected?.lockSha !== undefined && input.expected.lockSha !== shaOf(lockText))
            return yield* actionError(ctx.projectId, "stale");
          if (action.kind === "update-latest" && input.expected?.targetVersion !== version)
            return yield* actionError(
              ctx.projectId,
              "stale",
              "The latest version changed or was not previewed. Review the version again.",
            );
          const { keepPin, argv, summary } = planFor(lockText);
          const result = yield* run({
            command: vskill,
            args: argv,
            cwd: runCwd(target),
            timeout:
              action.kind === "pin" || action.kind === "unpin" ? PIN_TIMEOUT : INSTALL_TIMEOUT,
            env: vskillEnv,
          });
          if (result.timedOut || result.exitCode !== 0)
            return yield* cliFailure(ctx.projectId, result, `vskill ${argv[0]}`);
          if (!keepPin) yield* dropPin(ctx, target.lockPath, target.name);
          const afterText = yield* readLock(target.lockPath);
          const after = afterText === null ? null : lockEntryOf(afterText, target.name);
          if (after === null)
            return yield* actionError(
              ctx.projectId,
              "cli_failed",
              `vskill finished, but ${target.lockPath} has no entry for ${target.name}.`,
            );
          const expectedPin = action.kind === "unpin" ? null : !keepPin ? null : version;
          const expectedVersion =
            action.kind === "pin" || action.kind === "unpin" ? after.version : version;
          if (after.version !== expectedVersion || after.pinnedVersion !== expectedPin)
            return yield* actionError(
              ctx.projectId,
              "cli_failed",
              `vskill finished, but the lock records ${after.version}${after.pinnedVersion ? ` pinned at ${after.pinnedVersion}` : " unpinned"}.`,
            );
          yield* deps.afterWrite({
            projectId: ctx.projectId,
            cwd: ctx.cwd,
            instanceIds: ctx.row.providers.map((presence) => presence.instanceId),
          });
          return {
            applied: true,
            summary,
            liveness: "next-session",
            installedVersion: after.version,
            pinnedVersion: after.pinnedVersion,
          } satisfies ProjectSkillsActionResult;
        }),
      );
    });

  const action = (input: ProjectSkillsActionInput) =>
    Effect.gen(function* () {
      const ctx = yield* deps.resolveRow(input);
      const requested = input.action;
      switch (requested.kind) {
        case "install-version":
        case "pin":
        case "unpin":
        case "update-latest":
          return yield* versionAction(ctx, input, requested);
        case "toggle-skill":
          return yield* toggles.toggleSkill(ctx, input, requested, serialized);
        case "toggle-plugin":
          return yield* toggles.togglePlugin(ctx, input, requested, serialized);
      }
    });

  const registryVersions = (skillId: string) =>
    Effect.gen(function* () {
      const vskill = yield* findVskillBinary(vskillLocation);
      if (vskill === null) return undefined;
      const result = yield* run({
        command: vskill,
        args: vskillArgs.versions(skillId),
        cwd: deps.home,
        timeout: READ_TIMEOUT,
        env: vskillEnv,
      });
      return result.exitCode === 0
        ? parseVersionsOutput(result.stdout)?.map((entry) => entry.version)
        : undefined;
    });

  /** The file system this service was built with, for every request it serves. */
  const local = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const answered =
    <I extends { readonly projectId: ProjectSkillsActionInput["projectId"] }, A>(
      handler: (
        input: I,
      ) => Effect.Effect<A, ProjectSkillsActionError, FileSystem.FileSystem | Path.Path>,
    ) =>
    (input: I) =>
      local(handler(input)).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            new ProjectSkillsActionError({
              projectId: input.projectId,
              reason: "read_failed",
              cause,
            }),
          ),
        ),
      );

  return ProjectSkillsActions.of({
    registryVersions: (skillId) => local(registryVersions(skillId)),
    versions: answered(versions),
    action: answered(action),
  });
});
