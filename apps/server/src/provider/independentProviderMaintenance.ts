import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- The current user's home identifies the owned private prefix.
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ProviderMaintenanceResolutionContext } from "./providerMaintenance.ts";

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
const parseManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The independent wrappers front a pinned local npm prefix, not a native or
 * global installer. Even an unverifiable nominal wrapper must stay manual;
 * unrelated installations retain their ordinary maintenance resolution.
 */
export const independentProviderMaintenance = Effect.fn("independentProviderMaintenance")(
  function* (input: {
    readonly provider: string;
    readonly packageName: string;
    readonly context: ProviderMaintenanceResolutionContext;
    readonly homeDirectory?: string;
    readonly architecture?: string;
  }) {
    const name =
      input.provider === "codex" && input.packageName === "@openai/codex"
        ? "codex"
        : input.provider === "claudeAgent" && input.packageName === "@anthropic-ai/claude-code"
          ? "claude"
          : null;
    if (!name) return null;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const home = path.resolve(input.homeDirectory ?? NodeOS.homedir());
    const prefix = path.join(home, ".local/share/specweave/providers");
    const wrapper = path.join(prefix, "bin", name);
    if (
      ![input.context.resolvedCommandPath, input.context.realCommandPath].some(
        (value) => path.resolve(value) === wrapper,
      )
    )
      return null;

    const releases = path.join(home, ".local/share/specweave/provider-releases");
    const boundedJson = (target: string) =>
      Effect.gen(function* () {
        if (Number((yield* fs.stat(target)).size) > 16 * 1024) return null;
        return yield* parseManifest(yield* fs.readFileString(target));
      });
    // Every target must be its own real path inside the home, so no symlink
    // can move the update onto another owner's files.
    const allReal = (targets: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        for (const target of targets) {
          if (!target.startsWith(`${home}${path.sep}`) || (yield* fs.realPath(target)) !== target)
            return false;
        }
        return true;
      });
    const readWrapper = (target: string) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(target);
        return text.length > 16 * 1024 ? null : text;
      });
    const CODEX_WRAPPER =
      /^#!\/bin\/sh\nset -eu\nexec ([^\s"'`$\\;|&<>()]+) ([^\s"'`$\\;|&<>()]+) "\$@"\n$/;
    // The pinned Node beside the npm it ships with stages new releases.
    const toolchain = (node: string) =>
      Effect.gen(function* () {
        if (!path.isAbsolute(node) || path.basename(node) !== "node") return null;
        const npmPath = path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js");
        // A host still on the original prefix has no releases folder yet; the
        // first staged update creates it under this real parent.
        const hasReleases = yield* fs.exists(releases);
        if (!(yield* allReal([node, npmPath, hasReleases ? releases : path.dirname(releases)])))
          return null;
        const npmPkg = yield* boundedJson(path.resolve(path.dirname(npmPath), "../package.json"));
        return field(npmPkg, "name") === "npm" ? npmPath : null;
      });

    if (name === "codex") {
      const staged = yield* Effect.gen(function* () {
        if (input.context.platform === "win32") return null;
        const text = yield* readWrapper(wrapper);
        const match = text === null ? null : CODEX_WRAPPER.exec(text);
        if (!text || !match) return null;
        const [, node, entrypoint] = match;
        if (!node || !entrypoint) return null;
        const relative = path.relative(releases, entrypoint);
        if (
          !/^[^/]+\/node_modules\/@openai\/codex\/bin\/codex\.js$/.test(relative) ||
          relative.startsWith("..")
        )
          return null;
        const stage = path.join(releases, relative.split("/")[0]!);
        const npmPath = yield* toolchain(node);
        if (
          !npmPath ||
          !(yield* allReal([
            wrapper,
            entrypoint,
            path.join(stage, "package.json"),
            path.join(stage, "node_modules/@openai/codex/package.json"),
          ]))
        )
          return null;
        const pkg = yield* boundedJson(path.join(stage, "node_modules/@openai/codex/package.json"));
        const owner = yield* boundedJson(path.join(stage, "package.json"));
        const version = field(pkg, "version");
        if (
          field(pkg, "name") !== "@openai/codex" ||
          typeof version !== "string" ||
          !/^\d+\.\d+\.\d+$/.test(version) ||
          field(field(owner, "dependencies"), "@openai/codex") !== version
        )
          return null;
        return {
          provider: "codex" as const,
          wrapperPath: wrapper,
          expectedWrapper: text,
          releasesDirectory: releases,
          nodePath: node,
          npmCliPath: npmPath,
        };
      }).pipe(Effect.orElseSucceed(() => null));
      if (staged) return staged;
    }

    // Claude's wrapper runs the native binary, so the fleet's pinned Node and
    // npm come from the Codex wrapper beside it. Both the original private
    // prefix and a provisioned or staged release are accepted.
    if (name === "claude") {
      const staged = yield* Effect.gen(function* () {
        const architecture = input.architecture ?? NodeOS.arch();
        if (input.context.platform !== "darwin" || architecture !== "arm64") return null;
        const text = yield* readWrapper(wrapper);
        const match =
          text === null
            ? null
            : /^#!\/bin\/sh\nset -eu\nexec ([^\s"'`$\\;|&<>()]+) "\$@"\n$/.exec(text);
        const entrypoint = match?.[1];
        if (!text || !entrypoint) return null;
        const suffix = "node_modules/@anthropic-ai/claude-code-darwin-arm64/claude";
        const relative = path.relative(releases, entrypoint);
        const base =
          entrypoint === path.join(prefix, suffix)
            ? prefix
            : new RegExp(`^[^/]+/${suffix}$`).test(relative) && !relative.startsWith("..")
              ? path.join(releases, relative.split("/")[0]!)
              : null;
        if (!base) return null;
        const codexText = yield* readWrapper(path.join(prefix, "bin", "codex"));
        const node = codexText === null ? undefined : CODEX_WRAPPER.exec(codexText)?.[1];
        const npmPath = node ? yield* toolchain(node) : null;
        const packageJson = path.join(base, "node_modules/@anthropic-ai/claude-code/package.json");
        const nativeJson = path.join(
          base,
          "node_modules/@anthropic-ai/claude-code-darwin-arm64/package.json",
        );
        // A release provisioned with only the platform package (no
        // `@anthropic-ai/claude-code` wrapper package) is the same binary; its
        // owner then pins the platform package directly.
        const nativeOnly = !(yield* fs.exists(packageJson));
        if (
          !node ||
          !npmPath ||
          !(yield* allReal([
            wrapper,
            entrypoint,
            path.join(base, "package.json"),
            ...(nativeOnly ? [] : [packageJson]),
            nativeJson,
          ])) ||
          (yield* fs.stat(entrypoint)).type !== "File"
        )
          return null;
        const pkg = nativeOnly ? null : yield* boundedJson(packageJson);
        const native = yield* boundedJson(nativeJson);
        const owner = yield* boundedJson(path.join(base, "package.json"));
        const nativeName = "@anthropic-ai/claude-code-darwin-arm64";
        const version = field(nativeOnly ? native : pkg, "version");
        if (
          (!nativeOnly && field(pkg, "name") !== input.packageName) ||
          typeof version !== "string" ||
          !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
          field(native, "name") !== nativeName ||
          field(native, "version") !== version ||
          field(field(owner, "dependencies"), nativeOnly ? nativeName : input.packageName) !==
            version
        )
          return null;
        return {
          provider: "claude" as const,
          wrapperPath: wrapper,
          expectedWrapper: text,
          releasesDirectory: releases,
          nodePath: node,
          npmCliPath: npmPath,
        };
      }).pipe(Effect.orElseSucceed(() => null));
      if (staged) return staged;
    }
    const inspect = Effect.gen(function* () {
      const architecture = input.architecture ?? NodeOS.arch();
      if (name === "claude" && (input.context.platform !== "darwin" || architecture !== "arm64"))
        return "unverified" as const;
      const packageDirectory = path.join(prefix, "node_modules", input.packageName);
      const nativePackage = path.join(
        prefix,
        "node_modules",
        "@anthropic-ai/claude-code-darwin-arm64",
      );
      const entrypoint =
        name === "codex"
          ? path.join(packageDirectory, "bin/codex.js")
          : path.join(nativePackage, "claude");
      // Check every ancestor, including the home and package scopes. A symlink
      // must not turn this private-prefix classification into another owner.
      const realOwned = (value: string) =>
        Effect.gen(function* () {
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
          /[\s"'`$\\;|&<>()]/.test(node) ||
          !(yield* realOwned(node)) ||
          (yield* fs.stat(node)).type !== "File"
        )
          return "unverified" as const;
      } else {
        if (
          lines[2] !== `exec ${entrypoint} "$@"` ||
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
