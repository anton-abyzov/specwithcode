import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  type ProjectSkillPresence,
  type ProjectSkillRow,
  type ProjectSkillsActionInput,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { CodexAppServerRequestError } from "@specweave-studio/effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real settings files in temporary folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import type { ProviderSkillsControl } from "../provider/ProviderDriver.ts";
import type {
  CliRun,
  CodexConfigClient,
  ProjectSkillsActionsDeps,
  RunCli,
  SkillsActionContext,
} from "./ProjectSkillsActionsCommon.ts";
import { readSkillOverrides } from "./ClaudeSettingsWrite.ts";
import {
  claudePluginArgs,
  codexPluginKeyPath,
  grokPluginArgs,
  makeSkillsToggles,
  type Serialized,
} from "./ProjectSkillsToggles.ts";

const projectId = ProjectId.make("project-skills-toggles");

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
const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(join(file, ".."), { recursive: true });
    await NodeFSP.writeFile(file, text);
  });
const readOr = (file: string) =>
  Effect.promise(() => NodeFSP.readFile(file, "utf8").catch(() => null));

const presence = (driver: string, fields: Partial<ProjectSkillPresence> = {}) =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    label: driver,
    path: `/nonexistent/${driver}/sw-do/SKILL.md`,
    scope: "project",
    enabled: true,
    ...fields,
  }) as ProjectSkillPresence;

const rowOf = (name: string, providers: ReadonlyArray<ProjectSkillPresence>): ProjectSkillRow =>
  ({
    name,
    status: "ok",
    attention: false,
    issues: [],
    path: null,
    scopes: [],
    providers,
    lock: null,
    drift: "untracked",
    copies: 1,
    divergent: false,
    doctor: [],
  }) as never;

interface Harness {
  readonly configDir: string;
  readonly cwd: string;
  readonly runs: Array<{ command: string; args: ReadonlyArray<string>; cwd: string }>;
  readonly requests: Array<{ method: string; params: unknown }>;
  readonly writes: Array<ReadonlyArray<string>>;
  readonly ctx: SkillsActionContext;
  readonly toggles: Effect.Success<ReturnType<typeof makeSkillsToggles>>;
}

const serialized: Serialized = (_cwd, effect) => effect;

/**
 * Toggles over temporary folders: a stand-in process runner and Codex app
 * server that record what they were asked and answer from `answers`.
 */
const harness = (options: {
  readonly row: (cwd: string) => ProjectSkillRow;
  readonly runResult?: Partial<CliRun>;
  readonly onRun?: (args: ReadonlyArray<string>, configDir: string) => Effect.Effect<void>;
  readonly codex?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, CodexAppServerRequestError>;
  readonly repository?: boolean;
}) =>
  Effect.gen(function* () {
    const root = yield* tempDir("project-skills-toggles-");
    const configDir = join(root, "claude-config");
    const cwd = join(root, "work");
    yield* Effect.promise(() => NodeFSP.mkdir(cwd, { recursive: true }));
    if (options.repository) yield* Effect.promise(() => NodeFSP.mkdir(join(root, ".git")));
    const runs: Harness["runs"] = [];
    const requests: Harness["requests"] = [];
    const writes: Harness["writes"] = [];
    const run: RunCli = (input) =>
      Effect.gen(function* () {
        runs.push({ command: input.command, args: input.args, cwd: input.cwd });
        if (options.onRun) yield* options.onRun(input.args, configDir);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...options.runResult };
      });
    const client = {
      request: (method: string, params: unknown) => {
        requests.push({ method, params });
        return options.codex ? options.codex(method, params) : Effect.succeed({});
      },
    } as unknown as CodexConfigClient;
    const control = (driver: string): ProviderSkillsControl => ({
      binaryPath: `/nonexistent/bin/${driver}`,
      environment: {},
      homePath: driver === "claudeAgent" ? configDir : join(root, "codex-home"),
    });
    const deps: ProjectSkillsActionsDeps = {
      home: join(root, "home"),
      environment: { PATH: "/usr/bin:/bin" },
      platform: "linux",
      backupDir: join(root, "backups"),
      resolveRow: () => Effect.die("unused"),
      agentControl: (instanceId) => Effect.succeed(control(instanceId)),
      codexClient: () => Effect.succeed(client),
      afterWrite: (input) => Effect.sync(() => void writes.push(input.instanceIds)),
      managedSettingsPath: join(root, "managed-settings.json"),
    };
    const toggles = yield* makeSkillsToggles(deps, run);
    const ctx: SkillsActionContext = { projectId, cwd, row: options.row(cwd) };
    return { configDir, cwd, runs, requests, writes, ctx, toggles } satisfies Harness;
  });

type Toggle = Extract<ProjectSkillsActionInput["action"], { kind: "toggle-skill" }>;
type PluginToggle = Extract<ProjectSkillsActionInput["action"], { kind: "toggle-plugin" }>;
const skillToggle = (driver: string, enabled: boolean, scope: "user" | "local" = "user"): Toggle =>
  ({
    kind: "toggle-skill",
    provider: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
    enabled,
    scope,
  }) as Toggle;
const pluginToggle = (
  driver: string,
  pluginId: string,
  enabled: boolean,
  scope: "user" | "project" | "local" = "user",
): PluginToggle =>
  ({
    kind: "toggle-plugin",
    provider: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
    pluginId,
    enabled,
    scope,
  }) as PluginToggle;
const input = (
  action: ProjectSkillsActionInput["action"],
  fields: Partial<ProjectSkillsActionInput> = {},
): ProjectSkillsActionInput =>
  ({ projectId, skill: "sw-do", preview: false, ...fields, action }) as ProjectSkillsActionInput;

describe("switch argv", () => {
  it("ends options before the plugin name and keeps Codex's key quoted", () => {
    expect(claudePluginArgs("sw@specweave", false, "user")).toEqual([
      "plugin",
      "disable",
      "-s",
      "user",
      "--json",
      "--",
      "sw@specweave",
    ]);
    expect(claudePluginArgs("sw@specweave", true, "local")).toEqual([
      "plugin",
      "enable",
      "-s",
      "local",
      "--json",
      "--",
      "sw@specweave",
    ]);
    expect(grokPluginArgs("specweave", false)).toEqual(["plugin", "disable", "--", "specweave"]);
    expect(codexPluginKeyPath("sw@specweave")).toBe('plugins."sw@specweave".enabled');
  });
});

describe("Claude switches", () => {
  it.live("can undo plugin disable after rediscovering the disabled target", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        row: () => rowOf("sw:do", []),
        onRun: (args, configDir) =>
          write(
            join(configDir, "settings.json"),
            JSON.stringify({ enabledPlugins: { "sw@mkt": args[1] === "enable" } }),
          ),
      });
      const pluginRoot = join(h.configDir, "plugins", "cache", "mkt", "sw", "1");
      yield* write(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "sw" }),
      );
      yield* write(join(pluginRoot, "skills", "do", "SKILL.md"), "# Do");
      yield* write(
        join(h.configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "sw@mkt": [{ scope: "user", installPath: pluginRoot }] },
        }),
      );
      const scan = Effect.gen(function* () {
        const skills = yield* discoverClaudeSkills({ homePath: h.configDir }, h.cwd, {});
        const skill = skills.find((value) => value.name === "sw:do");
        expect(skill).toBeDefined();
        if (!skill) throw new Error("Plugin action target disappeared");
        return {
          ...h.ctx,
          row: rowOf(skill.name, [
            presence("claudeAgent", {
              name: skill.name,
              path: skill.path,
              scope: "plugin",
              enabled: skill.enabled,
            }),
          ]),
        };
      });
      for (const enabled of [false, true]) {
        const ctx = yield* scan;
        const action = pluginToggle("claudeAgent", "sw@mkt", enabled);
        const preview = yield* h.toggles.togglePlugin(
          ctx,
          input(action, { preview: true }),
          action,
          serialized,
        );
        if (!("preview" in preview)) throw new Error("Expected plugin preview");
        const applied = yield* h.toggles.togglePlugin(
          ctx,
          input(action, { expected: preview.preview.expected }),
          action,
          serialized,
        );
        expect(applied).toMatchObject({ applied: true, effectiveEnabled: enabled });
        expect((yield* scan).row.providers[0]?.enabled).toBe(enabled);
      }
      expect(h.runs.map((run) => run.args[1])).toEqual(["disable", "enable"]);
      expect(h.writes).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses unsupported per-skill plugin writes before changing settings", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        row: () => rowOf("sw:do", [presence("claudeAgent", { scope: "plugin", name: "sw:do" })]),
      });
      const action = skillToggle("claudeAgent", false);
      for (const preview of [true, false]) {
        const error = yield* h.toggles
          .toggleSkill(h.ctx, input(action, { preview }), action, serialized)
          .pipe(Effect.flip);
        expect(error.reason).toBe("scope_unsupported");
      }
      expect(h.runs).toEqual([]);
      expect(h.writes).toEqual([]);
      expect(yield* readOr(join(h.configDir, "settings.json"))).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("previews and writes skillOverrides in the instance's config folder", () =>
    Effect.gen(function* () {
      const h = yield* harness({ row: () => rowOf("sw-do", [presence("claudeAgent")]) });
      const action = skillToggle("claudeAgent", false);
      const preview = yield* h.toggles.toggleSkill(
        h.ctx,
        input(action, { preview: true }),
        action,
        serialized,
      );
      const settings = join(h.configDir, "settings.json");
      expect(preview).toEqual({
        preview: {
          files: [settings],
          summary: `set skillOverrides["sw-do"] to "off" in ${settings}`,
          liveness: "next-session",
          warnings: [],
          expected: { fileHash: "absent" },
        },
      });
      expect(yield* readOr(settings)).toBeNull();

      const applied = yield* h.toggles.toggleSkill(
        h.ctx,
        input(action, { expected: { fileHash: "absent" } }),
        action,
        serialized,
      );
      expect(applied).toMatchObject({ applied: true, effectiveEnabled: false });
      expect(readSkillOverrides(yield* readOr(settings))).toEqual({
        status: "ok",
        map: { "sw-do": "off" },
      });
      expect(h.writes).toEqual([["claudeAgent"]]);
      expect(h.runs).toEqual([]);

      const stale = yield* h.toggles
        .toggleSkill(h.ctx, input(action, { expected: { fileHash: "absent" } }), action, serialized)
        .pipe(Effect.flip);
      expect(stale.reason).toBe("stale");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("uses the plugin skill's own key and warns when a local file is not gitignored", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        repository: true,
        runResult: { exitCode: 1 },
        row: () => rowOf("sw:do", [presence("claudeAgent", { name: "sw:do" })]),
      });
      const action = skillToggle("claudeAgent", false, "local");
      const preview = yield* h.toggles.toggleSkill(
        h.ctx,
        input(action, { preview: true, skill: "sw:do" }),
        action,
        serialized,
      );
      expect(preview).toMatchObject({
        preview: {
          summary: expect.stringContaining('skillOverrides["sw:do"]'),
          warnings: [expect.stringContaining("not gitignored")],
        },
      });
      const root = join(h.cwd, "..");
      expect(h.runs).toEqual([
        {
          command: "git",
          args: ["check-ignore", "-q", "--", join(root, ".claude", "settings.local.json")],
          cwd: root,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a switch aimed at another agent than the row lists", () =>
    Effect.gen(function* () {
      const h = yield* harness({ row: () => rowOf("sw-do", [presence("claudeAgent")]) });
      const wrong = {
        ...skillToggle("codex", false),
        instanceId: ProviderInstanceId.make("claudeAgent"),
      } as Toggle;
      const refused = yield* h.toggles
        .toggleSkill(h.ctx, input(wrong), wrong, serialized)
        .pipe(Effect.flip);
      expect(refused.reason).toBe("skill_not_found");
      const absent = skillToggle("codex", false);
      expect(
        (yield* h.toggles.toggleSkill(h.ctx, input(absent), absent, serialized).pipe(Effect.flip))
          .reason,
      ).toBe("skill_not_found");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("runs claude plugin with -- for the row's own plugin only, checking the file first", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        row: () => rowOf("sw:do", [presence("claudeAgent", { name: "sw:do" })]),
      });
      const other = pluginToggle("claudeAgent", "other@market", false);
      expect(
        (yield* h.toggles.togglePlugin(h.ctx, input(other), other, serialized).pipe(Effect.flip))
          .reason,
      ).toBe("skill_not_found");
      const bare = pluginToggle("claudeAgent", "sw", false);
      expect(
        (yield* h.toggles.togglePlugin(h.ctx, input(bare), bare, serialized).pipe(Effect.flip))
          .reason,
      ).toBe("skill_not_found");

      const action = pluginToggle("claudeAgent", "sw@specweave", false, "project");
      const preview = yield* h.toggles.togglePlugin(
        h.ctx,
        input(action, { preview: true }),
        action,
        serialized,
      );
      const file = join(h.cwd, ".claude", "settings.json");
      expect(preview).toEqual({
        preview: {
          argv: ["claude", ...claudePluginArgs("sw@specweave", false, "project")],
          files: [file],
          summary: expect.any(String),
          liveness: "next-session",
          expected: { fileHash: "absent" },
        },
      });
      yield* write(file, "{}\n");
      const stale = yield* h.toggles
        .togglePlugin(
          h.ctx,
          input(action, { expected: { fileHash: "absent" } }),
          action,
          serialized,
        )
        .pipe(Effect.flip);
      expect(stale.reason).toBe("stale");
      expect(h.runs).toEqual([]);

      const applied = yield* h.toggles.togglePlugin(h.ctx, input(action), action, serialized);
      expect(applied).toMatchObject({ applied: true, effectiveEnabled: false });
      expect(h.runs).toEqual([
        {
          command: "/nonexistent/bin/claudeAgent",
          args: claudePluginArgs("sw@specweave", false, "project"),
          cwd: h.cwd,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("turns on a user skill the project's settings.json turns off, in the local file", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        repository: true,
        row: () => rowOf("sw-do", [presence("claudeAgent", { scope: "user", enabled: false })]),
      });
      const projectFile = join(h.cwd, ".claude", "settings.json");
      yield* write(projectFile, '{"skillOverrides":{"sw-do":"off"}}\n');
      const local = join(h.cwd, "..", ".claude", "settings.local.json");
      const on = skillToggle("claudeAgent", true, "user");
      const preview = yield* h.toggles.toggleSkill(
        h.ctx,
        input(on, { preview: true }),
        on,
        serialized,
      );
      expect(preview).toMatchObject({
        preview: {
          files: [local],
          summary: `set skillOverrides["sw-do"] to "on" in ${local}`,
          warnings: [expect.stringContaining(`${projectFile} sets sw-do to "off" and outranks`)],
          expected: { fileHash: "absent" },
        },
      });
      const applied = yield* h.toggles.toggleSkill(
        h.ctx,
        input(on, { expected: { fileHash: "absent" } }),
        on,
        serialized,
      );
      expect(applied).toMatchObject({ applied: true, effectiveEnabled: true });
      expect(readSkillOverrides(yield* readOr(local))).toEqual({
        status: "ok",
        map: { "sw-do": "on" },
      });
      // Neither the user's nor the project's shared file was touched.
      expect(yield* readOr(join(h.configDir, "settings.json"))).toBeNull();
      expect(yield* readOr(projectFile)).toBe('{"skillOverrides":{"sw-do":"off"}}\n');

      // Undo (the same switch flipped) takes the local key out again.
      const off = skillToggle("claudeAgent", false, "user");
      const undone = yield* h.toggles.toggleSkill(h.ctx, input(off), off, serialized);
      expect(undone).toMatchObject({ applied: true, effectiveEnabled: false });
      expect(readSkillOverrides(yield* readOr(local))).toEqual({ status: "ok", map: {} });
      expect(yield* readOr(join(h.configDir, "settings.json"))).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads a plugin switch back and warns when a project file keeps the plugin on", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        row: () => rowOf("sw:do", [presence("claudeAgent", { name: "sw:do" })]),
      });
      yield* write(
        join(h.cwd, ".claude", "settings.json"),
        '{"enabledPlugins":{"sw@specweave":true}}\n',
      );
      const action = pluginToggle("claudeAgent", "sw@specweave", false, "user");
      // The stand-in CLI writes nothing; the user file says off as `claude plugin disable` would.
      yield* write(
        join(h.configDir, "settings.json"),
        '{"enabledPlugins":{"sw@specweave":false}}\n',
      );
      const applied = yield* h.toggles.togglePlugin(h.ctx, input(action), action, serialized);
      expect(applied).toMatchObject({
        applied: true,
        effectiveEnabled: true,
        warnings: [expect.stringContaining("keeps plugin sw@specweave on")],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a failed CLI run with its exit code", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        runResult: { exitCode: 2, stderr: "plugin not installed" },
        row: () => rowOf("sw:do", [presence("claudeAgent", { name: "sw:do" })]),
      });
      const action = pluginToggle("claudeAgent", "sw@specweave", true);
      const failed = yield* h.toggles
        .togglePlugin(h.ctx, input(action), action, serialized)
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ reason: "cli_failed", exitCode: 2 });
      expect(failed.stderrTail).toContain("plugin not installed");
      expect(h.writes).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Codex switches", () => {
  it.live(
    "writes the skill through the app server, reloads, and reports an override as applied",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          row: () => rowOf("sw-do", [presence("codex")]),
          codex: (method) =>
            Effect.succeed(method === "skills/config/write" ? { effectiveEnabled: false } : {}),
        });
        const off = skillToggle("codex", false);
        expect(yield* h.toggles.toggleSkill(h.ctx, input(off), off, serialized)).toMatchObject({
          applied: true,
          liveness: "now",
          effectiveEnabled: false,
        });
        expect(h.requests).toEqual([
          {
            method: "skills/config/write",
            params: { path: "/nonexistent/codex/sw-do/SKILL.md", enabled: false },
          },
          { method: "skills/list", params: { cwds: [h.cwd], forceReload: true } },
        ]);
        // config.toml took the write, so the result says so and the switch can be undone.
        const on = skillToggle("codex", true);
        const overridden = yield* h.toggles.toggleSkill(h.ctx, input(on), on, serialized);
        expect(overridden).toMatchObject({
          applied: true,
          effectiveEnabled: false,
          warnings: [expect.stringContaining("a higher Codex config layer keeps sw-do off")],
        });
        expect(h.writes).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("writes a plugin switch with the preview's config version", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        row: () => rowOf("sw-do", [presence("codex")]),
        codex: (method, params) => {
          if (method === "config/read")
            return Effect.succeed({
              config: {},
              origins: {},
              layers: [
                { name: { type: "system" }, version: "sys-1", config: {} },
                { name: { type: "user" }, version: "user-7", config: {} },
              ],
            });
          if (method === "config/value/write") {
            const expected = (params as { expectedVersion?: string }).expectedVersion;
            return expected === "user-7"
              ? Effect.succeed({ status: "ok", version: "user-8", filePath: "/x" })
              : expected === "user-8"
                ? Effect.succeed({
                    status: "okOverridden",
                    version: "user-9",
                    filePath: "/x",
                    overriddenMetadata: { message: "Managed config keeps it on." },
                  })
                : Effect.fail(
                    new CodexAppServerRequestError({
                      code: -32600,
                      errorMessage: "config version mismatch",
                    }),
                  );
          }
          return Effect.succeed({});
        },
      });
      const action = pluginToggle("codex", "sw@specweave", false);
      const preview = yield* h.toggles.togglePlugin(
        h.ctx,
        input(action, { preview: true }),
        action,
        serialized,
      );
      expect(preview).toMatchObject({
        preview: { liveness: "now", expected: { configVersion: "user-7" } },
      });
      const applied = yield* h.toggles.togglePlugin(
        h.ctx,
        input(action, { expected: { configVersion: "user-7" } }),
        action,
        serialized,
      );
      expect(applied).toMatchObject({ applied: true, effectiveEnabled: false });
      expect(h.requests.find((request) => request.method === "config/value/write")).toEqual({
        method: "config/value/write",
        params: {
          keyPath: 'plugins."sw@specweave".enabled',
          value: false,
          mergeStrategy: "upsert",
          expectedVersion: "user-7",
        },
      });
      const overridden = yield* h.toggles.togglePlugin(
        h.ctx,
        input(action, { expected: { configVersion: "user-8" } }),
        action,
        serialized,
      );
      expect(overridden).toMatchObject({
        applied: true,
        effectiveEnabled: true,
        warnings: ["Managed config keeps it on."],
      });
      const stale = yield* h.toggles
        .togglePlugin(
          h.ctx,
          input(action, { expected: { configVersion: "user-1" } }),
          action,
          serialized,
        )
        .pipe(Effect.flip);
      expect(stale.reason).toBe("stale");
      const project = pluginToggle("codex", "sw@specweave", false, "project");
      expect(
        (yield* h.toggles
          .togglePlugin(h.ctx, input(project), project, serialized)
          .pipe(Effect.flip)).reason,
      ).toBe("scope_unsupported");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses with agent_unavailable when the app server fails a request", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        row: () => rowOf("sw-do", [presence("codex")]),
        codex: () =>
          Effect.fail(new CodexAppServerRequestError({ code: -32601, errorMessage: "no method" })),
      });
      const action = skillToggle("codex", false);
      const failed = yield* h.toggles
        .toggleSkill(h.ctx, input(action), action, serialized)
        .pipe(Effect.flip);
      expect(failed.reason).toBe("agent_unavailable");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Grok switches", () => {
  it.live("refuses a skill switch and switches plugins for the user only", () =>
    Effect.gen(function* () {
      const h = yield* harness({ row: () => rowOf("sw-do", [presence("grok")]) });
      const skill = skillToggle("grok", false);
      expect(
        (yield* h.toggles.toggleSkill(h.ctx, input(skill), skill, serialized).pipe(Effect.flip))
          .reason,
      ).toBe("scope_unsupported");
      const project = pluginToggle("grok", "specweave", false, "project");
      expect(
        (yield* h.toggles
          .togglePlugin(h.ctx, input(project), project, serialized)
          .pipe(Effect.flip)).reason,
      ).toBe("scope_unsupported");
      const user = pluginToggle("grok", "specweave", false);
      expect(yield* h.toggles.togglePlugin(h.ctx, input(user), user, serialized)).toMatchObject({
        applied: true,
        liveness: "reload",
      });
      expect(h.runs).toEqual([
        { command: "/nonexistent/bin/grok", args: grokPluginArgs("specweave", false), cwd: h.cwd },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
