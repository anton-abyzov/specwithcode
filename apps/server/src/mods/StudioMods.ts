import { sha256 as hashSha256 } from "../nodeCrypto.ts";
import * as DateTime from "effect/DateTime";
/**
 * StudioMods - workbench customizations a user drops into `<stateDir>/mods`.
 *
 * Each mod is a folder holding `mod.json` and one module file. The server only
 * reads and hashes them; mods run in the clients, inside a sandboxed frame.
 * A mod runs only once the user approves its exact contents: the approval
 * pins the hash of `mod.json` plus the module, so any edit pauses the mod
 * until it is approved again. Approvals live outside the mods folder, so a
 * mod cannot approve itself by writing into its own directory.
 *
 * @module StudioMods
 */

import {
  ModManifest,
  ModsError,
  type ModEntry,
  type ModPermission,
  type ModsApproveInput,
  type ModsDisableInput,
  type ModsListResult,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { readThemeFileGuarded } from "../environmentTheme.ts";

/** Bounds on what a mods folder can make every client download and run. */
export const MAX_MODS = 32;
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_MODULE_BYTES = 256 * 1024;

const decodeManifestExit = Schema.decodeUnknownExit(Schema.fromJsonString(ModManifest));

const ModApproval = Schema.Struct({
  sha256: Schema.String,
  disabled: Schema.optionalKey(Schema.Boolean),
  approvedAt: Schema.optionalKey(Schema.String),
});
const ModApprovals = Schema.Record(Schema.String, ModApproval);
type ModApprovals = typeof ModApprovals.Type;
const decodeApprovals = Schema.decodeUnknownExit(Schema.fromJsonString(ModApprovals));
const encodeApprovals = Schema.encodeSync(Schema.fromJsonString(ModApprovals));

/** Reads `mod-approvals.json`; anything unreadable approves nothing. */
export const parseModApprovals = (text: string): ModApprovals | null => {
  const decoded = decodeApprovals(text);
  return Exit.isSuccess(decoded) ? decoded.value : null;
};

/** A mod folder as read from disk, before any approval is applied. */
export interface InspectedMod {
  readonly name: string;
  readonly manifest: ModManifest | null;
  readonly source: string | null;
  readonly sha256: string | null;
  readonly problems: ReadonlyArray<string>;
}

/**
 * Reads one mod folder. The one place that decides whether a folder is a
 * loadable mod, shared by the server and `specweave-studio mods validate`.
 */
export const inspectModFolder = (folderPath: string, folderName: string): InspectedMod => {
  const problems: string[] = [];
  const manifestText = readThemeFileGuarded(`${folderPath}/mod.json`, MAX_MANIFEST_BYTES);
  if (manifestText === null) {
    problems.push(
      `mod.json is missing, not a regular file, or larger than ${MAX_MANIFEST_BYTES} bytes`,
    );
    return { name: folderName, manifest: null, source: null, sha256: null, problems };
  }
  const decoded = decodeManifestExit(manifestText);
  if (Exit.isFailure(decoded)) {
    problems.push(
      "mod.json does not match the manifest format (name, version, main, optional description and permissions)",
    );
    return { name: folderName, manifest: null, source: null, sha256: null, problems };
  }
  const manifest = decoded.value;
  if (manifest.name !== folderName) {
    problems.push(`mod.json names "${manifest.name}" but the folder is "${folderName}"`);
  }
  const mainFile = manifest.main.replace(/^\.\//u, "");
  const source = readThemeFileGuarded(`${folderPath}/${mainFile}`, MAX_MODULE_BYTES);
  if (source === null) {
    problems.push(
      `${mainFile} is missing, not a regular file, or larger than ${MAX_MODULE_BYTES} bytes`,
    );
  } else if (!/\bregister\b/u.test(source)) {
    problems.push(`${mainFile} does not define register(on)`);
  }
  const sha256 = source === null ? null : hashSha256([manifestText, "\0", source], "hex");
  return { name: folderName, manifest, source, sha256, problems };
};

const dedupePermissions = (permissions: ReadonlyArray<ModPermission> | undefined) => [
  ...new Set(permissions ?? []),
];

/** Applies the user's approvals to what is on disk. */
export const toModEntry = (mod: InspectedMod, approvals: ModApprovals): ModEntry => {
  const base = {
    name: mod.name,
    permissions: dedupePermissions(mod.manifest?.permissions),
    problems: mod.problems,
    ...(mod.manifest?.version !== undefined ? { version: mod.manifest.version } : {}),
    ...(mod.manifest?.description !== undefined ? { description: mod.manifest.description } : {}),
    ...(mod.sha256 !== null ? { sha256: mod.sha256 } : {}),
  };
  if (mod.problems.length > 0 || mod.sha256 === null || mod.source === null) {
    return { ...base, status: "invalid" };
  }
  const approval = approvals[mod.name];
  if (approval === undefined) return { ...base, status: "pending" };
  if (approval.disabled === true) return { ...base, status: "disabled" };
  if (approval.sha256 !== mod.sha256) return { ...base, status: "changed" };
  return { ...base, status: "approved", source: mod.source };
};

export class StudioMods extends Context.Service<
  StudioMods,
  {
    /** Every mod folder, with the source of approved mods only. */
    readonly list: Effect.Effect<ModsListResult, ModsError>;
    /** Approves a mod at the exact contents the user saw. */
    readonly approve: (input: ModsApproveInput) => Effect.Effect<ModsListResult, ModsError>;
    readonly disable: (input: ModsDisableInput) => Effect.Effect<ModsListResult, ModsError>;
  }
>()("specweave-studio/mods/StudioMods") {}

/** Reads every mod folder in name order, up to `MAX_MODS`. */
export const readModsDirectory = Effect.fn(function* (modsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(modsDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const mods: InspectedMod[] = [];
  for (const entry of entries.toSorted()) {
    if (entry.startsWith(".")) continue;
    const folderPath = path.join(modsDir, entry);
    const info = yield* fs.stat(folderPath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "Directory") continue;
    if (mods.length >= MAX_MODS) {
      yield* Effect.logWarning("ignoring mod folders past the limit", {
        path: modsDir,
        limit: MAX_MODS,
      });
      break;
    }
    mods.push(inspectModFolder(folderPath, entry));
  }
  return mods;
});

const make = Effect.gen(function* () {
  const { modsDir, modApprovalsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writes = yield* Semaphore.make(1);

  yield* fs
    .makeDirectory(modsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.ignoreCause({ log: true }));

  const readApprovals = Effect.gen(function* () {
    const text = yield* fs.readFileString(modApprovalsPath).pipe(Effect.option);
    if (text._tag === "None") return {} as ModApprovals;
    const approvals = parseModApprovals(text.value);
    if (approvals !== null) return approvals;
    // An unreadable file approves nothing; it is rewritten on the next approval.
    yield* Effect.logWarning("ignoring unreadable mod approvals", { path: modApprovalsPath });
    return {} as ModApprovals;
  });

  const writeApprovals = (approvals: ModApprovals) =>
    Effect.gen(function* () {
      const temporary = path.join(
        path.dirname(modApprovalsPath),
        `.mod-approvals.${process.pid}.${DateTime.toEpochMillis(DateTime.nowUnsafe())}.tmp`,
      );
      yield* fs.writeFileString(temporary, `${encodeApprovals(approvals)}\n`, { mode: 0o600 });
      yield* fs.rename(temporary, modApprovalsPath);
    }).pipe(
      Effect.mapError(
        (cause) => new ModsError({ detail: "Could not save the mod approval.", cause }),
      ),
    );

  const list = Effect.gen(function* () {
    const approvals = yield* readApprovals;
    const mods = yield* readModsDirectory(modsDir);
    return { modsDir, mods: mods.map((mod) => toModEntry(mod, approvals)) };
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));

  const updateApproval = (
    name: string,
    update: (mod: InspectedMod, approvals: ModApprovals) => Effect.Effect<ModApprovals, ModsError>,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const mod = inspectModFolder(path.join(modsDir, name), name);
        const approvals = yield* readApprovals;
        yield* writeApprovals(yield* update(mod, approvals));
        return yield* list;
      }),
    );

  const approve = (input: ModsApproveInput) =>
    updateApproval(input.name, (mod, approvals) => {
      if (mod.problems.length > 0 || mod.sha256 === null) {
        return Effect.fail(
          new ModsError({
            detail: `Mod "${input.name}" cannot be loaded: ${mod.problems.join("; ")}`,
          }),
        );
      }
      if (mod.sha256 !== input.sha256) {
        return Effect.fail(
          new ModsError({
            detail: `Mod "${input.name}" changed after you reviewed it. Review it again before approving.`,
          }),
        );
      }
      return Effect.succeed({
        ...approvals,
        [input.name]: { sha256: mod.sha256, approvedAt: DateTime.formatIso(DateTime.nowUnsafe()) },
      });
    });

  const disable = (input: ModsDisableInput) =>
    updateApproval(input.name, (mod, approvals) =>
      Effect.succeed({
        ...approvals,
        [input.name]: { sha256: approvals[input.name]?.sha256 ?? mod.sha256 ?? "", disabled: true },
      }),
    );

  return StudioMods.of({ list, approve, disable });
});

export const layer = Layer.effect(StudioMods, make);
