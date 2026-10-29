import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real skill folders in temporary homes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import type { ProviderSkillSource } from "./projectSkillsInventory.ts";
import { applyNativeSkillSwitches, type NativeSkillControl } from "./projectSkillsNativeOverlay.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const setup = (files: Readonly<Record<string, string>>) =>
  Effect.promise(async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skills-native-overlay-")),
    );
    dirs.push(root);
    for (const [file, text] of Object.entries(files)) {
      await NodeFSP.mkdir(join(root, file, ".."), { recursive: true });
      await NodeFSP.writeFile(join(root, file), text);
    }
    return root;
  });
const skillFile = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`;

const source = (
  driver: string,
  skills: ProviderSkillSource["skills"],
  instance = driver,
): ProviderSkillSource => ({
  instanceId: ProviderInstanceId.make(instance),
  driver: ProviderDriverKind.make(driver),
  label: instance,
  skills,
});

const run = (
  root: string,
  sources: ReadonlyArray<ProviderSkillSource>,
  controls: Readonly<Record<string, NativeSkillControl["harness"]>>,
) =>
  applyNativeSkillSwitches({
    cwd: join(root, "work"),
    home: join(root, "home"),
    sources,
    controls: new Map(
      Object.entries(controls).map(([instance, harness]) => [
        ProviderInstanceId.make(instance),
        { harness, environment: {} },
      ]),
    ),
  });

describe("agents' own skill switches in the Skills view", () => {
  it.live("Gemini: lists its skill folders and marks the off ones", () =>
    Effect.gen(function* () {
      const root = yield* setup({
        "home/.agents/skills/deploy/SKILL.md": skillFile("deploy"),
        "home/.gemini/skills/review/SKILL.md": skillFile("review"),
        "home/.gemini/settings.json": '{ "skills": { "disabled": ["DEPLOY"] } }',
      });
      const [gemini] = yield* run(
        root,
        [
          source(
            "acpRegistry",
            [{ name: "deploy", path: "acp://skill/deploy", enabled: true }],
            "gemini",
          ),
        ],
        { gemini: "gemini" },
      );
      expect(
        gemini!.skills.map(({ name, enabled, switchFile }) => ({ name, enabled, switchFile })),
      ).toEqual([
        { name: "deploy", enabled: false, switchFile: join(root, "home/.gemini/settings.json") },
        { name: "review", enabled: true, switchFile: join(root, "home/.gemini/settings.json") },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("OpenCode and Pi: an off skill they stop listing comes back as an off row", () =>
    Effect.gen(function* () {
      const root = yield* setup({
        "home/.config/opencode/opencode.json":
          '{ "permission": { "skill": { "deploy": "deny" } } }',
        "home/.pi/agent/settings.json": '{ "skills": ["-../../.agents/skills/deploy"] }',
      });
      const deploy = join(root, "home/.agents/skills/deploy/SKILL.md");
      const claude = source("claudeAgent", [{ name: "deploy", path: deploy, enabled: true }]);
      const [, opencode, pi] = yield* run(
        root,
        [claude, source("opencode", []), source("pi", [])],
        { opencode: "opencode", pi: "pi" },
      );
      for (const agent of [opencode!, pi!])
        expect(agent.skills).toEqual([
          expect.objectContaining({ name: "deploy", path: deploy, enabled: false }),
        ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("a skill only OpenCode or Pi reads stays listed once it is off", () =>
    Effect.gen(function* () {
      const root = yield* setup({
        "home/.config/opencode/skills/oc-only/SKILL.md": skillFile("oc-only"),
        "home/.config/opencode/skills/kept/SKILL.md": skillFile("kept"),
        "home/.config/opencode/opencode.json":
          '{ "permission": { "skill": { "*": "deny", "kept": "allow" } } }',
        "home/.pi/agent/skills/pi-only/SKILL.md": skillFile("pi-only"),
        "home/.pi/agent/skills/note.md": "a plain skill\n",
        "home/.pi/agent/settings.json": JSON.stringify({
          skills: ["-skills/pi-only", "-skills/note.md"],
        }),
      });
      const kept = join(root, "home/.config/opencode/skills/kept/SKILL.md");
      const [opencode, pi] = yield* run(
        root,
        [source("opencode", [{ name: "kept", path: kept, enabled: true }]), source("pi", [])],
        { opencode: "opencode", pi: "pi" },
      );
      expect(opencode!.skills.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
        { name: "kept", enabled: true },
        { name: "oc-only", enabled: false },
      ]);
      expect(pi!.skills.map(({ name, path, enabled }) => ({ name, path, enabled }))).toEqual([
        {
          name: "pi-only",
          path: join(root, "home/.pi/agent/skills/pi-only/SKILL.md"),
          enabled: false,
        },
        { name: "note", path: join(root, "home/.pi/agent/skills/note.md"), enabled: false },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("OpenCode: a denied skill is found by its frontmatter name, not its folder", () =>
    Effect.gen(function* () {
      const root = yield* setup({
        "home/.agents/skills/my-folder/SKILL.md": skillFile("review"),
        "home/.config/opencode/opencode.json":
          '{ "permission": { "skill": { "review": "deny" } } }',
      });
      const [opencode] = yield* run(root, [source("opencode", [])], { opencode: "opencode" });
      expect(opencode!.skills.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
        { name: "review", enabled: false },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("Pi: a project skill keeps no switch, since Pi's user file does not reach it", () =>
    Effect.gen(function* () {
      const root = yield* setup({});
      const project = join(root, "work/.pi/skills/x/SKILL.md");
      const [pi] = yield* run(
        root,
        [source("pi", [{ name: "x", path: project, enabled: true, scope: "project" }])],
        { pi: "pi" },
      );
      expect(pi!.skills).toEqual([{ name: "x", path: project, enabled: true, scope: "project" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("Gemini: names a skill by its frontmatter name, as Gemini disables it", () =>
    Effect.gen(function* () {
      const root = yield* setup({
        "home/.gemini/skills/do/SKILL.md": skillFile("sw:do"),
        "home/.gemini/settings.json": '{ "skills": { "disabled": ["sw-do"] } }',
      });
      const [gemini] = yield* run(root, [source("acpRegistry", [], "gemini")], {
        gemini: "gemini",
      });
      expect(gemini!.skills.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
        { name: "sw-do", enabled: false },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("leaves agents without a switch file as they reported", () =>
    Effect.gen(function* () {
      const root = yield* setup({});
      const cursor = source("cursor", [{ name: "x", path: "/x/SKILL.md", enabled: true }]);
      expect(yield* run(root, [cursor], {})).toEqual([cursor]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("an unreadable switch file offers no switch", () =>
    Effect.gen(function* () {
      const root = yield* setup({ "home/.grok/config.toml": "= nope" });
      const [grok] = yield* run(
        root,
        [source("grok", [{ name: "x", path: "/x/SKILL.md", enabled: true }])],
        { grok: "grok" },
      );
      expect(grok!.skills).toEqual([{ name: "x", path: "/x/SKILL.md", enabled: true }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
