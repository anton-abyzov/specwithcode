// @effect-diagnostics nodeBuiltinImport:off - pure helpers: path math with no I/O.
/**
 * nativeSkillSwitches — the per-user skill switch each agent keeps in its own
 * config file, read and edited the way that agent's own command would:
 *
 * | Agent    | File                                        | Off means                                   |
 * |----------|---------------------------------------------|---------------------------------------------|
 * | Grok     | `$GROK_HOME/config.toml`                    | name in `[skills].disabled`                 |
 * | Gemini   | `$GEMINI_CLI_HOME/.gemini/settings.json`    | name in `skills.disabled` (any case)        |
 * | Copilot  | `$COPILOT_HOME/settings.json`               | name in `disabledSkills`                    |
 * | OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json(c)`| `permission.skill` rules end on `"deny"`    |
 * | Pi       | `$PI_CODING_AGENT_DIR/settings.json`        | `-<skill folder>` in `skills` (user skills) |
 *
 * Each switch lives in a file only that agent reads, so turning a skill off
 * for one agent never hides it from another, and nothing on disk is moved or
 * deleted. Every edit keeps the rest of the file: JSON goes through
 * `jsonc-parser` (comments kept), TOML is edited in place and parsed again to
 * prove only the one list changed; an edit that cannot be proven is refused.
 *
 * @module project/nativeSkillSwitches
 */
import * as NodePath from "node:path";

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

export type NativeSkillHarness = "grok" | "gemini" | "copilot" | "opencode" | "pi";

export const NATIVE_SKILL_HARNESS_LABELS: Readonly<Record<NativeSkillHarness, string>> = {
  grok: "Grok",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  opencode: "OpenCode",
  pi: "Pi",
};

/** ACP registry agents whose skills SpecWithCode can switch. */
const ACP_AGENT_HARNESSES: Readonly<Record<string, NativeSkillHarness>> = {
  gemini: "gemini",
  "github-copilot-cli": "copilot",
};

/** The harness behind a provider instance, or undefined when it keeps no file switch. */
export function nativeSkillHarnessOf(
  driver: string,
  agentId?: string | undefined,
): NativeSkillHarness | undefined {
  switch (driver) {
    case "grok":
    case "opencode":
    case "pi":
      return driver;
    case "acpRegistry":
      return agentId === undefined ? undefined : ACP_AGENT_HARNESSES[agentId];
    default:
      return undefined;
  }
}

/** A home variable's folder, with a leading `~` read as the user's home the way each agent reads it. */
const envPath = (environment: NodeJS.ProcessEnv, key: string, home: string) => {
  const value = environment[key]?.trim();
  if (!value) return undefined;
  if (value === "~") return home;
  return /^~[\\/]/.test(value) ? NodePath.join(home, value.slice(2)) : value;
};

/**
 * The config file holding `harness`'s skill switches. For OpenCode,
 * `exists` picks `opencode.jsonc` when only that one is there.
 */
export function nativeSkillSwitchFile(
  harness: NativeSkillHarness,
  environment: NodeJS.ProcessEnv,
  home: string,
  exists: (file: string) => boolean = () => false,
): string {
  switch (harness) {
    case "grok":
      return NodePath.join(
        envPath(environment, "GROK_HOME", home) ?? NodePath.join(home, ".grok"),
        "config.toml",
      );
    case "gemini":
      return NodePath.join(
        envPath(environment, "GEMINI_CLI_HOME", home) ?? home,
        ".gemini",
        "settings.json",
      );
    case "copilot":
      return NodePath.join(
        envPath(environment, "COPILOT_HOME", home) ?? NodePath.join(home, ".copilot"),
        "settings.json",
      );
    case "opencode": {
      const dir = NodePath.join(
        envPath(environment, "XDG_CONFIG_HOME", home) ?? NodePath.join(home, ".config"),
        "opencode",
      );
      const json = NodePath.join(dir, "opencode.json");
      const jsonc = NodePath.join(dir, "opencode.jsonc");
      return !exists(json) && exists(jsonc) ? jsonc : json;
    }
    case "pi":
      return NodePath.join(
        envPath(environment, "PI_CODING_AGENT_DIR", home) ?? NodePath.join(home, ".pi", "agent"),
        "settings.json",
      );
  }
}

/** What one agent's file says is off. */
export interface NativeSkillSwitchState {
  /** Names switched off; lower-cased for Gemini, which matches any case. */
  readonly names: ReadonlySet<string>;
  /** Skill folders switched off (Pi). */
  readonly folders: ReadonlySet<string>;
  /** OpenCode's `permission` value, evaluated per skill name. */
  readonly rules?: unknown;
  /** The folders whose skills Pi's user `skills` entries apply to. */
  readonly userRoots?: ReadonlyArray<string> | undefined;
  /** Set when the file turns every skill off, with the reason in words. */
  readonly allOff?: string | undefined;
}

export type NativeSkillSwitchRead =
  | { readonly status: "ok"; readonly state: NativeSkillSwitchState }
  | { readonly status: "invalid"; readonly why: string };

const EMPTY_STATE: NativeSkillSwitchState = { names: new Set(), folders: new Set() };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as ReadonlyArray<string>)
    : undefined;

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return {};
  const errors: Array<ParseError> = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length === 0 && isRecord(value) ? value : undefined;
}

function parseTomlObject(text: string): Record<string, unknown> | undefined {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A Pi `skills` entry's folder: relative entries resolve against the agent folder. */
function piFolder(entry: string, agentDir: string): string {
  const resolved = NodePath.resolve(agentDir, entry);
  return /(^|[\\/])SKILL\.md$/i.test(resolved) ? NodePath.dirname(resolved) : resolved;
}

const normalizeName = (harness: NativeSkillHarness, name: string) =>
  harness === "gemini" ? name.toLowerCase() : name;

/** OpenCode's wildcard: `*` any run of characters, `?` one, `\\` read as `/`, a trailing ` *` optional. */
const wildcard = (pattern: string) => {
  let source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s");
};

/**
 * OpenCode's rules for the skill tool, in file order: every `permission` key
 * whose wildcard matches `skill`, a string being a rule for every name.
 * `skill` stands in for `permission.skill`'s value, at its place or, when
 * there is none, at the end where a new key is written.
 */
function openCodeSkillRules(
  permission: unknown,
  skill?: { readonly value: unknown },
): ReadonlyArray<readonly [string, string]> {
  if (typeof permission === "string") return [["*", permission]];
  const rules: Array<readonly [string, string]> = [];
  const push = (value: unknown) => {
    if (typeof value === "string") rules.push(["*", value]);
    else if (isRecord(value))
      for (const [pattern, action] of Object.entries(value))
        if (typeof action === "string") rules.push([pattern, action]);
  };
  const entries = isRecord(permission) ? Object.entries(permission) : [];
  for (const [key, value] of entries)
    if (wildcard(key).test("skill")) push(key === "skill" && skill ? skill.value : value);
  if (skill && !entries.some(([key]) => key === "skill")) push(skill.value);
  return rules;
}

/** What OpenCode decides for skill `name`: the last matching rule wins, allow when none does. */
export function openCodeSkillAction(
  permission: unknown,
  name: string,
  skill?: { readonly value: unknown },
): string {
  let action = "allow";
  const target = name.replaceAll("\\", "/");
  for (const [pattern, value] of openCodeSkillRules(permission, skill))
    if (wildcard(pattern).test(target)) action = value;
  return action;
}

/** The folders Pi applies its user `skills` entries to: its own skills folder and `~/.agents/skills`. */
export function piUserSkillRoots(file: string, home: string | undefined): ReadonlyArray<string> {
  const roots = [NodePath.resolve(NodePath.dirname(file), "skills")];
  if (home !== undefined) roots.push(NodePath.resolve(home, ".agents", "skills"));
  return roots;
}

/**
 * The path Pi's exact `-` entries match for a skill: a SKILL.md's folder, a
 * plain `.md` skill's own file; undefined when the path is not a file on disk.
 */
export function piSkillEntry(path: string): string | undefined {
  if (!NodePath.isAbsolute(path)) return undefined;
  const resolved = NodePath.resolve(path);
  return /(^|[\\/])SKILL\.md$/i.test(resolved) ? NodePath.dirname(resolved) : resolved;
}

const isInside = (path: string, root: string) =>
  path.startsWith(`${root}${NodePath.sep}`) || path === root;

/** Whether Pi's user file can switch this skill: it sits in one of the user skill folders. */
export function isPiUserSkill(state: NativeSkillSwitchState, path: string): boolean {
  const entry = piSkillEntry(path);
  return entry !== undefined && (state.userRoots ?? []).some((root) => isInside(entry, root));
}

/** Reads the switches out of the file text; a missing file (`null`) switches nothing off. */
export function readNativeSkillSwitches(
  harness: NativeSkillHarness,
  text: string | null,
  file: string,
  home?: string | undefined,
): NativeSkillSwitchRead {
  const userRoots = harness === "pi" ? piUserSkillRoots(file, home) : undefined;
  if (text === null) return { status: "ok", state: { ...EMPTY_STATE, userRoots } };
  const label = NATIVE_SKILL_HARNESS_LABELS[harness];
  const document = harness === "grok" ? parseTomlObject(text) : parseJsonObject(text);
  if (document === undefined)
    return { status: "invalid", why: `${file} is not a file ${label} can read.` };
  const names = (list: ReadonlyArray<string> | undefined) =>
    new Set((list ?? []).map((name) => normalizeName(harness, name.trim())).filter(Boolean));
  const invalidList = (key: string): NativeSkillSwitchRead => ({
    status: "invalid",
    why: `${key} in ${file} is not a list of skill names.`,
  });
  switch (harness) {
    case "grok": {
      const skills = document.skills;
      if (skills !== undefined && !isRecord(skills)) return invalidList("[skills]");
      const disabled = skills?.disabled;
      if (disabled !== undefined && stringList(disabled) === undefined)
        return invalidList("[skills].disabled");
      return { status: "ok", state: { names: names(stringList(disabled)), folders: new Set() } };
    }
    case "gemini": {
      const skills = document.skills;
      if (skills !== undefined && !isRecord(skills)) return invalidList("skills");
      const disabled = skills?.disabled;
      if (disabled !== undefined && stringList(disabled) === undefined)
        return invalidList("skills.disabled");
      return { status: "ok", state: { names: names(stringList(disabled)), folders: new Set() } };
    }
    case "copilot": {
      const disabled = document.disabledSkills;
      if (disabled !== undefined && stringList(disabled) === undefined)
        return invalidList("disabledSkills");
      return { status: "ok", state: { names: names(stringList(disabled)), folders: new Set() } };
    }
    case "opencode": {
      const tools = document.tools;
      const permission = document.permission;
      const rules = openCodeSkillRules(permission);
      // OpenCode drops the skill tool itself when its last rule denies every name.
      const last = rules.at(-1);
      const allOff =
        isRecord(tools) && tools.skill === false
          ? `${file} turns OpenCode's skill tool off ("tools": {"skill": false}), so it loads no skills at all.`
          : last !== undefined && last[0] === "*" && last[1] === "deny"
            ? `${file} denies every skill (permission), so OpenCode loads none.`
            : undefined;
      // Names a rule spells out and the rules leave denied; wildcard denials are evaluated per skill.
      const denied = rules.flatMap(([name]) =>
        !/[*?]/.test(name) && openCodeSkillAction(permission, name) === "deny" ? [name] : [],
      );
      return {
        status: "ok",
        state: {
          names: new Set(denied),
          folders: new Set(),
          rules: permission,
          ...(allOff ? { allOff } : {}),
        },
      };
    }
    case "pi": {
      const skills = document.skills;
      if (skills !== undefined && stringList(skills) === undefined) return invalidList("skills");
      const agentDir = NodePath.dirname(file);
      const folders = (stringList(skills) ?? []).flatMap((entry) =>
        entry.startsWith("-") ? [piFolder(entry.slice(1), agentDir)] : [],
      );
      return { status: "ok", state: { names: new Set(), folders: new Set(folders), userRoots } };
    }
  }
}

/** The skill a switch is about: its name as the agent lists it and its SKILL.md. */
export interface NativeSkillTarget {
  readonly name: string;
  readonly path: string;
  /** Pi: other copies of the skill in the user folders; Pi loads the first, so all are switched. */
  readonly copies?: ReadonlyArray<string> | undefined;
}

/** Whether the file switches this skill off (a whole-agent switch counts). */
export function isNativeSkillOff(
  harness: NativeSkillHarness,
  state: NativeSkillSwitchState,
  skill: NativeSkillTarget,
): boolean {
  if (state.allOff !== undefined) return true;
  if (harness === "pi")
    return isPiUserSkill(state, skill.path) && state.folders.has(piSkillEntry(skill.path)!);
  if (harness === "opencode") return openCodeSkillAction(state.rules, skill.name) === "deny";
  return state.names.has(normalizeName(harness, skill.name));
}

export type NativeSkillSwitchPlan =
  | {
      readonly status: "ok";
      readonly nextText: string;
      readonly changed: boolean;
      /** One line for the preview, such as `Add demo to skills.disabled in …`. */
      readonly summary: string;
      /** Whether the agent loads the skill once the edit is in place. */
      readonly effectiveEnabled: boolean;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly status: "invalid"; readonly why: string };

/** Indentation the file already uses, so an inserted key lines up with its neighbours. */
function detectIndent(text: string): { readonly insertSpaces: boolean; readonly tabSize: number } {
  const line = /\n([ \t]+)\S/.exec(text);
  if (!line) return { insertSpaces: true, tabSize: 2 };
  const indent = line[1]!;
  return indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1 }
    : { insertSpaces: true, tabSize: Math.min(Math.max(indent.length, 1), 8) };
}

function editJson(text: string | null, path: ReadonlyArray<string>, value: unknown): string {
  const base = text === null || text.trim() === "" ? "{}\n" : text;
  const formattingOptions = { ...detectIndent(base), eol: base.includes("\r\n") ? "\r\n" : "\n" };
  const next = applyEdits(base, modify(base, [...path], value, { formattingOptions }));
  return next.endsWith("\n") ? next : `${next}\n`;
}

/** `list` with `name` taken out (by `same`), or added at the end when `add` and not there yet. */
function switchedList(
  list: ReadonlyArray<string>,
  name: string,
  add: boolean,
  same: (entry: string) => boolean,
): ReadonlyArray<string> {
  if (add && list.some(same)) return list;
  const kept = list.filter((entry) => !same(entry));
  return add ? [...kept, name] : kept;
}

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const TOML_SECTION = /^[ \t]*\[\[?[^\]\n]*\]\]?[ \t]*(?:#.*)?$/gm;
const TOML_SKILLS_HEADER = /^[ \t]*\[[ \t]*skills[ \t]*\][ \t]*(?:#.*)?$/m;
const TOML_DISABLED = /^[ \t]*disabled[ \t]*=[ \t]*\[[^\]]*\][ \t]*(?:#.*)?$/m;

const tomlStringArray = (list: ReadonlyArray<string>) =>
  `[${list.map((entry) => JSON.stringify(entry)).join(", ")}]`;

/** Grok's config.toml with `[skills].disabled` set to `list`, or undefined when it cannot be done in place. */
function editGrokDisabled(text: string, list: ReadonlyArray<string>): string | undefined {
  const line = `disabled = ${tomlStringArray(list)}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const header = TOML_SKILLS_HEADER.exec(text);
  if (header === null) {
    if (list.length === 0) return text;
    const separator = text === "" || text.endsWith("\n") ? "" : eol;
    const gap = text.trim() === "" ? "" : eol;
    return `${text}${separator}${gap}[skills]${eol}${line}${eol}`;
  }
  const bodyStart = header.index + header[0].length;
  TOML_SECTION.lastIndex = bodyStart;
  const nextSection = TOML_SECTION.exec(text);
  const bodyEnd = nextSection?.index ?? text.length;
  const body = text.slice(bodyStart, bodyEnd);
  const existing = TOML_DISABLED.exec(body);
  const nextBody =
    existing !== null
      ? `${body.slice(0, existing.index)}${body
          .slice(existing.index)
          .replace(TOML_DISABLED, (match) => {
            const indent = /^[ \t]*/.exec(match)![0];
            const comment = /\][ \t]*(#.*)$/.exec(match)?.[1];
            return `${indent}${line}${comment ? ` ${comment}` : ""}`;
          })}`
      : `${eol}${line}${body}`;
  return `${text.slice(0, bodyStart)}${nextBody}${text.slice(bodyEnd)}`;
}

/** Everything but `[skills].disabled`, to prove a TOML edit touched only that list. */
function withoutGrokDisabled(document: Record<string, unknown>): string {
  const skills = isRecord(document.skills) ? { ...document.skills } : document.skills;
  if (isRecord(skills)) delete skills.disabled;
  const rest: Record<string, unknown> = { ...document };
  if (isRecord(skills) && Object.keys(skills).length === 0) delete rest.skills;
  else rest.skills = skills;
  return JSON.stringify(rest);
}

/**
 * The file text with this one skill switched, plus what the agent ends up
 * doing. Works on the text alone; the caller reads and writes the file.
 */
export function planNativeSkillSwitch(input: {
  readonly harness: NativeSkillHarness;
  readonly file: string;
  readonly text: string | null;
  readonly skill: NativeSkillTarget;
  readonly enabled: boolean;
  /** The user's home, where Pi's `~/.agents/skills` lives. */
  readonly home?: string | undefined;
}): NativeSkillSwitchPlan {
  const { harness, file, text, skill, enabled, home } = input;
  const label = NATIVE_SKILL_HARNESS_LABELS[harness];
  const read = readNativeSkillSwitches(harness, text, file, home);
  if (read.status === "invalid") return read;
  const off = !enabled;
  const name = skill.name;
  const verb = (key: string) =>
    off ? `Add ${name} to ${key} in ${file}.` : `Take ${name} out of ${key} in ${file}.`;
  const document =
    text === null ? {} : (harness === "grok" ? parseTomlObject(text) : parseJsonObject(text))!;
  let nextText = text ?? "";
  let summary = "";
  switch (harness) {
    case "grok": {
      const skills = isRecord(document.skills) ? document.skills : {};
      const before = stringList(skills.disabled) ?? [];
      const after = switchedList(before, name, off, (entry) => entry.trim() === name);
      summary = verb("[skills].disabled");
      if (!sameStrings(before, after)) {
        const edited = editGrokDisabled(text ?? "", after);
        const reparsed = edited === undefined ? undefined : parseTomlObject(edited);
        const proven =
          reparsed !== undefined &&
          sameStrings(
            stringList(isRecord(reparsed.skills) ? reparsed.skills.disabled : undefined) ?? [],
            after,
          ) &&
          withoutGrokDisabled(reparsed) === withoutGrokDisabled(document);
        if (!proven)
          return {
            status: "invalid",
            why: `${file} keeps [skills] in a form this cannot edit safely. Add "${name}" to [skills].disabled by hand.`,
          };
        nextText = edited!;
      }
      break;
    }
    case "gemini":
    case "copilot": {
      const key = harness === "gemini" ? ["skills", "disabled"] : ["disabledSkills"];
      const holder = harness === "gemini" ? document.skills : document;
      const before = (isRecord(holder) ? stringList(holder[key.at(-1)!]) : undefined) ?? [];
      const target = normalizeName(harness, name);
      const after = switchedList(
        before,
        name,
        off,
        (entry) => normalizeName(harness, entry.trim()) === target,
      );
      summary = verb(key.join("."));
      if (!sameStrings(before, after)) nextText = editJson(text, key, after);
      break;
    }
    case "opencode": {
      if (typeof document.permission === "string")
        return {
          status: "invalid",
          why: `${file} sets "permission" to "${document.permission}" for every tool. Add a permission.skill rule for ${name} by hand.`,
        };
      const permission = isRecord(document.permission) ? document.permission : undefined;
      const current = permission?.skill;
      if (current !== undefined && typeof current !== "string" && !isRecord(current))
        return {
          status: "invalid",
          why: `permission.skill in ${file} is not a rule or a map of rules.`,
        };
      const action = off ? "deny" : "allow";
      const setRule = `Set permission.skill."${name}" to "${action}" in ${file}.`;
      summary = setRule;
      const decides = (value: unknown) =>
        openCodeSkillAction(permission, name, { value }) === "deny";
      if (decides(current) === off) break;
      if (typeof current === "string") {
        nextText = editJson(text, ["permission", "skill"], { "*": current, [name]: action });
        break;
      }
      const rules = isRecord(current) ? current : {};
      const without = Object.fromEntries(Object.entries(rules).filter(([key]) => key !== name));
      if (Object.hasOwn(rules, name) && decides(without) === off) {
        // Dropping the skill's own rule is enough.
        summary = `Remove permission.skill."${name}" from ${file}.`;
        nextText =
          Object.keys(without).length === 0
            ? editJson(text, ["permission", "skill"], undefined)
            : editJson(text, ["permission", "skill", name], undefined);
        break;
      }
      // The last matching rule wins, so the skill's rule moves to the end.
      const base = Object.hasOwn(rules, name)
        ? editJson(text, ["permission", "skill", name], undefined)
        : text;
      nextText = editJson(base, ["permission", "skill", name], action);
      break;
    }
    case "pi": {
      const folder = piSkillEntry(skill.path);
      if (folder === undefined)
        return { status: "invalid", why: `Pi did not report where ${name} is on disk.` };
      if (!isPiUserSkill(read.state, skill.path))
        return {
          status: "invalid",
          why: `Pi applies ${file} only to skills in ${(read.state.userRoots ?? []).join(" and ")}. Switch ${name} in the project's .pi/settings.json instead.`,
        };
      const agentDir = NodePath.dirname(file);
      const entries = [
        folder,
        ...(skill.copies ?? []).flatMap((copy) => {
          const entry = piSkillEntry(copy);
          return entry !== undefined && entry !== folder && isPiUserSkill(read.state, copy)
            ? [entry]
            : [];
        }),
      ];
      const before = stringList(document.skills) ?? [];
      const after = entries.reduce(
        (list, entry) =>
          switchedList(
            list,
            `-${entry}`,
            off,
            (value) =>
              (value.startsWith("-") || value.startsWith("+")) &&
              piFolder(value.slice(1), agentDir) === entry,
          ),
        before,
      );
      const quoted = entries.map((entry) => `"-${entry}"`).join(", ");
      summary = off
        ? `Add ${quoted} to skills in ${file}.`
        : `Remove ${quoted} from skills in ${file}.`;
      if (!sameStrings(before, after))
        nextText = editJson(text, ["skills"], after.length === 0 ? undefined : after);
      break;
    }
  }
  const changed = nextText !== (text ?? "");
  const nextRead = readNativeSkillSwitches(harness, changed ? nextText : text, file, home);
  if (nextRead.status === "invalid") return nextRead;
  // Pi loads a skill while any copy of it is left on.
  const effectiveEnabled = [skill.path, ...(harness === "pi" ? (skill.copies ?? []) : [])].some(
    (path) => !isNativeSkillOff(harness, nextRead.state, { name: skill.name, path }),
  );
  const warnings: Array<string> = [];
  if (nextRead.state.allOff !== undefined) warnings.push(nextRead.state.allOff);
  else if (effectiveEnabled !== enabled)
    warnings.push(
      `${label} still keeps ${name} ${effectiveEnabled ? "on" : "off"} after this edit.`,
    );
  if (harness === "gemini" && off)
    warnings.push(
      "Gemini CLI matches skill names in any case, so every skill it lists as this name goes off.",
    );
  return { status: "ok", nextText, changed, summary, effectiveEnabled, warnings };
}
