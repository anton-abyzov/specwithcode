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
  parseVskillDoctorReport,
  parseVskillLock,
  vskillContentSha,
  type ProviderSkillSource,
  type SkillFileFact,
  type VskillLockSource,
} from "./projectSkillsInventory.ts";

const MAX_SKILL_FILE_BYTES = 1_000_000;
const MAX_LOCK_FILE_BYTES = 4_000_000;
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

/** Resolve links and digest each reported SKILL.md once. */
export const readSkillFileFacts = Effect.fn("projectSkills.readSkillFileFacts")(function* (
  paths: Iterable<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const unique = [...new Set(paths)];
  const facts = yield* Effect.forEach(
    unique,
    (skillPath) =>
      Effect.gen(function* () {
        const realPath = yield* fs.realPath(skillPath).pipe(Effect.orElseSucceed(() => skillPath));
        const content = yield* readBounded(realPath, MAX_SKILL_FILE_BYTES);
        return [
          skillPath,
          { realPath, digest: content === undefined ? null : vskillContentSha(content) },
        ] as const;
      }),
    { concurrency: 16 },
  );
  return new Map<string, SkillFileFact>(facts);
});

export type VskillDoctorResult =
  | { readonly state: "ok"; readonly findings: ReadonlyMap<string, ReadonlyArray<string>> }
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
  const [locks, files, doctor] = yield* Effect.all(
    [
      readVskillLocks({ cwd: input.cwd, homeDir }),
      readSkillFileFacts(
        input.providers.flatMap((provider) => provider.skills.map((skill) => skill.path)),
      ),
      input.doctor === false
        ? Effect.succeed<VskillDoctorResult>({ state: "unavailable" })
        : runVskillDoctor({ cwd: input.cwd, environment }),
    ],
    { concurrency: "unbounded" },
  );
  const rows = buildProjectSkillRows({
    cwd: input.cwd,
    providers: input.providers,
    locks,
    files,
    doctor: doctor.state === "ok" ? doctor.findings : new Map(),
  });
  return {
    cwd: input.cwd,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    rows,
    providers: input.providerStates,
    locks: locks.map((lock) => ({ path: lock.path, scope: lock.scope, skills: lock.entries.size })),
    doctor: doctor.state,
  };
});
