/**
 * Local reads behind the project Skills view: vskill lockfiles, the SKILL.md
 * files providers reported, and an optional `vskill doctor --json`. Nothing
 * here touches the network or writes; every read is bounded so one huge or
 * hung source cannot stall the view.
 *
 * @module project/projectSkillsScan
 */
import * as NodeOS from "node:os";

import type {
  ProjectSkillsProviderState,
  ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import {
  buildProjectSkillRows,
  comparableSkillContent,
  isListableSkillPath,
  lockEntryKey,
  parsePluginManifestVersion,
  parseVskillDoctorReport,
  parseVskillLock,
  readSkillFrontmatter,
  vskillContentSha,
  type ProviderSkillSource,
  type SkillFileFact,
  type VskillDoctorFinding,
  type VskillLockSource,
} from "./projectSkillsInventory.ts";

const MAX_SKILL_FILE_BYTES = 1_000_000;
const MAX_LOCK_FILE_BYTES = 4_000_000;
const MAX_PLUGIN_MANIFEST_BYTES = 256_000;
/** A plugin skill sits at `<plugin>/skills/<name>/SKILL.md`; look a little higher too. */
const PLUGIN_MANIFEST_LEVELS = 4;
const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"];
const DOCTOR_TIMEOUT_MS = 5_000;

const readBounded = Effect.fn("projectSkills.readBounded")(function* (
  filePath: string,
  maxBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(filePath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || info.value.size > BigInt(maxBytes)) {
    return undefined;
  }
  return yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));
});

/** Nearest ancestor (inclusive) holding `.specweave/config.json`, vskill's project root. */
const findVskillProjectRoot = Effect.fn("projectSkills.findVskillProjectRoot")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const marker = yield* fs
      .exists(path.join(current, ".specweave", "config.json"))
      .pipe(Effect.orElseSucceed(() => false));
    if (marker) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});

/**
 * vskill keeps a project lock in the project root (the cwd, or the nearest
 * folder with `.specweave/config.json`) and user-scope locks in
 * `~/.agents/vskill.lock`, with `~/vskill.lock` from older releases.
 */
export const readVskillLocks = Effect.fn("projectSkills.readVskillLocks")(function* (input: {
  readonly cwd: string;
  readonly homeDir: string;
}) {
  const path = yield* Path.Path;
  const projectRoot = yield* findVskillProjectRoot(input.cwd);
  const candidates: ReadonlyArray<{ root: string; scope: "project" | "user" }> = [
    { root: path.resolve(input.cwd), scope: "project" },
    ...(projectRoot ? [{ root: projectRoot, scope: "project" as const }] : []),
    { root: path.join(input.homeDir, ".agents"), scope: "user" },
    { root: input.homeDir, scope: "user" },
  ];
  const seen = new Set<string>();
  const locks: Array<VskillLockSource> = [];
  for (const candidate of candidates) {
    const lockPath = path.join(candidate.root, "vskill.lock");
    if (seen.has(lockPath)) continue;
    seen.add(lockPath);
    const text = yield* readBounded(lockPath, MAX_LOCK_FILE_BYTES);
    const entries = text === undefined ? undefined : parseVskillLock(text);
    if (!entries) continue;
    locks.push({ path: lockPath, root: candidate.root, scope: candidate.scope, entries });
  }
  return locks;
});

/**
 * The version in the manifest of the plugin a SKILL.md sits in, such as
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json`.
 * Only files under a `plugins` folder are plugin skills.
 */
const readPluginVersion = Effect.fn("projectSkills.readPluginVersion")(function* (
  realPath: string,
) {
  const path = yield* Path.Path;
  if (!realPath.split(/[\\/]+/).includes("plugins")) return null;
  let current = path.dirname(realPath);
  for (let level = 0; level < PLUGIN_MANIFEST_LEVELS; level += 1) {
    for (const manifest of PLUGIN_MANIFESTS) {
      const text = yield* readBounded(path.join(current, manifest), MAX_PLUGIN_MANIFEST_BYTES);
      if (text === undefined) continue;
      return parsePluginManifestVersion(text);
    }
    const parent = path.dirname(current);
    if (parent === current || path.basename(current) === "plugins") break;
    current = parent;
  }
  return null;
});

/** Resolve links, digest and read the frontmatter of each reported SKILL.md once. */
export const readSkillFileFacts = Effect.fn("projectSkills.readSkillFileFacts")(function* (
  paths: Iterable<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unique = [...new Set(paths)];
  const facts = yield* Effect.forEach(
    unique,
    (skillPath) =>
      Effect.gen(function* () {
        const realPath = yield* fs.realPath(skillPath).pipe(Effect.orElseSucceed(() => skillPath));
        const content = yield* readBounded(realPath, MAX_SKILL_FILE_BYTES);
        const pluginVersion = yield* readPluginVersion(realPath);
        if (content === undefined) {
          return [skillPath, { realPath, digest: null, pluginVersion }] as const;
        }
        const frontmatter = readSkillFrontmatter(content);
        const fact: SkillFileFact = {
          realPath,
          digest: vskillContentSha(content),
          comparableDigest: vskillContentSha(
            comparableSkillContent(content, path.basename(path.dirname(realPath))),
          ),
          frontmatterName: frontmatter.name,
          fileVersion: frontmatter.version,
          pluginVersion,
        };
        return [skillPath, fact] as const;
      }),
    { concurrency: 16 },
  );
  return new Map<string, SkillFileFact>(facts);
});

/**
 * Lock entries that still have a folder on disk: the entry's
 * `installedPath`, or a folder named after it in the lock's own skills
 * folder or a usual agent skills folder beside it or in the home folder.
 */
export const readLocksOnDisk = Effect.fn("projectSkills.readLocksOnDisk")(function* (input: {
  readonly locks: ReadonlyArray<VskillLockSource>;
  readonly homeDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirs = (root: string) => [
    path.join(root, "skills"),
    path.join(root, ".agents", "skills"),
    path.join(root, ".claude", "skills"),
    path.join(root, ".codex", "skills"),
  ];
  const checks = input.locks.flatMap((source) =>
    [...source.entries].map(([key, entry]) => ({ source, key, entry })),
  );
  const found = yield* Effect.forEach(
    checks,
    ({ source, key, entry }) =>
      Effect.gen(function* () {
        const candidates = [
          ...(entry.installedPath ? [path.resolve(source.root, entry.installedPath)] : []),
          ...[...new Set([...skillDirs(source.root), ...skillDirs(input.homeDir)])].map((dir) =>
            path.join(dir, key),
          ),
        ];
        for (const candidate of candidates) {
          const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
          if (exists) return [lockEntryKey(source.path, key)];
        }
        return [];
      }),
    { concurrency: 16 },
  );
  return new Set(found.flat());
});

export type VskillDoctorResult =
  | { readonly state: "ok"; readonly findings: ReadonlyArray<VskillDoctorFinding> }
  | { readonly state: "unavailable" | "failed" };

/**
 * Optional enrichment: `vskill doctor --json` in the project folder. An
 * installed vskill without the command, or no vskill at all, is
 * `unavailable`; the view then omits doctor findings.
 */
export const runVskillDoctor = Effect.fn("projectSkills.runVskillDoctor")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<VskillDoctorResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand("vskill", ["doctor", "--json"], {
      env: input.environment,
    });
    return yield* spawnAndCollect(
      "vskill",
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: input.environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(DOCTOR_TIMEOUT_MS), Effect.option);
  if (Option.isNone(result)) return { state: "unavailable" };
  if (Option.isNone(result.value)) return { state: "failed" };
  const output = result.value.value;
  const findings = parseVskillDoctorReport(output.stdout);
  if (findings) return { state: "ok", findings };
  return /unknown command|command not found|not recognized/i.test(output.stderr + output.stdout)
    ? { state: "unavailable" }
    : { state: "failed" };
});

/** Join already-discovered provider skills with locks, digests and doctor findings. */
export const gatherProjectSkills = Effect.fn("projectSkills.gather")(function* (input: {
  readonly cwd: string;
  readonly providers: ReadonlyArray<ProviderSkillSource>;
  readonly providerStates: ReadonlyArray<ProjectSkillsProviderState>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly doctor?: boolean;
}): Effect.fn.Return<
  ProjectSkillsSnapshot,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const environment = input.environment ?? process.env;
  const homeDir = input.homeDir ?? NodeOS.homedir();
  // Trash folders and plugin command files are not skills an agent loads.
  const providers = input.providers.map((provider) => ({
    ...provider,
    skills: provider.skills.filter((skill) => isListableSkillPath(skill.path)),
  }));
  const [locks, files, doctor] = yield* Effect.all(
    [
      readVskillLocks({ cwd: input.cwd, homeDir }),
      readSkillFileFacts(
        providers.flatMap((provider) => provider.skills.map((skill) => skill.path)),
      ),
      input.doctor === false
        ? Effect.succeed<VskillDoctorResult>({ state: "unavailable" })
        : runVskillDoctor({ cwd: input.cwd, environment }),
    ],
    { concurrency: "unbounded" },
  );
  const lockOnDisk = yield* readLocksOnDisk({ locks, homeDir });
  const rows = buildProjectSkillRows({
    cwd: input.cwd,
    providers,
    locks,
    files,
    doctor: doctor.state === "ok" ? doctor.findings : [],
    lockOnDisk,
  });
  const listed = new Map(
    providers.map((provider) => [provider.instanceId, provider.skills.length]),
  );
  return {
    cwd: input.cwd,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    rows,
    providers: input.providerStates.map((state) =>
      state.state === "ok" && listed.has(state.instanceId)
        ? { ...state, skills: listed.get(state.instanceId)! }
        : state,
    ),
    locks: locks.map((lock) => ({ path: lock.path, scope: lock.scope, skills: lock.entries.size })),
    doctor: doctor.state,
  };
});
