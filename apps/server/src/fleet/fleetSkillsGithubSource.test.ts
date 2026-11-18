import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { vskillContentSha } from "../project/projectSkillsInventory.ts";
import type { SkillSourceRead } from "../project/SkillRepoSources.ts";
import { type FleetSkillAsk, type FleetSkillRun, makeFleetSkillWorker } from "./fleetSkills.ts";
import {
  type GithubSkillDeps,
  githubSkillLink,
  prepareGithubSkill,
  runGithubSkill,
} from "./fleetSkillsGithubSource.ts";

const HOME = "/home/tester";
const COMMIT = "b".repeat(40);
const OLD_COMMIT = "c".repeat(40);
const SOURCE_TEXT = "---\nname: html-report\nmetadata:\n  version: 1.1.3\n---\nBody\n";
const HASH = vskillContentSha(SOURCE_TEXT);
const OLD_HASH = vskillContentSha("---\nname: html-report\n---\nOld\n");
const USER_LOCK = `${HOME}/.agents/vskill.lock`;

const ask = (extra: Partial<FleetSkillAsk> = {}): FleetSkillAsk =>
  ({
    skill: "anton-abyzov/vskill/html-report",
    version: "1.1.3",
    pin: false,
    scope: "user",
    contentHash: HASH,
    source: {
      kind: "github",
      path: "skills/html-report/SKILL.md",
      branch: "main",
      commit: COMMIT,
    },
    ...extra,
  }) as FleetSkillAsk;

const lockText = (entry: Record<string, unknown> | null) =>
  JSON.stringify({ version: 1, skills: entry === null ? {} : { "html-report": entry } }, null, 2);

const installedEntry = (commit: string, sha: string, extra: Record<string, unknown> = {}) => ({
  version: "1.1.3",
  sha,
  source: "github:anton-abyzov/vskill",
  sourceSkillPath: "skills/html-report/SKILL.md",
  sourceBranch: commit,
  sourceCommitSha: commit,
  ...extra,
});

interface Fake {
  readonly deps: GithubSkillDeps;
  readonly runs: Array<{ command: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv }>;
  readonly locks: Map<string, string>;
}

function fake(
  options: {
    vskill?: string | null;
    npx?: string | null;
    vskillVersion?: string;
    connected?: ReadonlyArray<string>;
    read?: SkillSourceRead;
    lock?: Record<string, unknown> | null;
    occupied?: boolean;
    /** What vskill writes into the lock when it installs. */
    writes?: Record<string, unknown> | null;
    installExit?: number;
  } = {},
): Fake {
  const runs: Fake["runs"] = [];
  const locks = new Map<string, string>();
  if (options.lock !== undefined) locks.set(USER_LOCK, lockText(options.lock));
  const deps: GithubSkillDeps = {
    home: HOME,
    projectRoot: () => Effect.succeed(null),
    resolveVskill: Effect.succeed(
      options.vskill === undefined ? "/usr/local/bin/vskill" : options.vskill,
    ),
    resolveNpx: Effect.succeed(options.npx === undefined ? "/usr/local/bin/npx" : options.npx),
    run: (input) =>
      Effect.sync((): FleetSkillRun => {
        runs.push({
          command: input.command,
          args: input.args,
          ...(input.env ? { env: input.env } : {}),
        });
        if (input.args.includes("--version"))
          return {
            exitCode: 0,
            stdout: `${options.vskillVersion ?? "1.2.14"}\n`,
            stderr: "",
            timedOut: false,
          };
        const exit = options.installExit ?? 0;
        if (exit === 0 && input.args.includes("install"))
          locks.set(
            USER_LOCK,
            lockText(options.writes === undefined ? installedEntry(COMMIT, HASH) : options.writes),
          );
        if (exit === 0 && input.args.includes("remove")) locks.set(USER_LOCK, lockText(null));
        return { exitCode: exit, stdout: "", stderr: exit === 0 ? "" : "boom", timedOut: false };
      }),
    connectedRepos: Effect.succeed(options.connected ?? ["anton-abyzov/vskill"]),
    readSkill: () =>
      Effect.succeed(
        options.read ?? {
          state: "ok",
          visibility: "public",
          branch: COMMIT,
          skill: {
            name: "html-report",
            path: "skills/html-report/SKILL.md",
            plugin: null,
            version: "1.1.3",
            commit: COMMIT,
            contentHash: HASH,
          },
        },
      ),
    readLockText: (file) => Effect.succeed(locks.get(file) ?? null),
    writeLockText: (file, text) => Effect.sync(() => (locks.set(file, text), true)),
    occupied: () => Effect.succeed(options.occupied ?? false),
    fingerprint: (input) => Effect.succeed(JSON.stringify(input)),
  };
  return { deps, runs, locks };
}

const refusalOf = (deps: GithubSkillDeps, value: FleetSkillAsk) =>
  prepareGithubSkill(deps, value).pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("a GitHub-source skill install on a fleet machine", () => {
  it("installs exactly the reviewed commit with a fixed argv", () => {
    expect(githubSkillLink("anton-abyzov/vskill", ask().source!)).toBe(
      `https://github.com/anton-abyzov/vskill/tree/${COMMIT}/skills/html-report`,
    );
  });

  it.effect("installs with the installed vskill, reads the lock back and records the branch", () =>
    Effect.gen(function* () {
      const { deps, runs, locks } = fake({ lock: null });
      const plan = yield* prepareGithubSkill(deps, ask());
      expect(plan.via).toBe("vskill");
      expect(plan.previous).toBeNull();
      expect(plan.files).toContain(`${HOME}/.agents/skills/html-report/SKILL.md`);
      const result = yield* runGithubSkill(deps, ask(), plan);
      expect(result).toMatchObject({ ok: true, installedVersion: "1.1.3", via: "vskill" });
      const install = runs.find((run) => run.args.includes("install"))!;
      expect(install.command).toBe("/usr/local/bin/vskill");
      expect(install.args).toEqual([
        "install",
        `https://github.com/anton-abyzov/vskill/tree/${COMMIT}/skills/html-report`,
        "-y",
        "--global",
      ]);
      // vskill records the commit as the branch; the branch is put back so updates compare heads.
      const entry = JSON.parse(locks.get(USER_LOCK)!).skills["html-report"];
      expect(entry.sourceBranch).toBe("main");
      expect(entry.sourceCommitSha).toBe(COMMIT);
    }),
  );

  it.effect("falls back to npx vskill@latest when vskill is not installed and says so", () =>
    Effect.gen(function* () {
      const { deps, runs } = fake({ vskill: null, lock: null });
      const plan = yield* prepareGithubSkill(deps, ask());
      expect(plan.via).toBe("npx");
      const result = yield* runGithubSkill(deps, ask(), plan);
      expect(result).toMatchObject({ ok: true, via: "npx" });
      const install = runs.find((run) => run.args.includes("install"))!;
      expect(install.command).toBe("/usr/local/bin/npx");
      expect(install.args.slice(0, 3)).toEqual(["--yes", "vskill@latest", "install"]);
    }),
  );

  it.effect("refuses with vskill-missing when there is neither vskill nor npx", () =>
    Effect.gen(function* () {
      const { deps, runs } = fake({ vskill: null, npx: null });
      expect(yield* refusalOf(deps, ask())).toBe("vskill-missing");
      expect(runs).toHaveLength(0);
    }),
  );

  it.effect("refuses unless the same repo is connected on this machine", () =>
    Effect.gen(function* () {
      const { deps, runs } = fake({ connected: ["someone/else"] });
      expect(yield* refusalOf(deps, ask())).toBe("repo-not-connected");
      expect(runs).toHaveLength(0);
    }),
  );

  it.effect("refuses with no-access when this machine cannot read the private repo", () =>
    Effect.gen(function* () {
      const { deps, runs } = fake({ read: { state: "needs-sign-in" } });
      expect(yield* refusalOf(deps, ask())).toBe("no-access");
      const missing = fake({ read: { state: "not-found" } });
      expect(yield* refusalOf(missing.deps, ask())).toBe("no-access");
      expect(runs).toHaveLength(0);
    }),
  );

  it.effect("refuses a commit whose SKILL.md is not the reviewed copy", () =>
    Effect.gen(function* () {
      const { deps } = fake();
      expect(yield* refusalOf(deps, ask({ contentHash: "d".repeat(64) }))).toBe("stale");
    }),
  );

  it.effect("compares the normalized hash, so CRLF and a BOM in the source still match", () =>
    Effect.gen(function* () {
      const crlf = `﻿${SOURCE_TEXT.replace(/\n/g, "\r\n")}`;
      const { deps } = fake({
        read: {
          state: "ok",
          visibility: "public",
          branch: COMMIT,
          skill: {
            name: "html-report",
            path: "skills/html-report/SKILL.md",
            plugin: null,
            version: "1.1.3",
            commit: COMMIT,
            contentHash: vskillContentSha(crlf),
          },
        },
      });
      const plan = yield* prepareGithubSkill(deps, ask());
      expect(plan.via).toBe("vskill");
    }),
  );

  it.effect("skips a machine where another source already uses the name", () =>
    Effect.gen(function* () {
      const other = fake({
        lock: installedEntry(OLD_COMMIT, OLD_HASH, { source: "github:someone/skills" }),
      });
      expect(yield* refusalOf(other.deps, ask())).toBe("name-taken");
      // A hand copy or an `npx skills` folder with no vskill entry also holds the name.
      const folder = fake({ lock: null, occupied: true });
      expect(yield* refusalOf(folder.deps, ask())).toBe("name-taken");
    }),
  );

  it.effect("keeps the copy from the same repo it replaces, so Undo can put it back", () =>
    Effect.gen(function* () {
      const { deps } = fake({
        lock: installedEntry(OLD_COMMIT, OLD_HASH, { version: "1.1.2", sourceBranch: "main" }),
      });
      const plan = yield* prepareGithubSkill(deps, ask());
      expect(plan.previous).toEqual({
        version: "1.1.2",
        commit: OLD_COMMIT,
        contentHash: OLD_HASH,
        branch: "main",
        path: "skills/html-report/SKILL.md",
      });
    }),
  );

  it.effect("keeps private sources off the skill registry", () =>
    Effect.gen(function* () {
      const { deps, runs } = fake({
        lock: null,
        read: {
          state: "ok",
          visibility: "private",
          branch: COMMIT,
          skill: {
            name: "html-report",
            path: "skills/html-report/SKILL.md",
            plugin: null,
            version: "1.1.3",
            commit: COMMIT,
            contentHash: HASH,
          },
        },
      });
      const plan = yield* prepareGithubSkill(deps, ask());
      yield* runGithubSkill(deps, ask(), plan);
      const install = runs.find((run) => run.args.includes("install"))!;
      expect(install.env?.VSKILL_API_BASE).toBe("http://127.0.0.1:9");
      expect(install.env?.VSKILL_NO_TELEMETRY).toBe("1");
    }),
  );

  it.effect("uses npx when the installed vskill is too old for commit installs", () =>
    Effect.gen(function* () {
      const { deps } = fake({ vskillVersion: "1.2.9" });
      expect((yield* prepareGithubSkill(deps, ask())).via).toBe("npx");
    }),
  );

  it.effect(
    "fails, without claiming success, when the lock does not record the reviewed copy",
    () =>
      Effect.gen(function* () {
        const { deps } = fake({ lock: null, writes: installedEntry(COMMIT, OLD_HASH) });
        const plan = yield* prepareGithubSkill(deps, ask());
        const result = yield* runGithubSkill(deps, ask(), plan);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toMatch(/lock records/);
      }),
  );

  it.effect("reports the vskill error text when the install fails", () =>
    Effect.gen(function* () {
      const { deps } = fake({ lock: null, installExit: 1 });
      const plan = yield* prepareGithubSkill(deps, ask());
      const result = yield* runGithubSkill(deps, ask(), plan);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.message).toContain("boom");
    }),
  );

  it.effect("removes only the copy this source installed (Undo of a new install)", () =>
    Effect.gen(function* () {
      const mine = fake({ lock: installedEntry(COMMIT, HASH, { sourceBranch: "main" }) });
      const plan = yield* prepareGithubSkill(mine.deps, ask({ action: "remove" }));
      const result = yield* runGithubSkill(mine.deps, ask({ action: "remove" }), plan);
      expect(result).toMatchObject({ ok: true, removed: true });
      expect(mine.runs.find((run) => run.args.includes("remove"))!.args).toEqual([
        "remove",
        "html-report",
        "--force",
        "--global",
      ]);
      // Changed since: someone updated it there. Undo refuses rather than remove their copy.
      const changed = fake({ lock: installedEntry(OLD_COMMIT, OLD_HASH) });
      expect(yield* refusalOf(changed.deps, ask({ action: "remove" }))).toBe("stale");
      expect(changed.runs).toHaveLength(0);
    }),
  );
});

describe("the fleet worker with a GitHub source", () => {
  const settled = (service: { status: Effect.Effect<{ phase: string }> }) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const status = yield* service.status;
        if (status.phase === "installed" || status.phase === "failed") return status;
        yield* Effect.sleep("5 millis");
      }
      return yield* Effect.die("the install never finished");
    });

  const workerWith = (github: GithubSkillDeps | undefined) =>
    makeFleetSkillWorker({
      resolveVskill: Effect.succeed("/usr/local/bin/vskill"),
      home: HOME,
      projectRoot: () => Effect.succeed(null),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      readLock: () => Effect.succeed(null),
      dropPin: () => Effect.succeed(false),
      ...(github ? { github } : {}),
    });

  it.live("previews, then installs only what was reviewed, and reports how vskill ran", () =>
    Effect.gen(function* () {
      const { deps } = fake({ vskill: null, lock: null });
      const service = yield* workerWith(deps);
      const preview = yield* service.request(ask({ preview: true }));
      expect(preview).toMatchObject({ preview: true, via: "npx", previous: null });
      expect(preview.files?.length).toBeGreaterThan(0);
      // Save without the reviewed fingerprint is refused.
      expect((yield* service.request(ask()).pipe(Effect.flip)).reason).toBe("stale");
      yield* service.request(ask({ expectedHash: preview.expectedHash! }));
      const status = yield* settled(service);
      expect(status).toMatchObject({ phase: "installed", via: "npx", action: "install" });
    }),
  );

  it.live("tells an older build's primary it cannot take GitHub sources", () =>
    Effect.gen(function* () {
      const service = yield* workerWith(undefined);
      expect((yield* service.request(ask({ preview: true })).pipe(Effect.flip)).reason).toBe(
        "unsupported",
      );
    }),
  );
});
