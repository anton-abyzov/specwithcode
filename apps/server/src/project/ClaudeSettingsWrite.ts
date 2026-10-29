/**
 * ClaudeSettingsWrite — turns one Claude Code skill on or off by editing
 * `skillOverrides` in one settings file.
 *
 * Claude Code has no command for a single skill, so the switch is a file
 * edit. It is careful in the ways the CLI is strict:
 *
 * - The edit goes through `jsonc-parser`, so comments, trailing commas and
 *   every other key in the file stay as they were.
 * - Claude validates the whole map: one unknown value makes it ignore every
 *   override in that file. A file whose map is already invalid is refused
 *   (`overrides_invalid`), and the map is checked again after the edit.
 * - Managed settings always win, so a key they set is refused
 *   (`managed_override`).
 * - Disabling writes `"off"`. Enabling deletes the key, unless a file of
 *   lower precedence says `"off"`, in which case it writes `"on"`.
 * - When a file that outranks the requested one decides the key the other
 *   way (a user skill the project's `settings.json` turns off), the switch
 *   goes in the repository's `settings.local.json` instead, the highest file
 *   short of managed settings, and the plan says so. The project's shared
 *   `settings.json` is never edited.
 * - The plan carries the file's hash; the write re-reads the file and refuses
 *   with `stale` when it changed, keeps a backup, and replaces the file by
 *   renaming a finished temporary file over it.
 *
 * Scopes: `user` is `<config dir>/settings.json`; `local` is the repository
 * root's `.claude/settings.local.json`, which outranks the cwd's own local
 * file (the cwd's when it is not in a repository).
 *
 * @module project/ClaudeSettingsWrite
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@specweave-studio/shared/schemaJson";
import { applyEdits, modify } from "jsonc-parser";

import { sha256, randomBytes } from "../nodeCrypto.ts";
import {
  claudeManagedSettingsPath,
  findRepositoryRoot,
  skillOverrideSettingsPaths,
} from "../provider/Drivers/ClaudeSkills.ts";

export const SKILL_OVERRIDE_VALUES = ["on", "name-only", "user-invocable-only", "off"] as const;
export type SkillOverrideValue = (typeof SKILL_OVERRIDE_VALUES)[number];

const SkillOverrideValueSchema = Schema.Literals(SKILL_OVERRIDE_VALUES);
const SkillOverridesMap = Schema.Record(Schema.String, SkillOverrideValueSchema);
const SettingsObject = fromLenientJson(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettingsObject = Schema.decodeUnknownOption(SettingsObject);
const decodeOverridesMap = Schema.decodeUnknownOption(SkillOverridesMap);

const MAX_SETTINGS_BYTES = 2_000_000;
export const MAX_SETTINGS_BACKUPS = 20;

/** What one settings file says about `skillOverrides`. */
export type SkillOverridesRead =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly map: Readonly<Record<string, SkillOverrideValue>> }
  /** The file or its map is not something Claude would apply. */
  | { readonly status: "invalid"; readonly why: string };

export function readSkillOverrides(text: string | null): SkillOverridesRead {
  if (text === null || text.trim() === "") return { status: "absent" };
  const settings = decodeSettingsObject(text);
  if (Option.isNone(settings))
    return { status: "invalid", why: "The file is not a JSON object Claude can read." };
  if (!Object.hasOwn(settings.value, "skillOverrides")) return { status: "ok", map: {} };
  const map = decodeOverridesMap(settings.value.skillOverrides);
  return Option.isSome(map)
    ? { status: "ok", map: map.value }
    : {
        status: "invalid",
        why: `skillOverrides holds a value other than ${SKILL_OVERRIDE_VALUES.join(", ")}.`,
      };
}

/** Indentation the file already uses, so an inserted key lines up with its neighbours. */
function detectIndent(text: string): { readonly insertSpaces: boolean; readonly tabSize: number } {
  const line = /\n([ \t]+)\S/.exec(text);
  if (!line) return { insertSpaces: true, tabSize: 2 };
  const indent = line[1]!;
  return indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1 }
    : { insertSpaces: true, tabSize: Math.min(Math.max(indent.length, 1), 8) };
}

/**
 * The file text with `skillOverrides[key]` set to `value`, or removed when
 * `value` is undefined. Everything else, comments and trailing commas
 * included, is kept. A missing file starts as `{}`.
 */
export function editSkillOverride(
  text: string | null,
  key: string,
  value: SkillOverrideValue | undefined,
): string {
  const base = text === null || text.trim() === "" ? "{}\n" : text;
  const options = {
    formattingOptions: { ...detectIndent(base), eol: base.includes("\r\n") ? "\r\n" : "\n" },
  };
  const before = readSkillOverrides(text);
  // Nothing to remove: jsonc-parser cannot delete from a document without the key.
  if (value === undefined && (before.status !== "ok" || !Object.hasOwn(before.map, key)))
    return text ?? "";
  // Removing the only key would leave `"skillOverrides": {}`; drop the map instead.
  const onlyKey =
    value === undefined &&
    before.status === "ok" &&
    Object.keys(before.map).length === 1 &&
    Object.hasOwn(before.map, key);
  const path = onlyKey ? ["skillOverrides"] : ["skillOverrides", key];
  const next = applyEdits(base, modify(base, path, value, options));
  return next.endsWith("\n") ? next : `${next}\n`;
}

/** sha256 of a settings file's text, or `absent` when there is no file. */
export const settingsFileHash = (text: string | null): string =>
  text === null ? "absent" : sha256([text], "hex");

export class ClaudeSettingsWriteError extends Schema.TaggedError<ClaudeSettingsWriteError>()(
  "ClaudeSettingsWriteError",
  {
    reason: Schema.Literals([
      "managed_override",
      "overrides_invalid",
      "overridden",
      "stale",
      "write_failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ClaudeSkillOverrideRequest {
  /** The instance's Claude config folder (`CLAUDE_CONFIG_DIR`). */
  readonly configDir: string;
  readonly cwd: string;
  /** `name`, or `<plugin>:<skill>` for a plugin skill. */
  readonly key: string;
  readonly enabled: boolean;
  readonly scope: "user" | "local";
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  /** Tests point this at a temporary file; otherwise the platform's managed settings. */
  readonly managedPath?: string | undefined;
}

export interface ClaudeSkillOverridePlan {
  readonly target: string;
  /** The file the requested scope names; differs from `target` when that file could not decide the key. */
  readonly requestedTarget: string;
  /** False when the file already says what the switch needs; the apply then writes nothing. */
  readonly changed: boolean;
  readonly key: string;
  /** What is written: a value, or undefined for removing the key. */
  readonly value: SkillOverrideValue | undefined;
  readonly currentText: string | null;
  readonly currentHash: string;
  readonly nextText: string;
  /** Whether Claude loads the skill once the edit is in place, merged across every file. */
  readonly effectiveEnabled: boolean;
  /** The files that decide this key, lowest precedence first. */
  readonly files: ReadonlyArray<string>;
  /** True when the target is a repository root's `settings.local.json`. */
  readonly localFile: boolean;
  readonly repositoryRoot: string | undefined;
  readonly summary: string;
  /** Plain sentences for the preview, such as why the switch went to another file. */
  readonly warnings: ReadonlyArray<string>;
}

const readText = Effect.fn("claudeSettingsWrite.readText")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(info)) return null;
  if (info.value.type !== "File" || info.value.size > BigInt(MAX_SETTINGS_BYTES))
    return yield* new ClaudeSettingsWriteError({
      reason: "overrides_invalid",
      detail: `${file} is not a settings file this can edit.`,
    });
  return yield* fs.readFileString(file).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeSettingsWriteError({
          reason: "write_failed",
          detail: `${file} could not be read.`,
          cause,
        }),
    ),
  );
});

/** Works out the edit without writing anything; the preview shows this. */
export const planClaudeSkillOverride = Effect.fn("claudeSettingsWrite.plan")(function* (
  request: ClaudeSkillOverrideRequest,
) {
  const path = yield* Path.Path;
  const repositoryRoot = yield* findRepositoryRoot(request.cwd);
  const ordered = skillOverrideSettingsPaths(
    path,
    request.configDir,
    request.cwd,
    request.platform,
    request.environment,
    repositoryRoot,
  );
  const managed =
    request.managedPath ??
    claudeManagedSettingsPath(path, request.platform, request.environment) ??
    null;
  // The managed path comes last in `ordered`; it is read separately so tests can move it.
  const managedDefault = claudeManagedSettingsPath(path, request.platform, request.environment);
  const scoped = ordered.filter((file) => file !== managedDefault);
  const localTarget = path.join(repositoryRoot ?? request.cwd, ".claude", "settings.local.json");
  const target = request.scope === "user" ? scoped[0]! : localTarget;
  const files = scoped.includes(target) ? scoped : [...scoped, target];

  if (managed !== null) {
    const managedRead = readSkillOverrides(
      yield* readText(managed).pipe(Effect.orElseSucceed(() => null)),
    );
    if (managedRead.status === "ok" && Object.hasOwn(managedRead.map, request.key))
      return yield* new ClaudeSettingsWriteError({
        reason: "managed_override",
        detail: `Managed settings (${managed}) set ${request.key} to "${managedRead.map[request.key]}", which always wins.`,
      });
  }

  const texts = new Map<string, string | null>();
  for (const file of files) texts.set(file, yield* readText(file));

  /** The value the merged files give the key, and the file that decides it, with `target` edited. */
  const mergedWith = (target: string, nextText: string) => {
    let merged: SkillOverrideValue | undefined;
    let decider: string | undefined;
    for (const file of files) {
      const read = readSkillOverrides(file === target ? nextText : (texts.get(file) ?? null));
      if (read.status === "ok" && Object.hasOwn(read.map, request.key)) {
        merged = read.map[request.key];
        decider = file;
      }
    }
    return { merged, decider };
  };

  /** The first edit of `target` that leaves the skill as requested, or undefined. */
  const attempt = (target: string, values: ReadonlyArray<SkillOverrideValue | undefined>) =>
    Effect.gen(function* () {
      const currentText = texts.get(target) ?? null;
      const current = readSkillOverrides(currentText);
      if (current.status === "invalid")
        return yield* new ClaudeSettingsWriteError({
          reason: "overrides_invalid",
          detail: `${target}: ${current.why} Claude ignores every override there until it is fixed.`,
        });
      for (const value of values) {
        const nextText = editSkillOverride(currentText, request.key, value);
        const next = readSkillOverrides(nextText);
        // Removing the only key drops the map, which reads back as absent.
        const nextValid =
          next.status === "ok"
            ? next.map[request.key] === value
            : next.status === "absent" && value === undefined;
        if (!nextValid)
          return yield* new ClaudeSettingsWriteError({
            reason: "overrides_invalid",
            detail: `The edit to ${target} did not produce a valid skillOverrides map.`,
          });
        const { merged, decider } = mergedWith(target, nextText);
        if ((merged !== "off") === request.enabled)
          return { target, value, currentText, nextText, merged, decider };
      }
      return undefined;
    });

  const requestedTarget = target;
  // Enabling removes the key when that is enough; disabling at the requested file writes "off".
  const requestedValues: ReadonlyArray<SkillOverrideValue | undefined> = request.enabled
    ? [undefined, "on"]
    : ["off"];
  let chosen = yield* attempt(requestedTarget, requestedValues);
  const warnings: Array<string> = [];
  if (chosen === undefined && requestedTarget !== localTarget) {
    // A file above the requested one decides the key; only the repository's local file outranks it.
    const blocked = mergedWith(
      requestedTarget,
      editSkillOverride(
        texts.get(requestedTarget) ?? null,
        request.key,
        request.enabled ? "on" : "off",
      ),
    );
    chosen = yield* attempt(localTarget, request.enabled ? [undefined, "on"] : [undefined, "off"]);
    if (chosen !== undefined && blocked.decider !== undefined)
      warnings.push(
        `${blocked.decider} sets ${request.key} to "${blocked.merged}" and outranks ${requestedTarget}, so this switch goes in ${localTarget} and applies to this repository only.`,
      );
  }
  if (chosen === undefined) {
    const { merged, decider } = mergedWith(
      requestedTarget,
      editSkillOverride(
        texts.get(requestedTarget) ?? null,
        request.key,
        request.enabled ? "on" : "off",
      ),
    );
    return yield* new ClaudeSettingsWriteError({
      reason: "overridden",
      detail: `${decider ?? "Another settings file"} sets ${request.key} to "${merged ?? "off"}" and outranks every file this can edit.`,
    });
  }

  const changed = chosen.nextText !== (chosen.currentText ?? "");
  const action =
    chosen.value === undefined
      ? `remove skillOverrides["${request.key}"]`
      : `set skillOverrides["${request.key}"] to "${chosen.value}"`;
  return {
    target: chosen.target,
    requestedTarget,
    changed,
    key: request.key,
    value: chosen.value,
    currentText: chosen.currentText,
    currentHash: settingsFileHash(chosen.currentText),
    nextText: chosen.nextText,
    effectiveEnabled: chosen.merged !== "off",
    files,
    localFile: chosen.target === localTarget,
    repositoryRoot,
    summary: changed
      ? `${action} in ${chosen.target}`
      : `${chosen.target} already leaves ${request.key} ${request.enabled ? "on" : "off"}; nothing to write`,
    warnings,
  } satisfies ClaudeSkillOverridePlan;
});

/**
 * Whether Claude loads plugin `pluginId` here, merged as Claude merges
 * `enabledPlugins`: key by key across the same files as `skillOverrides`,
 * managed settings last. Undefined when no file mentions it.
 */
export const readClaudePluginEnabled = Effect.fn("claudeSettingsWrite.pluginEnabled")(function* (
  request: Pick<
    ClaudeSkillOverrideRequest,
    "configDir" | "cwd" | "platform" | "environment" | "managedPath"
  > & { readonly pluginId: string },
) {
  const path = yield* Path.Path;
  const repositoryRoot = yield* findRepositoryRoot(request.cwd);
  const managedDefault = claudeManagedSettingsPath(path, request.platform, request.environment);
  const ordered = skillOverrideSettingsPaths(
    path,
    request.configDir,
    request.cwd,
    request.platform,
    request.environment,
    repositoryRoot,
  ).filter((file) => file !== managedDefault);
  const managed = request.managedPath ?? managedDefault;
  let merged: boolean | undefined;
  for (const file of managed === undefined ? ordered : [...ordered, managed]) {
    const text = yield* readText(file).pipe(Effect.orElseSucceed(() => null));
    if (text === null) continue;
    const settings = decodeSettingsObject(text);
    if (Option.isNone(settings)) continue;
    const plugins = settings.value.enabledPlugins;
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) continue;
    const value = (plugins as Record<string, unknown>)[request.pluginId];
    if (typeof value === "boolean") merged = value;
  }
  return merged;
});

const BackupFile = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    /** Null: the file did not exist before the change. */
    contents: Schema.NullOr(Schema.String),
    savedAt: Schema.Number,
  }),
);
const encodeBackup = Schema.encodeSync(BackupFile);
const BACKUP_NAME = /^\d{13}-[0-9a-f]{8}\.json$/;

/** What {@link applyClaudeSkillOverride} needs; other agents' switch files are written the same way. */
export type SettingsFileWrite = Pick<
  ClaudeSkillOverridePlan,
  "target" | "currentHash" | "changed" | "nextText"
>;

/**
 * Writes the planned edit. The file is read again first: when its hash is
 * not `expectedHash` (the preview's) or the plan's, nothing is written.
 */
export const applyClaudeSkillOverride = Effect.fn("claudeSettingsWrite.apply")(function* (
  plan: SettingsFileWrite,
  options: { readonly expectedHash?: string | undefined; readonly backupDir?: string | undefined },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failed = (detail: string) => (cause: unknown) =>
    new ClaudeSettingsWriteError({ reason: "write_failed", detail, cause });
  const now = yield* readText(plan.target);
  const hash = settingsFileHash(now);
  if (
    hash !== plan.currentHash ||
    (options.expectedHash !== undefined && hash !== options.expectedHash)
  )
    return yield* new ClaudeSettingsWriteError({
      reason: "stale",
      detail: `${plan.target} changed since it was read.`,
    });
  // The file already says what the switch needs; leave it, and its modification time, alone.
  if (!plan.changed) return { backupId: undefined, hash };
  const millis = yield* Clock.currentTimeMillis;
  let backupId: string | undefined;
  if (options.backupDir !== undefined) {
    backupId = `${String(millis).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
    yield* fs
      .makeDirectory(options.backupDir, { recursive: true })
      .pipe(Effect.mapError(failed("The backup folder could not be made.")));
    yield* fs
      .writeFileString(
        path.join(options.backupDir, `${backupId}.json`),
        encodeBackup({ path: plan.target, contents: now, savedAt: millis }),
        { mode: 0o600 },
      )
      .pipe(Effect.mapError(failed("The backup could not be written.")));
    const names = yield* fs.readDirectory(options.backupDir).pipe(Effect.orElseSucceed(() => []));
    for (const name of names
      .filter((name) => BACKUP_NAME.test(name))
      .toSorted()
      .slice(0, -MAX_SETTINGS_BACKUPS))
      yield* fs.remove(path.join(options.backupDir, name)).pipe(Effect.ignore);
  }
  // The file a linked settings file points at, as the CLI's own write would follow it.
  const file =
    now === null
      ? plan.target
      : yield* fs.realPath(plan.target).pipe(Effect.orElseSucceed(() => plan.target));
  const mode =
    now === null
      ? 0o644
      : yield* fs.stat(file).pipe(
          Effect.map((info) => Number(info.mode) & 0o777),
          Effect.orElseSucceed(() => 0o644),
        );
  yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.mapError(failed(`${path.dirname(file)} could not be made.`)));
  const temporary = `${file}.skills-${millis}-${randomBytes(4).toString("hex")}.tmp`;
  yield* fs.writeFileString(temporary, plan.nextText, { flag: "wx", mode }).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.mapError(failed(`${plan.target} could not be written.`)),
    Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
  );
  return { backupId, hash: settingsFileHash(plan.nextText) };
});
