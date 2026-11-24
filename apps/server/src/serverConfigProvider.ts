/**
 * The server's one ConfigProvider. Effect's default (`ConfigProvider.fromEnv()`)
 * copies `process.env` into a plain object the first time it is read, which
 * loses two things the server depends on:
 *
 * - On Windows, variable names are case-insensitive and PATH is usually
 *   spelled `Path`. In the copy, `Config.String("PATH")` then finds nothing,
 *   so every PATH folder is skipped (1452: SpecWeave setup said Node.js was
 *   missing on a machine that had it).
 * - The server grows its own PATH while it runs (`fixPath`, the managed tool
 *   folder, `refreshServerPath`). A copy taken once never sees those changes.
 *
 * This provider reads the environment record itself, so every lookup sees it
 * as it is now, and on Windows looks names up without regard to case.
 *
 * @module serverConfigProvider
 */
import * as ConfigProvider from "effect/ConfigProvider";

/** The key in `env` that `name` means on Windows, ignoring case; the exact one wins. */
function windowsKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (Object.hasOwn(env, name)) return name;
  const wanted = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === wanted);
}

/** A read-only view of `env` whose name lookups ignore case, as Windows does. */
export function caseInsensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      const key = windowsKey(target, property);
      return key === undefined ? undefined : target[key];
    },
    has(target, property) {
      if (typeof property !== "string") return Reflect.has(target, property);
      return windowsKey(target, property) !== undefined;
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property !== "string") return Reflect.getOwnPropertyDescriptor(target, property);
      const key = windowsKey(target, property);
      if (key === undefined) return undefined;
      if (key === property) return Reflect.getOwnPropertyDescriptor(target, key);
      // A name the target holds under another case: configurable, as a proxy must report it.
      return { value: target[key], writable: false, enumerable: false, configurable: true };
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
  });
}

/** Reads `env` live; on Windows, names in any case. */
export function liveEnvConfigProvider(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnvRecord(platform === "win32" ? caseInsensitiveEnv(env) : env);
}

/** The provider for this process: `process.env`, read live. */
export const layerServerConfigProvider = ConfigProvider.layer(
  // oxlint-disable-next-line studio/no-global-process-runtime -- the process's own environment and platform, once at start.
  liveEnvConfigProvider(process.env, process.platform),
);
