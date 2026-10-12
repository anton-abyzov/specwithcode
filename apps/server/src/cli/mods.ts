/**
 * `specweave-studio mods` - inspect Studio Mods on this machine and check a
 * mod folder before installing it. Approval happens in Settings > Mods, where
 * the user sees what the mod asks for; the CLI never approves.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import * as ServerConfig from "../config.ts";
import {
  inspectModFolder,
  parseModApprovals,
  readModsDirectory,
  toModEntry,
} from "../mods/StudioMods.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

export class ModInvalidError extends Schema.TaggedError<ModInvalidError>()("ModInvalidError", {
  folder: Schema.String,
  problemCount: Schema.Int,
}) {
  override get message(): string {
    return `${this.folder} is not a loadable mod (${this.problemCount} problem${this.problemCount === 1 ? "" : "s"}).`;
  }
}

const envStudioHome = Config.String("STUDIO_HOME").pipe(Config.option);

const resolveModsPaths = Effect.fn(function* (explicitBaseDir: Option.Option<string>) {
  const envHome = Option.filter(yield* envStudioHome, (value) => value.trim().length > 0);
  const configuredBaseDir = Option.orElse(explicitBaseDir, () => envHome);
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: Option.isSome(configuredBaseDir),
  });
  return { modsDir: derivedPaths.modsDir, modApprovalsPath: derivedPaths.modApprovalsPath };
});

const modsListCommand = Command.make("list", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("List the mods installed on this machine and whether each runs."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* resolveModsPaths(flags.baseDir);
      const approvalsText = yield* fs.readFileString(paths.modApprovalsPath).pipe(Effect.option);
      const approvals = Option.match(approvalsText, {
        onNone: () => ({}),
        onSome: (text) => parseModApprovals(text) ?? {},
      });
      const mods = (yield* readModsDirectory(paths.modsDir)).map((mod) =>
        toModEntry(mod, approvals),
      );
      if (mods.length === 0) {
        yield* Console.log(`No mods installed (add folders to ${paths.modsDir}).\n`);
        return;
      }
      for (const mod of mods) {
        const version = mod.version === undefined ? "" : ` ${mod.version}`;
        const permissions = mod.permissions.length === 0 ? "none" : mod.permissions.join(", ");
        yield* Console.log(`${mod.name}${version}: ${mod.status} (permissions: ${permissions})`);
        for (const problem of mod.problems) yield* Console.log(`  - ${problem}`);
      }
      yield* Console.log("");
    }),
  ),
);

const modsValidateCommand = Command.make("validate", {
  folder: Argument.String("folder").pipe(
    Argument.withDescription("Mod folder holding mod.json and its module."),
  ),
}).pipe(
  Command.withDescription(
    "Check a mod folder the way SpecWithCode loads it, without installing it.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const folder = path.resolve(yield* expandHomePath(flags.folder));
      const mod = inspectModFolder(folder, path.basename(folder));
      if (mod.problems.length > 0) {
        for (const problem of mod.problems) yield* Console.error(`- ${problem}`);
        return yield* new ModInvalidError({ folder, problemCount: mod.problems.length });
      }
      const permissions = mod.manifest?.permissions ?? [];
      yield* Console.log(
        [
          `${mod.manifest?.name} ${mod.manifest?.version} is a loadable mod.`,
          `Permissions: ${permissions.length === 0 ? "none" : [...new Set(permissions)].join(", ")}`,
          `Content hash: ${mod.sha256}`,
          "Copy the folder into the mods folder of a Studio home, then approve it in Settings > Mods.",
          "",
        ].join("\n"),
      );
    }),
  ),
);

export const modsCommand = Command.make("mods").pipe(
  Command.withDescription("Inspect Studio Mods and validate a mod folder."),
  Command.withSubcommands([modsListCommand, modsValidateCommand]),
);
