import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real settings files in temporary folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import {
  applyClaudeSkillOverride,
  editSkillOverride,
  MAX_SETTINGS_BACKUPS,
  planClaudeSkillOverride,
  readSkillOverrides,
  settingsFileHash,
} from "./ClaudeSettingsWrite.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempDir = (prefix: string) =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  });
const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(join(file, ".."), { recursive: true });
    await NodeFSP.writeFile(file, text);
  });
const read = (file: string) => Effect.promise(() => NodeFSP.readFile(file, "utf8"));

/** A config folder, a cwd and an empty managed-settings path, all temporary. */
const setup = Effect.gen(function* () {
  const root = yield* tempDir("claude-settings-write-");
  const configDir = join(root, "config");
  const cwd = join(root, "work");
  yield* Effect.promise(() => NodeFSP.mkdir(cwd, { recursive: true }));
  return { root, configDir, cwd, managedPath: join(root, "managed", "managed-settings.json") };
});
const request = (
  env: Effect.Success<typeof setup>,
  fields: { key?: string; enabled: boolean; scope: "user" | "local" },
) => ({
  configDir: env.configDir,
  cwd: env.cwd,
  key: fields.key ?? "sw-do",
  enabled: fields.enabled,
  scope: fields.scope,
  platform: "linux" as const,
  environment: {},
  managedPath: env.managedPath,
});

describe("editSkillOverride", () => {
  it("keeps comments, trailing commas and other keys", () => {
    const text = [
      "{",
      "  // the model this machine uses",
      '  "model": "opus",',
      '  "skillOverrides": { "a": "off", },',
      "}",
      "",
    ].join("\n");
    const next = editSkillOverride(text, "b", "off");
    expect(next).toContain("// the model this machine uses");
    expect(next).toContain('"model": "opus"');
    expect(readSkillOverrides(next)).toEqual({ status: "ok", map: { a: "off", b: "off" } });
    expect(next.endsWith("\n")).toBe(true);
  });

  it("drops the whole map when its only key is removed and starts a missing file", () => {
    const removed = editSkillOverride('{\n  "skillOverrides": { "a": "off" }\n}\n', "a", undefined);
    expect(removed).not.toContain("skillOverrides");
    expect(readSkillOverrides(removed)).toEqual({ status: "ok", map: {} });
    expect(readSkillOverrides(editSkillOverride(null, "sw:do", "off"))).toEqual({
      status: "ok",
      map: { "sw:do": "off" },
    });
  });

  it("leaves a document without the key alone when removing it", () => {
    // jsonc-parser throws "Can not delete in empty document" for these.
    expect(editSkillOverride("{}", "sw-do", undefined)).toBe("{}");
    expect(editSkillOverride('{"model":"x"}', "sw-do", undefined)).toBe('{"model":"x"}');
    expect(editSkillOverride('{"skillOverrides":{"a":"off"}}', "sw-do", undefined)).toBe(
      '{"skillOverrides":{"a":"off"}}',
    );
    expect(editSkillOverride(null, "sw-do", undefined)).toBe("");
  });

  it("calls a map with any unknown value invalid, as Claude does", () => {
    expect(readSkillOverrides('{"skillOverrides":{"a":"off","b":true}}').status).toBe("invalid");
    expect(readSkillOverrides('{"skillOverrides":{"a":"sometimes"}}').status).toBe("invalid");
    expect(readSkillOverrides("[1,2]").status).toBe("invalid");
    expect(readSkillOverrides(null)).toEqual({ status: "absent" });
  });
});

describe("planClaudeSkillOverride and applyClaudeSkillOverride", () => {
  it.live("turns a user skill off with a backup and an atomic replace", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const target = join(env.configDir, "settings.json");
      const before = '{\n  // mine\n  "theme": "dark",\n}\n';
      yield* write(target, before);
      yield* Effect.promise(() => NodeFSP.chmod(target, 0o600));
      const plan = yield* planClaudeSkillOverride(request(env, { enabled: false, scope: "user" }));
      expect(plan.target).toBe(target);
      expect(plan.value).toBe("off");
      expect(plan.effectiveEnabled).toBe(false);
      expect(plan.currentHash).toBe(settingsFileHash(before));
      const backupDir = join(env.root, "backups");
      const applied = yield* applyClaudeSkillOverride(plan, {
        expectedHash: plan.currentHash,
        backupDir,
      });
      const after = yield* read(target);
      expect(after).toContain("// mine");
      expect(readSkillOverrides(after)).toEqual({ status: "ok", map: { "sw-do": "off" } });
      expect(applied.hash).toBe(settingsFileHash(after));
      const stat = yield* Effect.promise(() => NodeFSP.stat(target));
      // Windows exposes the writable flag through emulated mode bits, not POSIX ACLs.
      // Still require owner read/write; POSIX must preserve the exact private mode.
      expect(stat.mode & (NodeOS.platform() === "win32" ? 0o600 : 0o777)).toBe(0o600);
      const backups = yield* Effect.promise(() => NodeFSP.readdir(backupDir));
      expect(backups).toEqual([`${applied.backupId}.json`]);
      const backup = yield* read(join(backupDir, backups[0]!));
      expect(backup).toContain('"theme\\": \\"dark');
      // Nothing but the settings file is left beside it.
      expect(yield* Effect.promise(() => NodeFSP.readdir(env.configDir))).toEqual([
        "settings.json",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps at most the newest backups", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const backupDir = join(env.root, "backups");
      for (let index = 0; index < MAX_SETTINGS_BACKUPS + 3; index++)
        yield* write(join(backupDir, `${String(index).padStart(13, "0")}-0000000a.json`), "{}");
      yield* write(join(backupDir, "keep-me.txt"), "not a backup");
      const plan = yield* planClaudeSkillOverride(request(env, { enabled: false, scope: "user" }));
      yield* applyClaudeSkillOverride(plan, { backupDir });
      const names = yield* Effect.promise(() => NodeFSP.readdir(backupDir));
      expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(MAX_SETTINGS_BACKUPS);
      expect(names).toContain("keep-me.txt");
      expect(names).not.toContain("0000000000000-0000000a.json");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("removes the key on enable unless a lower file says off", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const user = join(env.configDir, "settings.json");
      yield* write(user, '{"skillOverrides":{"sw-do":"off","other":"off"}}\n');
      const removed = yield* planClaudeSkillOverride(
        request(env, { enabled: true, scope: "user" }),
      );
      expect(removed.value).toBeUndefined();
      expect(readSkillOverrides(removed.nextText)).toEqual({
        status: "ok",
        map: { other: "off" },
      });
      expect(removed.effectiveEnabled).toBe(true);

      // The user file says off, so a local file has to say on.
      const local = yield* planClaudeSkillOverride(request(env, { enabled: true, scope: "local" }));
      expect(local.target).toBe(join(env.cwd, ".claude", "settings.local.json"));
      expect(local.value).toBe("on");
      expect(local.effectiveEnabled).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("enables a user skill that only the project's settings.json turns off", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const project = join(env.cwd, ".claude", "settings.json");
      yield* write(project, '{"skillOverrides":{"sw-do":"off"}}\n');
      const user = join(env.configDir, "settings.json");
      // Both a missing user file and one without the map used to throw on the delete.
      for (const userText of [null, '{"model":"x"}\n']) {
        if (userText !== null) yield* write(user, userText);
        const plan = yield* planClaudeSkillOverride(request(env, { enabled: true, scope: "user" }));
        const local = join(env.cwd, ".claude", "settings.local.json");
        expect(plan.requestedTarget).toBe(user);
        expect(plan.target).toBe(local);
        expect(plan.value).toBe("on");
        expect(plan.changed).toBe(true);
        expect(plan.effectiveEnabled).toBe(true);
        expect(plan.warnings).toEqual([
          `${project} sets sw-do to "off" and outranks ${user}, so this switch goes in ${local} and applies to this repository only.`,
        ]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "disables a user skill a project file turns on, and writes nothing when already right",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        const project = join(env.cwd, ".claude", "settings.json");
        yield* write(project, '{"skillOverrides":{"sw-do":"on"}}\n');
        const user = join(env.configDir, "settings.json");
        const off = yield* planClaudeSkillOverride(request(env, { enabled: false, scope: "user" }));
        expect(off.target).toBe(join(env.cwd, ".claude", "settings.local.json"));
        expect(off.value).toBe("off");
        expect(off.effectiveEnabled).toBe(false);
        expect(off.warnings).toHaveLength(1);

        // Already on everywhere: no edit, and the apply leaves the user file missing.
        const on = yield* planClaudeSkillOverride(request(env, { enabled: true, scope: "user" }));
        expect(on.target).toBe(user);
        expect(on.changed).toBe(false);
        expect(on.effectiveEnabled).toBe(true);
        expect(on.warnings).toEqual([]);
        const applied = yield* applyClaudeSkillOverride(on, { expectedHash: on.currentHash });
        expect(applied.backupId).toBeUndefined();
        expect(yield* Effect.promise(() => NodeFSP.readdir(env.root))).not.toContain("config");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("writes local switches to the repository root's file, which outranks the cwd's", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      yield* Effect.promise(() => NodeFSP.mkdir(join(env.root, ".git")));
      const cwdLocal = join(env.cwd, ".claude", "settings.local.json");
      yield* write(cwdLocal, '{"skillOverrides":{"sw-do":"off"}}\n');
      const plan = yield* planClaudeSkillOverride(request(env, { enabled: true, scope: "local" }));
      expect(plan.target).toBe(join(env.root, ".claude", "settings.local.json"));
      expect(plan.localFile).toBe(true);
      expect(plan.repositoryRoot).toBe(env.root);
      expect(plan.value).toBe("on");
      expect(plan.effectiveEnabled).toBe(true);
      expect(plan.files.at(-1)).toBe(plan.target);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a key managed settings set and a map that is already invalid", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      yield* write(env.managedPath, '{"skillOverrides":{"sw-do":"on"}}');
      const managed = yield* planClaudeSkillOverride(
        request(env, { enabled: false, scope: "user" }),
      ).pipe(Effect.flip);
      expect(managed.reason).toBe("managed_override");
      const other = yield* planClaudeSkillOverride(
        request(env, { key: "other", enabled: false, scope: "user" }),
      );
      expect(other.value).toBe("off");

      yield* write(join(env.configDir, "settings.json"), '{"skillOverrides":{"other":"maybe"}}\n');
      const invalid = yield* planClaudeSkillOverride(
        request(env, { key: "other", enabled: false, scope: "user" }),
      ).pipe(Effect.flip);
      expect(invalid.reason).toBe("overrides_invalid");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses with stale and writes nothing when the file changed after the plan", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const target = join(env.configDir, "settings.json");
      yield* write(target, "{}\n");
      const plan = yield* planClaudeSkillOverride(request(env, { enabled: false, scope: "user" }));
      yield* write(target, '{"theme":"light"}\n');
      const stale = yield* applyClaudeSkillOverride(plan, {}).pipe(Effect.flip);
      expect(stale.reason).toBe("stale");
      expect(yield* read(target)).toBe('{"theme":"light"}\n');

      const fresh = yield* planClaudeSkillOverride(request(env, { enabled: false, scope: "user" }));
      const wrongPreview = yield* applyClaudeSkillOverride(fresh, {
        expectedHash: settingsFileHash("{}\n"),
      }).pipe(Effect.flip);
      expect(wrongPreview.reason).toBe("stale");
      expect(yield* read(target)).toBe('{"theme":"light"}\n');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
