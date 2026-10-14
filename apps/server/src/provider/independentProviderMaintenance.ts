import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- The current user's home identifies the owned private prefix.
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ProviderMaintenanceResolutionContext } from "./providerMaintenance.ts";

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
const parseManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The independent wrappers front a pinned local npm prefix, not a native or
 * global installer. Even an unverifiable nominal wrapper must stay manual;
 * unrelated installations retain their ordinary maintenance resolution.
 */
export const independentProviderMaintenance = Effect.fn("independentProviderMaintenance")(function* (input: {
  readonly provider: string;
  readonly packageName: string;
  readonly context: ProviderMaintenanceResolutionContext;
  readonly homeDirectory?: string;
  readonly architecture?: string;
}) {
  const name = input.provider === "codex" && input.packageName === "@openai/codex" ? "codex"
    : input.provider === "claudeAgent" && input.packageName === "@anthropic-ai/claude-code" ? "claude" : null;
  if (!name) return null;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = path.resolve(input.homeDirectory ?? NodeOS.homedir());
  const prefix = path.join(home, ".local/share/specweave/providers");
  const wrapper = path.join(prefix, "bin", name);
  if (![input.context.resolvedCommandPath, input.context.realCommandPath].some((value) => path.resolve(value) === wrapper)) return null;

  const inspect = Effect.gen(function* () {
    const architecture = input.architecture ?? NodeOS.arch();
    if (name === "claude" && (input.context.platform !== "darwin" || architecture !== "arm64")) return "unverified" as const;
    const packageDirectory = path.join(prefix, "node_modules", input.packageName);
    const nativePackage = path.join(prefix, "node_modules", "@anthropic-ai/claude-code-darwin-arm64");
    const entrypoint = name === "codex" ? path.join(packageDirectory, "bin/codex.js") : path.join(nativePackage, "claude");
    // Check every ancestor, including the home and package scopes. A symlink
    // must not turn this private-prefix classification into another owner.
    const realOwned = (value: string) => Effect.gen(function* () {
      if (value !== home && !value.startsWith(`${home}${path.sep}`)) return false;
          let current = home;
          if ((yield* fs.realPath(current)) !== current) return false;
          for (const part of path.relative(home, value).split(path.sep)) {
            current = path.join(current, part);
            if ((yield* fs.realPath(current)) !== current) return false;
          }
          return true;
        });
      for (const value of [
        wrapper,
        path.join(prefix, "package.json"),
        path.join(packageDirectory, "package.json"),
        entrypoint,
      ]) {
        if (!(yield* realOwned(value))) return "unverified" as const;
      }
      if ((yield* fs.stat(entrypoint)).type !== "File") return "unverified" as const;
      const boundedRead = (value: string) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(value);
          if (info.type !== "File" || Number(info.size) > 16 * 1024) return null;
          return yield* fs.readFileString(value);
        });
      const wrapperText = yield* boundedRead(wrapper);
      const prefixText = yield* boundedRead(path.join(prefix, "package.json"));
      const packageText = yield* boundedRead(path.join(packageDirectory, "package.json"));
      if (!wrapperText || !prefixText || !packageText) return "unverified" as const;
      const prefixManifest = yield* parseManifest(prefixText),
        packageManifest = yield* parseManifest(packageText);
      const version = field(packageManifest, "version");
      if (
        field(packageManifest, "name") !== input.packageName ||
        typeof version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
        field(field(prefixManifest, "dependencies"), input.packageName) !== version
      )
        return "unverified" as const;
      const lines = wrapperText.trimEnd().split("\n");
      if (lines.length !== 3 || lines[0] !== "#!/bin/sh" || lines[1] !== "set -eu")
        return "unverified" as const;
      if (name === "codex") {
        const suffix = ` ${entrypoint} "$@"`;
        if (!lines[2]!.startsWith("exec ") || !lines[2]!.endsWith(suffix))
          return "unverified" as const;
        const node = lines[2]!.slice(5, -suffix.length);
        if (
          !path.isAbsolute(node) ||
          path.basename(node) !== "node" ||
          /[\s"'`$\\;|&<>()]/.test(node)
        || !(yield* realOwned(node)) || (yield* fs.stat(node)).type !== "File") return "unverified" as const;
    } else {
      if (lines[2] !== `exec ${entrypoint} "$@"` ||
          !(yield* realOwned(path.join(nativePackage, "package.json")))
        )
          return "unverified" as const;
        const nativeText = yield* boundedRead(path.join(nativePackage, "package.json"));
        if (!nativeText) return "unverified" as const;
        const nativeManifest = yield* parseManifest(nativeText);
        if (
          field(nativeManifest, "name") !== "@anthropic-ai/claude-code-darwin-arm64" ||
          field(nativeManifest, "version") !== version
        )
          return "unverified" as const;
      }
      return "verified" as const;
    });
    return yield* inspect.pipe(Effect.orElseSucceed(() => "unverified" as const));
  },
);
