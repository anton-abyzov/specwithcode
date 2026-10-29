import {
  AuthEnvironmentMaintainScope,
  AuthFleetSkillsScope,
  AuthFleetUpdateScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { StudioFleetSkillInput } from "@specweave-studio/contracts/studioFleet";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeEffectPath from "@effect/platform-node/NodePath";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real key files, fake vskill binaries and locks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { writeFakeCli } from "../testUtils/fakeCli.ts";

import { fleetSkillAskOfFlags, fleetSkillTargetsOf } from "../cli/fleet.ts";
import { dirname, join } from "../nodePath.ts";
import type { FleetTarget } from "../studioFleet.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { FLEET_INVITE_MAKER_SCOPES, FLEET_INVITE_SCOPES } from "./fleetRedemption.ts";
import { loadOrCreateFleetProofKey } from "./fleetProofKey.ts";
import {
  type FleetSkillAsk,
  type FleetSkillLockEntry,
  type FleetSkillWorkerDeps,
  fleetSkillInstallArgs,
  fleetSkillsAllowed,
  FleetSkillWorker,
  isFleetSkillName,
  layer as fleetSkillsLayer,
  lockEntryOf,
  lockWithoutPin,
  makeFleetSkillWorker,
  runFleetSkillInstall,
  runFleetSkillInstalls,
  vskillSearchDirs,
} from "./fleetSkills.ts";
import { makeFleetAddressBook, makeFleetLink } from "./fleetTransport.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempDir = async (prefix: string) => {
  const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// Rules: scope, input and argv
// ---------------------------------------------------------------------------

const coordinator = (environmentId: string, scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  principal: { kind: "coordinator", environmentId },
  scopes: new Set(scopes),
});

describe("fleet skill rules", () => {
  it("lets only the fleet primary's token in, by fleet:skills or environment:maintain", () => {
    expect(fleetSkillsAllowed(coordinator("env-m4", [AuthFleetSkillsScope]), "env-m4")).toBe(true);
    // Tokens issued before fleet:skills existed hold environment:maintain.
    expect(
      fleetSkillsAllowed(coordinator("env-m4", [AuthEnvironmentMaintainScope]), "env-m4"),
    ).toBe(true);
    expect(fleetSkillsAllowed(coordinator("env-m4", [...AuthStandardClientScopes]), "env-m4")).toBe(
      true,
    );
    // fleet:update alone is the release path, not skills.
    expect(fleetSkillsAllowed(coordinator("env-m4", [AuthFleetUpdateScope]), "env-m4")).toBe(false);
    expect(
      fleetSkillsAllowed(
        coordinator("env-m4", [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
        "env-m4",
      ),
    ).toBe(false);
    expect(fleetSkillsAllowed(coordinator("env-other", [AuthFleetSkillsScope]), "env-m4")).toBe(
      false,
    );
    expect(
      fleetSkillsAllowed(
        { principal: { kind: "owner" }, scopes: new Set([AuthFleetSkillsScope]) },
        "env-m4",
      ),
    ).toBe(false);
    expect(fleetSkillsAllowed({ scopes: new Set([AuthFleetSkillsScope]) }, "env-m4")).toBe(false);
  });

  it("hands fleet:skills out on new invitations without asking the inviter for it", () => {
    expect(FLEET_INVITE_SCOPES).toContain(AuthFleetSkillsScope);
    expect(FLEET_INVITE_MAKER_SCOPES).not.toContain(AuthFleetSkillsScope);
    expect(FLEET_INVITE_MAKER_SCOPES).toContain(AuthEnvironmentMaintainScope);
  });

  const decode = Schema.decodeUnknownOption(StudioFleetSkillInput);
  const valid = {
    coordinatorEnvironmentId: "env-m4",
    skill: "anton-abyzov/vskill/sw-do",
    version: "1.2.3",
    scope: "user",
    pin: true,
  };

  it("takes a published owner/repo/name at an exact version, user or one project by id", () => {
    expect(Option.isSome(decode(valid))).toBe(true);
    expect(Option.isSome(decode({ ...valid, scope: "project", projectId: "proj-1" }))).toBe(true);
    expect(Option.isSome(decode({ ...valid, skill: "anthropics/skills/webapp-testing" }))).toBe(
      true,
    );
  });

  it("refuses shell metacharacters, paths, URLs, local: sources and anything extra", () => {
    const skills = [
      "anton-abyzov/vskill/sw-do; rm -rf ~",
      "anton-abyzov/vskill/$(whoami)",
      "anton-abyzov/vskill/`id`",
      "anton-abyzov/vskill/a|b",
      "anton-abyzov/vskill/a&&b",
      "anton-abyzov/vskill/a b",
      "anton-abyzov/vskill/a\nb",
      "local:/Users/me/skills/x",
      "local:anton/vskill/x",
      "github:anton-abyzov/vskill",
      "/etc/passwd",
      "../../etc/passwd",
      "anton-abyzov/../sw-do",
      "anton-abyzov/vskill/..",
      "./anton/vskill/x",
      "~/skills/x",
      "https://github.com/anton-abyzov/vskill/sw-do",
      "anton-abyzov/vskill",
      "anton-abyzov/vskill/sw-do/extra",
      "-y/vskill/sw-do",
      "anton-abyzov/vskill/--global",
      "anton-abyzov/vskill/sw-do@1.0.0",
      "",
    ];
    for (const skill of skills) {
      expect(isFleetSkillName(skill), skill).toBe(false);
      expect(Option.isNone(decode({ ...valid, skill })), skill).toBe(true);
    }
    for (const version of ["latest", "^1.2.3", "1.2", "1.2.3-beta.1", "01.2.3", "1.2.3; ls", ""])
      expect(Option.isNone(decode({ ...valid, version })), version).toBe(true);
    for (const body of [
      { ...valid, command: "rm -rf /" },
      { ...valid, cwd: "/tmp" },
      { ...valid, projectId: "proj-1" },
      { ...valid, scope: "project" },
      { ...valid, scope: "project", projectRoot: "/Users/me/project", projectId: "p" },
      { ...valid, scope: "global" },
      { ...valid, url: "https://example.com/skill.tgz" },
      { ...valid, pin: "yes" },
    ])
      expect(Option.isNone(decode(body)), JSON.stringify(body)).toBe(true);
  });

  it("runs exactly vskill install <skill>@<v> -y, --global for the user, and unpin by lock name", () => {
    const user: FleetSkillAsk = {
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      pin: true,
      scope: "user",
    };
    expect(fleetSkillInstallArgs(user)).toEqual([
      "install",
      "anton-abyzov/vskill/sw-do@1.2.3",
      "-y",
      "--global",
    ]);
    expect(fleetSkillInstallArgs({ ...user, scope: "project", projectId: "p1" })).toEqual([
      "install",
      "anton-abyzov/vskill/sw-do@1.2.3",
      "-y",
    ]);
  });

  it("drops one pin from a lock and keeps everything else in it", () => {
    const text = JSON.stringify({
      version: 1,
      agents: ["claude-code"],
      updatedAt: "2026-10-01T00:00:00.000Z",
      skills: {
        "sw-do": { version: "1.2.3", pinnedVersion: "1.2.3", sha: "x", source: "github:a/b" },
        other: { version: "2.0.0", pinnedVersion: "2.0.0" },
      },
    });
    const next = lockWithoutPin(text, "sw-do", "2026-10-28T15:00:00.000Z");
    expect(next?.endsWith("\n")).toBe(true);
    expect(JSON.parse(next ?? "")).toEqual({
      version: 1,
      agents: ["claude-code"],
      updatedAt: "2026-10-28T15:00:00.000Z",
      skills: {
        "sw-do": { version: "1.2.3", sha: "x", source: "github:a/b" },
        other: { version: "2.0.0", pinnedVersion: "2.0.0" },
      },
    });
    expect(lockWithoutPin(text, "missing", "now")).toBeNull();
    expect(lockWithoutPin("not json", "sw-do", "now")).toBeNull();
    expect(lockWithoutPin('{"skills":{"sw-do":"1.2.3"}}', "sw-do", "now")).toBeNull();
    expect(lockWithoutPin('{"skills":{"constructor":{}}}', "toString", "now")).toBeNull();
  });

  it("looks for vskill on PATH, then ~/.local/bin, Homebrew, /usr/local/bin and npm's global bin", () => {
    expect(
      vskillSearchDirs({
        home: "/Users/me",
        platform: "darwin",
        pathEnv: "/usr/bin:relative/bin:/opt/homebrew/bin",
        npmGlobalBin: "/Users/me/.npm-global/bin",
      }),
    ).toEqual([
      "/usr/bin",
      "/opt/homebrew/bin",
      "/Users/me/.local/bin",
      "/usr/local/bin",
      "/Users/me/.npm-global/bin",
    ]);
  });

  it("keeps Windows drive letters and UNC shares intact and excludes relative PATH entries", () => {
    expect(
      vskillSearchDirs({
        home: "C:\\Users\\Me",
        platform: "win32",
        appData: "D:\\Roaming",
        pathEnv:
          '"C:\\Program Files\\nodejs";C:\\Tools;relative;C:relative;\\\\server\\tools;C:\\Tools',
        npmGlobalBin: "D:\\npm-global",
      }),
    ).toEqual([
      "C:\\Program Files\\nodejs",
      "C:\\Tools",
      "\\\\server\\tools",
      "C:\\Users\\Me/.local/bin",
      "D:\\Roaming/npm",
      "D:\\npm-global",
    ]);
  });

  it("reads one lock entry with its pin, and nothing from a broken lock", () => {
    const lock = {
      version: 1,
      skills: {
        "sw-do": { version: "1.2.3", sha: "x", pinnedVersion: "1.2.3" },
        other: { sha: "missing version" },
      },
    };
    expect(lockEntryOf(JSON.stringify(lock), "sw-do")).toEqual({
      version: "1.2.3",
      pinnedVersion: "1.2.3",
    });
    expect(lockEntryOf(JSON.stringify(lock), "other")).toBeNull();
    expect(lockEntryOf(JSON.stringify(lock), "absent")).toBeNull();
    expect(lockEntryOf(JSON.stringify(lock), "__proto__")).toBeNull();
    expect(lockEntryOf("{not json", "sw-do")).toBeNull();
  });

  it("builds the ask from the CLI flags, and refuses bad names before reaching any machine", () => {
    const flags = {
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      scope: "user" as const,
      project: Option.none<string>(),
      noPin: false,
    };
    expect(fleetSkillAskOfFlags(flags)).toEqual({
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      pin: true,
      scope: "user",
    });
    expect(
      fleetSkillAskOfFlags({ ...flags, scope: "project", project: Option.some("p1"), noPin: true }),
    ).toEqual({
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      pin: false,
      scope: "project",
      projectId: "p1",
    });
    expect(fleetSkillAskOfFlags({ ...flags, skill: "local:/tmp/x" })).toMatchObject({
      reason: "invalid-skill",
    });
    expect(fleetSkillAskOfFlags({ ...flags, version: "latest" })).toMatchObject({
      reason: "invalid-skill",
    });
    expect(fleetSkillAskOfFlags({ ...flags, scope: "project" })).toMatchObject({
      reason: "usage",
    });
    expect(fleetSkillAskOfFlags({ ...flags, project: Option.some("p1") })).toMatchObject({
      reason: "usage",
    });
  });

  it("asks one named machine or, with --all, every saved one", () => {
    const machine = (id: string): FleetTarget => ({
      id,
      label: `Mac ${id.toUpperCase()}`,
      environmentId: EnvironmentId.make(`env-${id}`),
      url: `https://${id}.fixture.ts.net`,
      scopes: [AuthOrchestrationReadScope],
    });
    const machines = [machine("m1"), machine("m3")];
    expect(fleetSkillTargetsOf(machines, Option.some("mac m3"), false)).toEqual([machines[1]]);
    expect(fleetSkillTargetsOf(machines, Option.none(), true)).toEqual(machines);
    expect(fleetSkillTargetsOf(machines, Option.some("m1"), true)).toMatchObject({
      reason: "usage",
    });
    expect(fleetSkillTargetsOf(machines, Option.none(), false)).toMatchObject({ reason: "usage" });
    expect(fleetSkillTargetsOf(machines, Option.some("nope"), false)).toMatchObject({
      reason: "unknown-machine",
    });
    expect(fleetSkillTargetsOf([], Option.none(), true)).toMatchObject({
      reason: "unknown-machine",
    });
  });
});

// ---------------------------------------------------------------------------
// The worker: a fake vskill, project registry and lock
// ---------------------------------------------------------------------------

interface RunCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

function worker(
  options: {
    readonly vskill?: string | null;
    readonly projects?: Record<string, string>;
    readonly installExit?: number | null;
    readonly installStderr?: string;
    readonly dropPinWorks?: boolean;
    readonly lock?: FleetSkillLockEntry | null;
    readonly lockAfterUnpin?: FleetSkillLockEntry | null;
    readonly installDelayMs?: number;
    readonly prepareDelayMs?: number;
  } = {},
) {
  const calls: RunCall[] = [];
  const lockReads: string[] = [];
  const pinDrops: Array<{ readonly dir: string; readonly name: string }> = [];
  let unpinned = false;
  const deps: FleetSkillWorkerDeps = {
    resolveVskill: Effect.succeed(
      options.vskill === undefined ? "/opt/homebrew/bin/vskill" : options.vskill,
    ),
    home: "/Users/me",
    projectRoot: (id) =>
      Effect.as(
        options.prepareDelayMs === undefined
          ? Effect.void
          : Effect.sleep(`${options.prepareDelayMs} millis`),
        options.projects?.[id] ?? null,
      ),
    run: ({ command, args, cwd }) =>
      Effect.gen(function* () {
        calls.push({ command, args, cwd });
        if (options.installDelayMs !== undefined)
          yield* Effect.sleep(`${options.installDelayMs} millis`);
        return {
          exitCode: options.installExit === undefined ? 0 : options.installExit,
          stdout: "Installed",
          stderr: options.installStderr ?? "",
          timedOut: false,
        };
      }),
    dropPin: (dir, name) =>
      Effect.sync(() => {
        pinDrops.push({ dir, name });
        if (options.dropPinWorks === false) return false;
        unpinned = true;
        return true;
      }),
    readLock: (dir) =>
      Effect.sync(() => {
        lockReads.push(dir);
        if (dir === "/Users/me") return null;
        if (unpinned && options.lockAfterUnpin !== undefined) return options.lockAfterUnpin;
        return options.lock === undefined
          ? { version: "1.2.3", pinnedVersion: unpinned ? null : "1.2.3" }
          : options.lock;
      }),
  };
  return Effect.map(makeFleetSkillWorker(deps), (service) => ({
    calls,
    lockReads,
    pinDrops,
    service,
  }));
}

const userAsk: FleetSkillAsk = {
  skill: "anton-abyzov/vskill/sw-do",
  version: "1.2.3",
  pin: true,
  scope: "user",
};

/** The status once the install the worker answered for has finished. */
const settled = (service: FleetSkillWorker["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const status = yield* service.status;
      if (status.phase === "installed" || status.phase === "failed") return status;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die("the install never finished");
  });

describe("a fleet machine taking its primary's skill install", () => {
  it.live(
    "answers first, installs for the user with --global and reads the pinned version back",
    () =>
      Effect.gen(function* () {
        const { calls, lockReads, service } = yield* worker();
        const answer = yield* service.request(userAsk);
        expect(answer).toMatchObject({
          result: "accepted",
          phase: "installing",
          skill: "anton-abyzov/vskill/sw-do",
          version: "1.2.3",
          scope: "user",
        });
        expect(yield* settled(service)).toMatchObject({
          phase: "installed",
          requestId: answer.requestId,
          installedVersion: "1.2.3",
          pinnedVersion: "1.2.3",
        });
        expect(calls).toEqual([
          {
            command: "/opt/homebrew/bin/vskill",
            args: ["install", "anton-abyzov/vskill/sw-do@1.2.3", "-y", "--global"],
            cwd: "/Users/me",
          },
        ]);
        expect(lockReads).toEqual(["/Users/me/.agents"]);
      }),
  );

  it.live("installs into the project's own workspace root and drops the pin in its lock", () =>
    Effect.gen(function* () {
      const { calls, pinDrops, service } = yield* worker({
        projects: { "proj-1": "/Users/me/Projects/app" },
      });
      yield* service.request({ ...userAsk, scope: "project", projectId: "proj-1", pin: false });
      expect(yield* settled(service)).toMatchObject({
        phase: "installed",
        scope: "project",
        projectId: "proj-1",
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      expect(calls).toEqual([
        {
          command: "/opt/homebrew/bin/vskill",
          args: ["install", "anton-abyzov/vskill/sw-do@1.2.3", "-y"],
          cwd: "/Users/me/Projects/app",
        },
      ]);
      // No `vskill unpin`: it would pick its lock by a walk-up, not the one written here.
      expect(pinDrops).toEqual([{ dir: "/Users/me/Projects/app", name: "sw-do" }]);
    }),
  );

  it.live("drops a user install's pin in the user lock vskill wrote", () =>
    Effect.gen(function* () {
      const { calls, pinDrops, service } = yield* worker();
      yield* service.request({ ...userAsk, pin: false });
      expect(yield* settled(service)).toMatchObject({ phase: "installed", pinnedVersion: null });
      expect(calls).toHaveLength(1);
      expect(pinDrops).toEqual([{ dir: "/Users/me/.agents", name: "sw-do" }]);
    }),
  );

  it.live("reports install-failed when the pin cannot be dropped", () =>
    Effect.gen(function* () {
      const { service } = yield* worker({ dropPinWorks: false });
      yield* service.request({ ...userAsk, pin: false });
      expect(yield* settled(service)).toMatchObject({
        phase: "failed",
        lastErrorReason: "install-failed",
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      });
    }),
  );

  it.live(
    "refuses with vskill-missing, unknown-project and invalid-skill before running anything",
    () =>
      Effect.gen(function* () {
        const missing = yield* worker({ vskill: null });
        expect(yield* Effect.flip(missing.service.request(userAsk))).toMatchObject({
          reason: "vskill-missing",
        });
        const unknown = yield* worker({ projects: {} });
        expect(
          yield* Effect.flip(
            unknown.service.request({ ...userAsk, scope: "project", projectId: "nope" }),
          ),
        ).toMatchObject({ reason: "unknown-project" });
        const invalid = yield* worker();
        for (const ask of [
          { ...userAsk, skill: "local:/tmp/evil" },
          { ...userAsk, skill: "a/b/c; rm -rf ~" },
          { ...userAsk, version: "latest" },
        ])
          expect(yield* Effect.flip(invalid.service.request(ask))).toMatchObject({
            reason: "invalid-skill",
          });
        expect([...missing.calls, ...unknown.calls, ...invalid.calls]).toEqual([]);
        // A refusal leaves the next request free to run.
        expect((yield* invalid.service.request(userAsk)).result).toBe("accepted");
        yield* settled(invalid.service);
      }),
  );

  it.live("reports install-failed with vskill's own words when the install exits non-zero", () =>
    Effect.gen(function* () {
      const { calls, service } = yield* worker({
        installExit: 1,
        installStderr: "\u001b[31mSkill sw-do@9.9.9 not found in the registry\u001b[0m",
      });
      yield* service.request(userAsk);
      const status = yield* settled(service);
      expect(status).toMatchObject({ phase: "failed", lastErrorReason: "install-failed" });
      expect(status.lastError).toContain("exited with 1");
      expect(status.lastError).toContain("not found in the registry");
      expect(status.lastError).not.toContain("\u001b");
      expect(calls).toHaveLength(1);
    }),
  );

  it.live("reports install-failed when the lock does not record the version asked for", () =>
    Effect.gen(function* () {
      const other = yield* worker({ lock: { version: "1.2.2", pinnedVersion: null } });
      yield* other.service.request(userAsk);
      expect(yield* settled(other.service)).toMatchObject({
        phase: "failed",
        lastErrorReason: "install-failed",
        installedVersion: "1.2.2",
      });
      const none = yield* worker({ lock: null });
      yield* none.service.request(userAsk);
      expect(yield* settled(none.service)).toMatchObject({
        phase: "failed",
        lastErrorReason: "install-failed",
      });
      const stillPinned = yield* worker({
        lockAfterUnpin: { version: "1.2.3", pinnedVersion: "1.2.3" },
      });
      yield* stillPinned.service.request({ ...userAsk, pin: false });
      expect(yield* settled(stillPinned.service)).toMatchObject({
        phase: "failed",
        lastErrorReason: "install-failed",
      });
    }),
  );

  it.live("takes one install at a time", () =>
    Effect.gen(function* () {
      const { calls, service } = yield* worker({ installDelayMs: 50 });
      yield* service.request(userAsk);
      expect(yield* Effect.flip(service.request(userAsk))).toMatchObject({ reason: "busy" });
      expect(yield* settled(service)).toMatchObject({ phase: "installed" });
      expect((yield* service.request(userAsk)).result).toBe("accepted");
      yield* settled(service);
      expect(calls.filter((call) => call.args[0] === "install")).toHaveLength(2);
    }),
  );

  it.live("frees the one-install claim when a request is cut off part way", () =>
    Effect.gen(function* () {
      const { calls, service } = yield* worker({
        projects: { "proj-1": "/Users/me/Projects/app" },
        prepareDelayMs: 200,
      });
      const cut = yield* Effect.forkChild(
        service.request({ ...userAsk, scope: "project", projectId: "proj-1" }),
      );
      yield* Effect.sleep("20 millis");
      yield* Fiber.interrupt(cut);
      expect(calls).toEqual([]);
      expect((yield* service.request(userAsk)).result).toBe("accepted");
      expect(yield* settled(service)).toMatchObject({ phase: "installed" });
    }),
  );

  it.live("refuses a second request that arrives in the same instant", () =>
    Effect.gen(function* () {
      const { service } = yield* worker({ installDelayMs: 20 });
      const results = yield* Effect.all(
        [service.request(userAsk), service.request(userAsk)].map(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.find((result) => result._tag === "Failure")).toMatchObject({
        failure: { reason: "busy" },
      });
      yield* settled(service);
    }),
  );
});

// ---------------------------------------------------------------------------
// The live worker: a real process run, project registry and lock file
// ---------------------------------------------------------------------------

describe("the live fleet skill worker", () => {
  it.live.each([false, true])("resolves Windows command shims with npm fallback=%s", (fallback) =>
    Effect.gen(function* () {
      const bin = `C:\\Program Files\\fixture-node-${fallback}`;
      const prefix = "D:\\fixture-npm-global";
      const project = "C:\\fixture-project";
      const npm = `${bin}\\npm.cmd`;
      const vskill = `${fallback ? prefix : bin}\\vskill.cmd`;
      const lockPath = `${project}\\vskill.lock`;
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const noop = FileSystem.makeNoop({});
      const fs = FileSystem.makeNoop({
        stat: (file) =>
          file === project
            ? Effect.succeed({ type: "Directory" } as never)
            : [npm, vskill, lockPath].includes(file)
              ? Effect.succeed({ type: "File", size: 100n, mode: 0 } as never)
              : noop.stat(file),
        readFileString: (file) =>
          file === lockPath
            ? Effect.succeed(
                JSON.stringify({
                  skills: { "sw-do": { version: "1.2.3", pinnedVersion: "1.2.3" } },
                }),
              )
            : noop.readFileString(file),
      });
      const live = fleetSkillsLayer.pipe(
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return {
                  code: 0,
                  stdout: input.command === npm ? `${prefix}\r\n` : "",
                  stderr: "",
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                } as ProcessRunner.ProcessRunOutput;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: project } as never)),
          }),
        ),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
        Layer.provide(NodeEffectPath.layerWin32),
        Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { PATH: bin, PATHEXT: ".CMD" } })),
        ),
      );
      const service = yield* Effect.provide(FleetSkillWorker, live);
      yield* service.request({ ...userAsk, scope: "project", projectId: "proj-1" });
      const status = yield* settled(service);
      expect(status, status.lastError ?? undefined).toMatchObject({
        phase: "installed",
        installedVersion: "1.2.3",
      });
      expect(calls.map((call) => call.command)).toEqual(fallback ? [npm, vskill] : [vskill]);
      expect(calls.at(-1)).toMatchObject({
        command: vskill,
        cwd: project,
        args: ["install", "anton-abyzov/vskill/sw-do@1.2.3", "-y"],
      });
      expect(calls.at(-1)?.env?.PATH?.split(";")[0]).toBe(fallback ? prefix : bin);
    }),
  );

  it.live(
    "finds the platform vskill launcher on PATH, preserves argv and reads the project lock",
    () =>
      Effect.gen(function* () {
        const bin = yield* Effect.promise(() => tempDir("studio-fleet-skills-bin-"));
        const project = yield* Effect.promise(() => tempDir("studio-fleet-skills-project-"));
        // A stand-in vskill: records its argv and working folder, writes the lock vskill would.
        yield* Effect.sync(() =>
          writeFakeCli({
            directory: bin,
            name: "vskill",
            source: [
              'import { writeFileSync } from "node:fs";',
              'writeFileSync("argv.txt", process.argv.slice(2).join("\\n") + "\\n");',
              'writeFileSync("cwd.txt", process.cwd() + "\\n");',
              'writeFileSync("vskill.lock", JSON.stringify({version:1,skills:{"sw-do":{version:"1.2.3",pinnedVersion:"1.2.3",sha:"x"}}}));',
            ].join("\n"),
          }),
        );
        const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (id) =>
            Effect.succeed(
              id === ProjectId.make("proj-1")
                ? Option.some({ workspaceRoot: project } as never)
                : Option.none(),
            ),
        });
        const live = fleetSkillsLayer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(projects),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PATH: [
                    bin,
                    dirname(process.execPath),
                    ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
                  ].join(process.platform === "win32" ? ";" : ":"),
                },
              }),
            ),
          ),
        );
        const service = yield* Effect.provide(
          Effect.gen(function* () {
            return yield* FleetSkillWorker;
          }),
          live,
        );
        expect(
          yield* Effect.flip(
            service.request({ ...userAsk, scope: "project", projectId: "proj-2" }),
          ),
        ).toMatchObject({ reason: "unknown-project" });
        yield* service.request({ ...userAsk, scope: "project", projectId: "proj-1" });
        const status = yield* settled(service);
        expect(status, status.lastError ?? undefined).toMatchObject({
          phase: "installed",
          installedVersion: "1.2.3",
          pinnedVersion: "1.2.3",
        });
        const argv = yield* Effect.promise(() =>
          NodeFSP.readFile(join(project, "argv.txt"), "utf8"),
        );
        expect(argv.split("\n")).toEqual(["install", "anton-abyzov/vskill/sw-do@1.2.3", "-y", ""]);
        const cwd = yield* Effect.promise(() => NodeFSP.readFile(join(project, "cwd.txt"), "utf8"));
        expect(yield* Effect.promise(() => NodeFSP.realpath(cwd.trim()))).toBe(
          yield* Effect.promise(() => NodeFSP.realpath(project)),
        );
      }),
  );

  it.live("drops the pin in the project's own lock, not a parent SpecWeave project's lock", () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => tempDir("studio-fleet-skills-bin-"));
      // An umbrella with .specweave/config.json and its own lock, and a child
      // repo with neither: `vskill unpin` run in the child would edit the umbrella's.
      const umbrella = yield* Effect.promise(() => tempDir("studio-fleet-skills-umbrella-"));
      const project = join(umbrella, "repositories", "child");
      const umbrellaLock = JSON.stringify({
        version: 1,
        skills: { "sw-do": { version: "1.0.0", pinnedVersion: "1.0.0", sha: "u" } },
      });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(join(umbrella, ".specweave"), { recursive: true });
        await NodeFSP.writeFile(join(umbrella, ".specweave", "config.json"), "{}");
        await NodeFSP.writeFile(join(umbrella, "vskill.lock"), umbrellaLock);
        await NodeFSP.mkdir(project, { recursive: true });
        writeFakeCli({
          directory: bin,
          name: "vskill",
          source: [
            'import { appendFileSync, writeFileSync } from "node:fs";',
            'appendFileSync("argv.txt", process.argv.slice(2).join(" ") + "\\n");',
            'writeFileSync("vskill.lock", JSON.stringify({version:1,agents:["claude-code"],skills:{"sw-do":{version:"1.2.3",pinnedVersion:"1.2.3",sha:"x"},other:{version:"2.0.0",pinnedVersion:"2.0.0"}}}));',
          ].join("\n"),
        });
      });
      const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) =>
          Effect.succeed(
            id === ProjectId.make("proj-1")
              ? Option.some({ workspaceRoot: project } as never)
              : Option.none(),
          ),
      });
      const live = fleetSkillsLayer.pipe(
        Layer.provide(ProcessRunner.layer),
        Layer.provide(projects),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                PATH: [
                  bin,
                  dirname(process.execPath),
                  ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
                ].join(process.platform === "win32" ? ";" : ":"),
              },
            }),
          ),
        ),
      );
      const service = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* FleetSkillWorker;
        }),
        live,
      );
      yield* service.request({ ...userAsk, scope: "project", projectId: "proj-1", pin: false });
      const status = yield* settled(service);
      expect(status, status.lastError ?? undefined).toMatchObject({
        phase: "installed",
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      const argv = yield* Effect.promise(() => NodeFSP.readFile(join(project, "argv.txt"), "utf8"));
      expect(argv).toBe("install anton-abyzov/vskill/sw-do@1.2.3 -y\n");
      const childLock = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(join(project, "vskill.lock"), "utf8")),
      );
      expect(childLock.skills).toEqual({
        "sw-do": { version: "1.2.3", sha: "x" },
        other: { version: "2.0.0", pinnedVersion: "2.0.0" },
      });
      expect(childLock.agents).toEqual(["claude-code"]);
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(join(umbrella, "vskill.lock"), "utf8")),
      ).toBe(umbrellaLock);
      expect(
        (yield* Effect.promise(() => NodeFSP.readdir(project))).filter((file) =>
          file.endsWith(".tmp"),
        ),
      ).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// The primary: one command over Connect or Tailscale
// ---------------------------------------------------------------------------

const TAILNET = "https://m1.fixture.ts.net";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";
const PRIMARY = "env-m4";

const token = (jkt?: string) =>
  `${Buffer.from(JSON.stringify({ sid: "s1", ...(jkt ? { jkt } : {}) })).toString("base64url")}.sig`;

const describeMachine = (environmentId: string, capabilities: Record<string, unknown>) => ({
  environmentId,
  label: environmentId,
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.0.110",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true, ...capabilities },
});

type Answer = (request: { method: string; path: string; body: unknown }) => Response;

/** A primary with its fleet key and machines, each answering only on its `up` addresses. */
async function primary(
  machines: ReadonlyArray<{
    readonly id: string;
    readonly up: ReadonlyArray<string>;
    readonly capabilities: Record<string, unknown>;
    readonly answer: Answer;
  }>,
) {
  const baseDir = await tempDir("studio-fleet-skills-");
  const key = await loadOrCreateFleetProofKey(baseDir);
  const byOrigin = new Map<string, (typeof machines)[number]>();
  const targets = machines.map((machine, index) => {
    const tailnet = `https://${machine.id}.fixture.ts.net`;
    const connect = `https://prod-${String(index + 1).padStart(16, "0")}.spec-weave.com`;
    for (const origin of machine.up)
      byOrigin.set(origin === TAILNET ? tailnet : origin === CONNECT ? connect : origin, machine);
    return {
      id: machine.id,
      label: `Mac ${machine.id.toUpperCase()}`,
      environmentId: EnvironmentId.make(`env-${machine.id}`),
      url: tailnet,
      connectUrl: connect,
      managementToken: token(key.thumbprint),
      scopes: [AuthOrchestrationReadScope],
    };
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    const machine = byOrigin.get(target.origin);
    if (machine === undefined) throw new TypeError("offline");
    if (target.pathname === "/.well-known/studio/environment")
      return Response.json(describeMachine(`env-${machine.id}`, machine.capabilities));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return machine.answer({
      method: init?.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      body,
    });
  });
  const link = makeFleetLink({ fetch: fetcher, baseDir, book: makeFleetAddressBook() });
  return { fetcher, link, targets };
}

/** A machine that takes the install and reports `final` on its first status read. */
const installing =
  (final: Record<string, unknown>): Answer =>
  ({ method }) =>
    method === "POST"
      ? Response.json({
          result: "accepted",
          requestId: "2026-10-28T15:00:00.000Z#1",
          phase: "installing",
          skill: "anton-abyzov/vskill/sw-do",
          version: "1.2.3",
          scope: "user",
        })
      : Response.json({ requestId: "2026-10-28T15:00:00.000Z#1", ...final });

const fast = { sleep: async () => {}, pollMs: 0 };

describe("the primary asking fleet machines to install a skill", () => {
  it("asks over Connect with a proof, polls status and returns the version from the lock", async () => {
    const { fetcher, link, targets } = await primary([
      {
        id: "m1",
        up: [CONNECT],
        capabilities: { fleetSkillUpdate: true },
        answer: installing({ phase: "installed", installedVersion: "1.2.3", pinnedVersion: null }),
      },
    ]);
    const outcome = await runFleetSkillInstall({
      link,
      target: targets[0]!,
      coordinatorEnvironmentId: PRIMARY,
      ask: { ...userAsk, pin: false },
      ...fast,
    });
    expect(outcome).toEqual({
      machine: "m1",
      label: "Mac M1",
      transport: "connect",
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      scope: "user",
      pin: false,
      requestId: "2026-10-28T15:00:00.000Z#1",
      result: "installed",
      installedVersion: "1.2.3",
      pinnedVersion: null,
    });
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toMatch(/\/api\/studio\/fleet\/skills$/);
    const headers = post[1]!.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^DPoP /);
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      coordinatorEnvironmentId: PRIMARY,
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      scope: "user",
      pin: false,
    });
    const get = fetcher.mock.calls.find(
      ([url, init]) => init?.method === "GET" && String(url).includes("/api/studio/fleet/skills"),
    )!;
    expect(String(get[0])).toContain(`coordinatorEnvironmentId=${PRIMARY}`);
  });

  it("names each refusal: unsupported, unauthorized, the machine's own, a failed install", async () => {
    const { link, targets } = await primary([
      { id: "m1", up: [CONNECT], capabilities: {}, answer: () => Response.json({}) },
      {
        id: "m2",
        up: [CONNECT],
        capabilities: { fleetSkillUpdate: true },
        answer: () => Response.json({ message: "forbidden" }, { status: 403 }),
      },
      {
        id: "m3",
        up: [CONNECT],
        capabilities: { fleetSkillUpdate: true },
        answer: () =>
          Response.json(
            { _tag: "StudioFleetSkillError", reason: "vskill-missing", message: "no vskill" },
            { status: 409 },
          ),
      },
      {
        id: "m4",
        up: [CONNECT],
        capabilities: { fleetSkillUpdate: true },
        answer: installing({
          phase: "failed",
          lastErrorReason: "install-failed",
          lastError: "vskill install exited with 1",
        }),
      },
      {
        id: "m5",
        up: [CONNECT],
        capabilities: { fleetSkillUpdate: true },
        answer: () => Response.json({ message: "bad payload" }, { status: 400 }),
      },
    ]);
    const ask = (index: number) =>
      runFleetSkillInstall({
        link,
        target: targets[index]!,
        coordinatorEnvironmentId: PRIMARY,
        ask: userAsk,
        ...fast,
      });
    await expect(ask(0)).rejects.toMatchObject({ reason: "unsupported" });
    await expect(ask(1)).rejects.toMatchObject({ reason: "unauthorized" });
    await expect(ask(2)).rejects.toMatchObject({ reason: "vskill-missing", message: "no vskill" });
    await expect(ask(3)).rejects.toMatchObject({
      reason: "install-failed",
      message: "vskill install exited with 1",
    });
    await expect(ask(4)).rejects.toMatchObject({ reason: "invalid-skill" });
  });

  it("refuses an invalid skill without contacting the machine", async () => {
    const { fetcher, link, targets } = await primary([
      { id: "m1", up: [CONNECT], capabilities: { fleetSkillUpdate: true }, answer: installing({}) },
    ]);
    await expect(
      runFleetSkillInstall({
        link,
        target: targets[0]!,
        coordinatorEnvironmentId: PRIMARY,
        ask: { ...userAsk, skill: "local:/tmp/evil" },
      }),
    ).rejects.toMatchObject({ reason: "invalid-skill" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("prints one result per machine for --all, in order, a failure beside each success", async () => {
    const { link, targets } = await primary([
      {
        id: "m1",
        up: [TAILNET],
        capabilities: { fleetSkillUpdate: true },
        answer: installing({
          phase: "installed",
          installedVersion: "1.2.3",
          pinnedVersion: "1.2.3",
        }),
      },
      { id: "m2", up: [], capabilities: {}, answer: () => Response.json({}) },
      { id: "m3", up: [CONNECT], capabilities: {}, answer: () => Response.json({}) },
    ]);
    const outcomes = await runFleetSkillInstalls({
      link,
      targets,
      coordinatorEnvironmentId: PRIMARY,
      ask: userAsk,
      ...fast,
    });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({
      machine: "m1",
      label: "Mac M1",
      transport: "tailnet",
      result: "installed",
      installedVersion: "1.2.3",
      pinnedVersion: "1.2.3",
    });
    expect(outcomes[1]).toEqual({
      machine: "m2",
      label: "Mac M2",
      skill: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      scope: "user",
      error: expect.any(String),
      reason: "unreachable",
    });
    expect(outcomes[2]).toMatchObject({ machine: "m3", reason: "unsupported" });
    // Each outcome is one JSON line for the CLI.
    for (const outcome of outcomes) expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });

  it("stops waiting with busy when the install outlives the wait", async () => {
    let clock = 0;
    const { link, targets } = await primary([
      {
        id: "m1",
        up: [CONNECT],
        capabilities: { fleetSkillUpdate: true },
        answer: installing({ phase: "installing" }),
      },
    ]);
    await expect(
      runFleetSkillInstall({
        link,
        target: targets[0]!,
        coordinatorEnvironmentId: PRIMARY,
        ask: userAsk,
        waitMs: 10_000,
        pollMs: 3_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
    ).rejects.toMatchObject({ reason: "busy" });
  });
});
