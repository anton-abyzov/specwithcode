import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeEffectPath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  type ProjectSkillLock,
  type ProjectSkillRow,
  type ProjectSkillsActionInput,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stand-in vskill and real lock files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { writeFakeCli } from "../testUtils/fakeCli.ts";

import { sha256 } from "../nodeCrypto.ts";
import { dirname, join } from "../nodePath.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  makeProjectSkillsActions,
  parseOutdatedOutput,
  parseVersionsOutput,
  vskillArgs,
} from "./ProjectSkillsActions.ts";
import type {
  ProjectSkillsActionsDeps,
  SkillsActionContext,
} from "./ProjectSkillsActionsCommon.ts";
import { findVskillBinary, makeRunCli } from "./ProjectSkillsActionsCommon.ts";

const projectId = ProjectId.make("project-skills-actions");
const skillId = "anton-abyzov/vskill/sw-do";

it.effect.each(["win32", "linux"] as const)(
  "returns null when vskill is absent on %s",
  (platform) =>
    findVskillBinary({
      home: platform === "win32" ? "C:\\Missing" : "/missing",
      pathEnv: "",
      platform,
    }).pipe(
      Effect.tap((found) => Effect.sync(() => expect(found).toBe(null))),
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provide(platform === "win32" ? NodeEffectPath.layerWin32 : NodeEffectPath.layerPosix),
    ),
);

it.effect("prepends the command folder with a Windows PATH delimiter", () =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const run = yield* makeRunCli.pipe(
      Effect.provide(
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return {
                code: 0,
                stdout: "",
                stderr: "",
                timedOut: false,
              } as ProcessRunner.ProcessRunOutput;
            }),
        }),
      ),
    );
    yield* run({
      command: "C:\\Tools\\vskill.cmd",
      args: ["versions"],
      cwd: "C:\\Project",
      timeout: "1 second",
      env: { PATH: "C:\\Node;D:\\Bin" },
    });
    expect(calls[0]?.env?.PATH).toBe("C:\\Tools;C:\\Node;D:\\Bin");
  }).pipe(
    Effect.provide(NodeEffectPath.layerWin32),
    Effect.provideService(HostProcessPlatform, "win32"),
  ),
);

it.live.each([false, true])("finds a Windows npm shim with user-folder fallback=%s", (fallback) =>
  Effect.gen(function* () {
    const bin = `C:\\Program Files\\project-skills-${fallback}`;
    const appData = "D:\\User Apps";
    const expected = `${fallback ? `${appData}\\npm` : bin}\\vskill.cmd`;
    const noop = FileSystem.makeNoop({});
    const fs = FileSystem.makeNoop({
      stat: (file) =>
        file === expected
          ? Effect.succeed({ type: "File", size: 100n, mode: 0 } as never)
          : noop.stat(file),
    });
    const found = yield* findVskillBinary({
      home: "C:\\User",
      pathEnv: fallback ? "" : bin,
      platform: "win32",
      appData,
      pathExt: ".CMD",
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(NodeEffectPath.layerWin32),
    );
    expect(found).toBe(expected);
  }),
);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempDir = (prefix: string) =>
  Effect.promise(async () => {
    const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  });
const write = (file: string, text: string, mode?: number) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(join(file, ".."), { recursive: true });
    await NodeFSP.writeFile(file, text, mode === undefined ? {} : { mode });
  });
const read = (file: string) => Effect.promise(() => NodeFSP.readFile(file, "utf8"));
const readOr = (file: string) =>
  Effect.promise(() => NodeFSP.readFile(file, "utf8").catch(() => ""));

/**
 * A stand-in vskill: logs `<cwd>|<argv>`, prints `versions.json` or
 * `outdated.json` (exiting 1, as vskill does when something is outdated), and
 * for writes copies `next.lock` over the lock in its working folder, or fails
 * with exit 3 when a `fail` file is there.
 */
const FAKE_VSKILL = String.raw`
import { appendFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
appendFileSync(join(dir, 'argv.log'), process.cwd() + '|' + args.join(' ') + '\n');
if (args[0] === 'versions') process.stdout.write(readFileSync(join(dir, 'versions.json')));
if (args[0] === 'outdated') {
  process.stdout.write(readFileSync(join(dir, 'outdated.json')));
  process.exit(1);
}
if (['install', 'pin', 'unpin'].includes(args[0])) {
  if (existsSync(join(dir, 'fail'))) { process.stderr.write('registry said no'); process.exit(3); }
  if (existsSync(join(dir, 'next.lock'))) copyFileSync(join(dir, 'next.lock'), join(process.cwd(), 'vskill.lock'));
}
`;

const lockText = (entry: { version: string; pinnedVersion?: string }) =>
  `${JSON.stringify(
    {
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
      skills: {
        "sw-do": { ...entry, sha: "abc", source: "github:anton-abyzov/vskill", tier: "VERIFIED" },
      },
    },
    null,
    2,
  )}\n`;

const VERSIONS = JSON.stringify([
  { version: "1.2.0", certTier: "VERIFIED", createdAt: "2026-10-20", installed: false },
  { version: "1.1.0", certTier: "VERIFIED", createdAt: "2026-10-10", installed: false },
  { version: "1.0.0", certTier: "VERIFIED", createdAt: "2026-10-01", installed: true },
]);
const OUTDATED = JSON.stringify([
  { name: "sw-do", installed: "1.0.0", latest: "1.2.0", updateAvailable: true, pinned: false },
]);

const rowFor = (lock: ProjectSkillLock | null): ProjectSkillRow =>
  ({
    name: "sw-do",
    status: "ok",
    attention: false,
    issues: [],
    path: "/nonexistent/sw-do/SKILL.md",
    scopes: ["project"],
    providers: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        label: "Claude",
        path: "/nonexistent/sw-do/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ],
    lock,
    drift: "match",
    copies: 1,
    divergent: false,
    doctor: [],
  }) as never;

const lockFor = (
  lockPath: string,
  scope: "project" | "user",
  extra: Partial<ProjectSkillLock> = {},
): ProjectSkillLock => ({
  lockPath,
  lockScope: scope,
  version: "1.0.0",
  tier: "VERIFIED",
  source: "github:anton-abyzov/vskill",
  sha: "abc",
  installedAt: null,
  name: "sw-do",
  pinnedVersion: null,
  skillId,
  ...extra,
});

interface Fixture {
  readonly bin: string;
  readonly home: string;
  readonly project: string;
  readonly lockPath: string;
  readonly writes: Array<{ cwd: string; instanceIds: ReadonlyArray<string> }>;
  readonly service: Effect.Success<ReturnType<typeof makeProjectSkillsActions>>;
}

/** A project with a `.specweave/config.json` and a lock, a fake vskill and a temp HOME. */
const fixture = (options: {
  readonly lock?: { version: string; pinnedVersion?: string };
  readonly rowLock?: (lockPath: string, home: string) => ProjectSkillLock | null;
  readonly projectMarker?: boolean;
}) =>
  Effect.gen(function* () {
    const root = yield* tempDir("project-skills-actions-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const project = join(root, "project");
    const platform = yield* HostProcessPlatform;
    yield* Effect.sync(() =>
      writeFakeCli({ directory: bin, name: "vskill", source: FAKE_VSKILL, platform }),
    );
    yield* write(join(bin, "versions.json"), VERSIONS);
    yield* write(join(bin, "outdated.json"), OUTDATED);
    yield* Effect.promise(() => NodeFSP.mkdir(home, { recursive: true }));
    if (options.projectMarker !== false)
      yield* write(join(project, ".specweave", "config.json"), "{}\n");
    const lockPath = join(project, "vskill.lock");
    yield* write(lockPath, lockText(options.lock ?? { version: "1.0.0" }));
    const writes: Fixture["writes"] = [];
    const ctx: SkillsActionContext = {
      projectId,
      cwd: project,
      row: rowFor(options.rowLock ? options.rowLock(lockPath, home) : lockFor(lockPath, "project")),
    };
    const deps: ProjectSkillsActionsDeps = {
      home,
      environment: {
        PATH: [
          bin,
          dirname(process.execPath),
          ...(platform === "win32" ? [] : ["/usr/bin", "/bin"]),
        ].join(platform === "win32" ? ";" : ":"),
      },
      platform,
      backupDir: undefined,
      resolveRow: () => Effect.succeed(ctx),
      agentControl: () => Effect.succeed(undefined),
      codexClient: () => Effect.die("no Codex in these tests"),
      afterWrite: (input) =>
        Effect.sync(() => {
          writes.push({ cwd: input.cwd, instanceIds: input.instanceIds });
        }),
    };
    const service = yield* makeProjectSkillsActions(deps);
    return { bin, home, project, lockPath, writes, service } satisfies Fixture;
  });

const live = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const argvLog = (fx: Fixture) =>
  readOr(join(fx.bin, "argv.log")).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line !== "")),
  );
const action = (
  action: ProjectSkillsActionInput["action"],
  fields: Partial<Omit<ProjectSkillsActionInput, "action">> = {},
): ProjectSkillsActionInput =>
  ({ projectId, skill: "sw-do", preview: false, ...fields, action }) as ProjectSkillsActionInput;

describe("vskill argv and output", () => {
  it("runs a fixed argv for every action", () => {
    expect(vskillArgs.versions(skillId)).toEqual(["versions", skillId, "--json"]);
    expect(vskillArgs.outdated(false)).toEqual(["outdated", "--json"]);
    expect(vskillArgs.outdated(true)).toEqual(["outdated", "--json", "--global"]);
    expect(vskillArgs.install(skillId, "1.2.3", false)).toEqual([
      "install",
      `${skillId}@1.2.3`,
      "-y",
    ]);
    expect(vskillArgs.install(skillId, "1.2.3", true)).toEqual([
      "install",
      `${skillId}@1.2.3`,
      "-y",
      "--global",
    ]);
    expect(vskillArgs.pin("sw-do", "1.2.3")).toEqual(["pin", "sw-do", "1.2.3"]);
    expect(vskillArgs.unpin("sw-do")).toEqual(["unpin", "sw-do"]);
  });

  it("reads versions and outdated output, and nothing from other output", () => {
    expect(parseVersionsOutput(VERSIONS)?.map((entry) => entry.version)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
    expect(parseVersionsOutput("Fetching versions...")).toBeUndefined();
    expect(parseOutdatedOutput(OUTDATED, "sw-do")).toEqual({
      latest: "1.2.0",
      updateAvailable: true,
      pinned: false,
      pinnedVersion: null,
    });
    expect(
      parseOutdatedOutput(
        JSON.stringify({ results: [{ name: "sw-do", latest: "2.0.0", pinnedVersion: "1.0.0" }] }),
        "sw-do",
      ),
    ).toEqual({ latest: "2.0.0", updateAvailable: false, pinned: true, pinnedVersion: "1.0.0" });
    expect(parseOutdatedOutput(OUTDATED, "other")).toBeNull();
    expect(parseOutdatedOutput("not json", "sw-do")).toBeNull();
  });
});

describe("ProjectSkillsActions with a stand-in vskill", () => {
  it.live("lists versions and reads outdated even though it exits 1", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      const result = yield* fx.service.versions({ projectId, skill: "sw-do" });
      expect(result).toMatchObject({
        skill: "sw-do",
        skillId,
        lockScope: "project",
        installedVersion: "1.0.0",
        pinnedVersion: null,
        outdated: { latest: "1.2.0", updateAvailable: true },
      });
      expect(result.versions.map((entry) => entry.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
      const log = yield* argvLog(fx);
      expect(log).toContain(`${fx.project}|versions ${skillId} --json`);
      expect(log).toContain(`${fx.project}|outdated --json`);
    }).pipe(Effect.provide(live)),
  );

  it.live("previews an install without running it, then installs and reads the lock back", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      const before = yield* read(fx.lockPath);
      const preview = yield* fx.service.action(
        action({ kind: "install-version", version: "1.1.0" }, { preview: true }),
      );
      expect(preview).toEqual({
        preview: {
          argv: ["vskill", "install", `${skillId}@1.1.0`, "-y"],
          files: [fx.lockPath],
          summary: expect.stringContaining(`${skillId}@1.1.0`),
          liveness: "next-session",
          expected: { lockSha: sha256([before], "hex"), targetVersion: "1.1.0" },
        },
      });
      expect((yield* argvLog(fx)).some((line) => line.includes("|install"))).toBe(false);
      expect(fx.writes).toEqual([]);

      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.1.0", pinnedVersion: "1.1.0" }),
      );
      const applied = yield* fx.service.action(
        action(
          { kind: "install-version", version: "1.1.0" },
          { expected: { lockSha: sha256([before], "hex") } },
        ),
      );
      expect(applied).toMatchObject({
        applied: true,
        liveness: "next-session",
        installedVersion: "1.1.0",
        pinnedVersion: "1.1.0",
      });
      expect(yield* argvLog(fx)).toContain(`${fx.project}|install ${skillId}@1.1.0 -y`);
      expect(fx.writes).toEqual([{ cwd: fx.project, instanceIds: ["claudeAgent"] }]);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses a version the registry does not list and a lock that changed", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      const missing = yield* fx.service
        .action(action({ kind: "install-version", version: "9.9.9" }))
        .pipe(Effect.flip);
      expect(missing.reason).toBe("version_not_found");
      const stale = yield* fx.service
        .action(
          action({ kind: "pin", version: "1.0.0" }, { expected: { lockSha: "0".repeat(64) } }),
        )
        .pipe(Effect.flip);
      expect(stale.reason).toBe("stale");
      expect((yield* argvLog(fx)).some((line) => /\|(install|pin) /.test(line))).toBe(false);
    }).pipe(Effect.provide(live)),
  );

  it.live("updates to latest and drops the pin the install sets when there was none", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.2.0", pinnedVersion: "1.2.0" }),
      );
      const preview = yield* fx.service.action(
        action({ kind: "update-latest" }, { preview: true }),
      );
      if (!("preview" in preview)) throw new Error("Expected version preview");
      const applied = yield* fx.service.action(
        action({ kind: "update-latest" }, { expected: preview.preview.expected }),
      );
      expect(applied).toMatchObject({
        applied: true,
        installedVersion: "1.2.0",
        pinnedVersion: null,
      });
      const lock = yield* read(fx.lockPath);
      expect(lock).toContain('"version": "1.2.0"');
      expect(lock).not.toContain("pinnedVersion");
      expect(lock).toContain('"tier": "VERIFIED"');
      const log = yield* argvLog(fx);
      expect(log.filter((line) => !line.includes("|versions "))).toEqual([
        `${fx.project}|install ${skillId}@1.2.0 -y`,
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses registry drift and missing preview before updating latest", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      const preview = yield* fx.service.action(
        action({ kind: "update-latest" }, { preview: true }),
      );
      if (!("preview" in preview)) throw new Error("Expected version preview");
      expect(preview.preview.expected.targetVersion).toBe("1.2.0");
      yield* write(
        join(fx.bin, "versions.json"),
        JSON.stringify([{ version: "1.3.0" }, { version: "1.2.0" }]),
      );
      const changed = yield* fx.service
        .action(action({ kind: "update-latest" }, { expected: preview.preview.expected }))
        .pipe(Effect.flip);
      expect(changed.reason).toBe("stale");
      const missing = yield* fx.service.action(action({ kind: "update-latest" })).pipe(Effect.flip);
      expect(missing.reason).toBe("stale");
      expect((yield* argvLog(fx)).some((line) => line.includes("|install "))).toBe(false);
      expect(fx.writes).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("keeps the pin on update when the skill was pinned before", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0", pinnedVersion: "1.0.0" } });
      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.2.0", pinnedVersion: "1.2.0" }),
      );
      const preview = yield* fx.service.action(
        action({ kind: "update-latest" }, { preview: true }),
      );
      if (!("preview" in preview)) throw new Error("Expected version preview");
      const applied = yield* fx.service.action(
        action({ kind: "update-latest" }, { expected: preview.preview.expected }),
      );
      expect(applied).toMatchObject({ installedVersion: "1.2.0", pinnedVersion: "1.2.0" });
    }).pipe(Effect.provide(live)),
  );

  it.live("checks pin and unpin against the lock, not vskill's word", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      // vskill exits 0 but leaves the lock unpinned.
      yield* write(join(fx.bin, "next.lock"), lockText({ version: "1.0.0" }));
      const unpinned = yield* fx.service
        .action(action({ kind: "pin", version: "1.0.0" }))
        .pipe(Effect.flip);
      expect(unpinned.reason).toBe("cli_failed");
      expect(unpinned.detail).toContain("unpinned");
      expect(fx.writes).toEqual([]);

      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.0.0", pinnedVersion: "1.0.0" }),
      );
      const pinned = yield* fx.service.action(action({ kind: "pin", version: "1.0.0" }));
      expect(pinned).toMatchObject({ installedVersion: "1.0.0", pinnedVersion: "1.0.0" });

      yield* write(join(fx.bin, "next.lock"), lockText({ version: "1.0.0" }));
      const unpin = yield* fx.service.action(action({ kind: "unpin" }));
      expect(unpin).toMatchObject({ pinnedVersion: null });
      const log = yield* argvLog(fx);
      expect(log).toContain(`${fx.project}|pin sw-do 1.0.0`);
      expect(log).toContain(`${fx.project}|unpin sw-do`);
    }).pipe(Effect.provide(live)),
  );

  it.live("reports a failed run with its exit code and the end of its output", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      yield* write(join(fx.bin, "fail"), "");
      const failed = yield* fx.service
        .action(action({ kind: "install-version", version: "1.1.0" }))
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ reason: "cli_failed", exitCode: 3 });
      expect(failed.stderrTail).toContain("registry said no");
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "refuses a pin that would change another project's lock, and installs in the lock's folder",
    () =>
      Effect.gen(function* () {
        // The lock's folder has no .specweave/config.json, but a folder above it does.
        const nested = (lockPath: string) => join(lockPath, "..", "nested", "vskill.lock");
        const fx = yield* fixture({
          projectMarker: false,
          rowLock: (lockPath) => lockFor(nested(lockPath), "project"),
        });
        yield* write(join(fx.project, ".specweave", "config.json"), "{}\n");
        yield* write(nested(fx.lockPath), lockText({ version: "1.0.0" }));
        // `vskill pin` walks up to the project root, so it would change the outer lock.
        const refused = yield* fx.service
          .action(action({ kind: "pin", version: "1.0.0" }))
          .pipe(Effect.flip);
        expect(refused.reason).toBe("scope_unsupported");
        expect((yield* argvLog(fx)).some((line) => line.includes("|pin"))).toBe(false);

        // `vskill install` writes the lock of the folder it runs in: the nested one.
        yield* write(
          join(fx.bin, "next.lock"),
          lockText({ version: "1.1.0", pinnedVersion: "1.1.0" }),
        );
        const installed = yield* fx.service.action(
          action({ kind: "install-version", version: "1.1.0" }),
        );
        expect(installed).toMatchObject({ installedVersion: "1.1.0", pinnedVersion: "1.1.0" });
        expect(yield* argvLog(fx)).toContain(
          `${join(fx.project, "nested")}|install ${skillId}@1.1.0 -y`,
        );
        expect(yield* read(fx.lockPath)).toContain('"version": "1.0.0"');
      }).pipe(Effect.provide(live)),
  );

  it.live("refuses writes for a user skill recorded only in the older ~/vskill.lock", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        rowLock: (_, home) => lockFor(join(home, "vskill.lock"), "user"),
      });
      yield* write(join(fx.home, "vskill.lock"), lockText({ version: "1.0.0" }));
      for (const kind of [
        { kind: "install-version", version: "1.1.0" },
        { kind: "update-latest" },
      ] as const) {
        const refused = yield* fx.service.action(action(kind)).pipe(Effect.flip);
        expect(refused.reason).toBe("scope_unsupported");
        expect(refused.message).toContain(join(fx.home, ".agents", "vskill.lock"));
        const preview = yield* fx.service.action(action(kind, { preview: true })).pipe(Effect.flip);
        expect(preview.reason).toBe("scope_unsupported");
      }
      expect((yield* argvLog(fx)).some((line) => line.includes("|install"))).toBe(false);
      // Reading its versions still works.
      expect((yield* fx.service.versions({ projectId, skill: "sw-do" })).lockScope).toBe("user");
    }).pipe(Effect.provide(live)),
  );

  it.live("installs with pin: false and drops the pin, as Undo of an unpinned change does", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.1.0" } });
      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.0.0", pinnedVersion: "1.0.0" }),
      );
      const kind = { kind: "install-version", version: "1.0.0", pin: false } as const;
      const preview = yield* fx.service.action(action(kind, { preview: true }));
      expect(preview).toMatchObject({
        preview: { summary: expect.stringContaining("then drop the pin the install sets") },
      });
      const applied = yield* fx.service.action(action(kind));
      expect(applied).toMatchObject({ installedVersion: "1.0.0", pinnedVersion: null });
      expect(yield* read(fx.lockPath)).not.toContain("pinnedVersion");
    }).pipe(Effect.provide(live)),
  );

  it.live("checks the lock inside the queue, so a second apply of one preview is stale", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: { version: "1.0.0" } });
      const lockSha = sha256([yield* read(fx.lockPath)], "hex");
      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.1.0", pinnedVersion: "1.1.0" }),
      );
      const apply = fx.service
        .action(action({ kind: "install-version", version: "1.1.0" }, { expected: { lockSha } }))
        .pipe(Effect.result);
      const results = yield* Effect.all([apply, apply], { concurrency: "unbounded" });
      const failures = results.filter((result) => result._tag === "Failure");
      expect(failures).toHaveLength(1);
      expect(failures[0]!.failure.reason).toBe("stale");
      expect((yield* argvLog(fx)).filter((line) => line.includes("|install "))).toHaveLength(1);
    }).pipe(Effect.provide(live)),
  );

  it.live("pins project locks only and installs user locks with --global from HOME", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        rowLock: (_, home) => lockFor(join(home, ".agents", "vskill.lock"), "user"),
      });
      const refused = yield* fx.service
        .action(action({ kind: "pin", version: "1.0.0" }))
        .pipe(Effect.flip);
      expect(refused.reason).toBe("scope_unsupported");
      const preview = yield* fx.service.action(
        action({ kind: "install-version", version: "1.1.0" }, { preview: true }),
      );
      expect(preview).toMatchObject({
        preview: { argv: ["vskill", "install", `${skillId}@1.1.0`, "-y", "--global"] },
      });
      const lock = join(fx.home, ".agents", "vskill.lock");
      yield* write(lock, lockText({ version: "1.0.0" }));
      yield* write(
        join(fx.bin, "next.lock"),
        lockText({ version: "1.1.0", pinnedVersion: "1.1.0" }),
      );
      // The stand-in writes the lock in its working folder; vskill itself writes the user lock.
      yield* fx.service
        .action(action({ kind: "install-version", version: "1.1.0" }))
        .pipe(Effect.flip);
      expect(yield* argvLog(fx)).toContain(`${fx.home}|install ${skillId}@1.1.0 -y --global`);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses version actions for a skill no registry lock names", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        rowLock: (lockPath) => lockFor(lockPath, "project", { skillId: null }),
      });
      const refused = yield* fx.service.versions({ projectId, skill: "sw-do" }).pipe(Effect.flip);
      expect(refused.reason).toBe("not_registry_skill");
      const none = yield* fixture({ rowLock: () => null });
      const noLock = yield* none.service
        .action(action({ kind: "update-latest" }))
        .pipe(Effect.flip);
      expect(noLock.reason).toBe("not_registry_skill");
    }).pipe(Effect.provide(live)),
  );
});
