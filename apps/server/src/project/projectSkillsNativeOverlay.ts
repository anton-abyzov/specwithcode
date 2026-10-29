/**
 * projectSkillsNativeOverlay — puts each agent's own skill switches into the
 * skills it reported, before the Skills view joins them into rows.
 *
 * For an agent with a file switch (see {@link nativeSkillSwitches}) every
 * skill carries that file, a skill the file turns off is reported as off,
 * and a skill the agent stops listing once it is off (OpenCode, Pi) is added
 * back as off, found by name or folder among what the other agents load, so
 * it can be turned on again from the same row. Gemini CLI and Copilot CLI
 * advertise their skills only as ACP commands, so their skill folders are
 * scanned here the way each CLI reads them.
 *
 * @module project/projectSkillsNativeOverlay
 */
import type { ProviderInstanceId, ServerProviderSkill } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { scanSkillRoots } from "../provider/Drivers/CursorSkills.ts";
import {
  isNativeSkillOff,
  isPiUserSkill,
  type NativeSkillHarness,
  piSkillEntry,
  nativeSkillSwitchFile,
  readNativeSkillSwitches,
} from "./nativeSkillSwitches.ts";
import type { ProviderSkillSource } from "./projectSkillsInventory.ts";

const MAX_SWITCH_FILE_BYTES = 2_000_000;

/** What the overlay needs to know about one instance. */
export interface NativeSkillControl {
  readonly harness: NativeSkillHarness;
  readonly environment: NodeJS.ProcessEnv;
}

/** A switch file's text, null when it is missing or too big to be a settings file. */
export const readSwitchFile = Effect.fn("projectSkills.readSwitchFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (info._tag === "None" || info.value.type !== "File") return null;
  if (info.value.size > BigInt(MAX_SWITCH_FILE_BYTES)) return null;
  return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
});

/** The switch file for `control`, with OpenCode's `.json`/`.jsonc` choice made on disk. */
export const switchFileFor = Effect.fn("projectSkills.switchFileFor")(function* (
  control: NativeSkillControl,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates =
    control.harness === "opencode"
      ? [
          path.join(
            path.dirname(nativeSkillSwitchFile("opencode", control.environment, home)),
            "opencode.json",
          ),
          path.join(
            path.dirname(nativeSkillSwitchFile("opencode", control.environment, home)),
            "opencode.jsonc",
          ),
        ]
      : [];
  const present = new Set<string>();
  for (const candidate of candidates)
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) present.add(candidate);
  return nativeSkillSwitchFile(control.harness, control.environment, home, (file) =>
    present.has(file),
  );
});

/** The folders Gemini CLI and Copilot CLI read skills from, project first. */
function cliSkillRoots(
  harness: "gemini" | "copilot",
  cwd: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  join: (...parts: ReadonlyArray<string>) => string,
) {
  if (harness === "gemini") {
    const geminiHome = environment.GEMINI_CLI_HOME?.trim() || home;
    return [
      { directory: join(cwd, ".gemini", "skills"), scope: "project" as const },
      { directory: join(cwd, ".agents", "skills"), scope: "project" as const },
      { directory: join(geminiHome, ".gemini", "skills"), scope: "user" as const },
      { directory: join(geminiHome, ".agents", "skills"), scope: "user" as const },
    ];
  }
  const copilotHome = environment.COPILOT_HOME?.trim() || join(home, ".copilot");
  return [
    { directory: join(cwd, ".github", "skills"), scope: "project" as const },
    { directory: join(cwd, ".agents", "skills"), scope: "project" as const },
    { directory: join(cwd, ".claude", "skills"), scope: "project" as const },
    { directory: join(copilotHome, "skills"), scope: "user" as const },
    { directory: join(home, ".agents", "skills"), scope: "user" as const },
  ];
}

/** The folders OpenCode reads skills from, project first, minus the ones its environment turns off. */
function openCodeSkillRoots(
  cwd: string,
  home: string,
  configDir: string,
  environment: NodeJS.ProcessEnv,
  join: (...parts: ReadonlyArray<string>) => string,
) {
  const flag = (key: string) => {
    const value = environment[key]?.trim().toLowerCase();
    return value === "1" || value === "true";
  };
  const external = !flag("OPENCODE_DISABLE_EXTERNAL_SKILLS");
  const claude =
    external &&
    !flag("OPENCODE_DISABLE_CLAUDE_CODE") &&
    !flag("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
  const dirs = [
    ".opencode/skill",
    ".opencode/skills",
    ...(claude ? [".claude/skills"] : []),
    ...(external ? [".agents/skills"] : []),
  ];
  return [
    ...dirs.map((dir) => ({ directory: join(cwd, dir), scope: "project" as const })),
    { directory: join(configDir, "skill"), scope: "user" as const },
    { directory: join(configDir, "skills"), scope: "user" as const },
    ...(claude ? [{ directory: join(home, ".claude", "skills"), scope: "user" as const }] : []),
    ...(external ? [{ directory: join(home, ".agents", "skills"), scope: "user" as const }] : []),
  ];
}

/** Gemini disables a skill by its frontmatter name with path characters made dashes. */
const cliSkillName = (harness: "gemini" | "copilot", name: string) =>
  harness === "gemini" ? name.replace(/[:\\/<>*?"|]/g, "-") : name;

/** Sources with every agent's own switches applied; sources without a control pass through. */
export const applyNativeSkillSwitches = Effect.fn("projectSkills.applyNativeSkillSwitches")(
  function* (input: {
    readonly cwd: string;
    readonly home: string;
    readonly sources: ReadonlyArray<ProviderSkillSource>;
    readonly controls: ReadonlyMap<ProviderInstanceId, NativeSkillControl>;
  }) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const isFile = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      );
    return yield* Effect.forEach(
      input.sources,
      (source) =>
        Effect.gen(function* () {
          const control = input.controls.get(source.instanceId);
          if (control === undefined) return source;
          const { harness } = control;
          const file = yield* switchFileFor(control, input.home);
          const read = readNativeSkillSwitches(
            harness,
            yield* readSwitchFile(file),
            file,
            input.home,
          );
          let skills: ReadonlyArray<ServerProviderSkill> = source.skills;
          if (harness === "gemini" || harness === "copilot") {
            const scanned = yield* scanSkillRoots(
              cliSkillRoots(harness, input.cwd, input.home, control.environment, path.join),
            );
            skills = scanned.skills.map(({ displayName, ...skill }) => ({
              ...skill,
              name: cliSkillName(harness, displayName ?? skill.name),
            }));
          }
          // An unreadable file switches nothing here, and its skills offer no switch.
          if (read.status === "invalid") return { ...source, skills };
          const state = read.state;
          // Pi applies its user file only to the user skill folders; other skills keep no switch here.
          const switchable = (skill: ServerProviderSkill) =>
            harness !== "pi" || isPiUserSkill(state, skill.path);
          const switched = skills.map((skill) =>
            switchable(skill)
              ? {
                  ...skill,
                  enabled: skill.enabled && !isNativeSkillOff(harness, state, skill),
                  switchFile: file,
                }
              : skill,
          );
          // Skills the agent drops once they are off come back as off rows.
          const listedNames = new Set(switched.map((skill) => skill.name));
          const others = input.sources
            .filter((other) => other.instanceId !== source.instanceId)
            .flatMap((other) => other.skills);
          const ghosts: Array<ServerProviderSkill> = [];
          const ghostOf = (skill: ServerProviderSkill) => {
            ghosts.push({
              name: skill.name,
              path: skill.path,
              enabled: false,
              switchFile: file,
              ...(skill.scope === undefined ? {} : { scope: skill.scope }),
              ...(skill.description === undefined ? {} : { description: skill.description }),
            });
            listedNames.add(skill.name);
          };
          if (harness === "opencode") {
            // OpenCode's own folders, so a skill only it reads still comes back once denied.
            // OpenCode names a skill by its frontmatter name.
            const own = (yield* scanSkillRoots(
              openCodeSkillRoots(
                input.cwd,
                input.home,
                path.dirname(file),
                control.environment,
                path.join,
              ),
            )).skills.map(({ displayName, ...skill }) => ({
              ...skill,
              name: displayName ?? skill.name,
            }));
            for (const name of state.names) {
              if (listedNames.has(name)) continue;
              const found =
                own.find((skill) => skill.name === name) ??
                others.find((skill) => skill.name === name);
              if (found !== undefined) ghostOf(found);
            }
            // A wildcard denial reaches only what OpenCode itself would load.
            for (const skill of own)
              if (!listedNames.has(skill.name) && isNativeSkillOff(harness, state, skill))
                ghostOf(skill);
          }
          if (harness === "pi") {
            const listedEntries = new Set(
              [...switched, ...ghosts].map((skill) => piSkillEntry(skill.path)),
            );
            for (const entry of state.folders) {
              if (listedEntries.has(entry)) continue;
              const found = others.find((skill) => piSkillEntry(skill.path) === entry);
              // The entry names the skill on disk, so a skill only Pi reads is found there.
              const skillFile = /\.md$/i.test(entry) ? entry : path.join(entry, "SKILL.md");
              const skill =
                found ??
                ((yield* isFile(skillFile))
                  ? {
                      name: path.basename(entry).replace(/\.md$/i, ""),
                      path: skillFile,
                      enabled: true,
                      scope: "user" as const,
                    }
                  : undefined);
              // Pi loads the first copy of a name, so a name it still lists is not off.
              if (
                skill !== undefined &&
                !listedNames.has(skill.name) &&
                isPiUserSkill(state, skill.path)
              )
                ghostOf(skill);
            }
          }
          return { ...source, skills: [...switched, ...ghosts] };
        }),
      { concurrency: "unbounded" },
    );
  },
);
