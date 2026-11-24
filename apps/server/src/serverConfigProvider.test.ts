import { describe, expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { caseInsensitiveEnv, liveEnvConfigProvider } from "./serverConfigProvider.ts";

const read = (provider: ConfigProvider.ConfigProvider, name: string) =>
  Effect.gen(function* () {
    return Option.getOrUndefined(yield* Config.String(name).pipe(Config.option));
  }).pipe(Effect.provide(ConfigProvider.layer(provider)));

describe("serverConfigProvider (1452)", () => {
  it.effect("Effect's own env provider misses Windows' Path, which is the bug", () =>
    Effect.gen(function* () {
      const env = { Path: "C:\\Program Files\\nodejs" };
      expect(yield* read(ConfigProvider.fromEnv({ env }), "PATH")).toBeUndefined();
    }),
  );

  it.effect("on Windows reads PATH, PATHEXT and APPDATA in any case (AC-01)", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        Path: "C:\\Program Files\\nodejs;C:\\Windows",
        PathExt: ".COM;.EXE;.CMD",
        AppData: "C:\\Users\\a\\AppData\\Roaming",
      };
      const provider = liveEnvConfigProvider(env, "win32");
      expect(yield* read(provider, "PATH")).toBe("C:\\Program Files\\nodejs;C:\\Windows");
      expect(yield* read(provider, "PATHEXT")).toBe(".COM;.EXE;.CMD");
      expect(yield* read(provider, "APPDATA")).toBe("C:\\Users\\a\\AppData\\Roaming");
      expect(yield* read(provider, "MISSING")).toBeUndefined();
    }),
  );

  it.effect("elsewhere names keep their case", () =>
    Effect.gen(function* () {
      const provider = liveEnvConfigProvider({ Path: "/usr/bin" }, "linux");
      expect(yield* read(provider, "PATH")).toBeUndefined();
      expect(yield* read(provider, "Path")).toBe("/usr/bin");
    }),
  );

  it.effect("reads the environment live: later changes and new names are seen (AC-02)", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "darwin"] as const) {
        const env: NodeJS.ProcessEnv = { PATH: "/a" };
        const provider = liveEnvConfigProvider(env, platform);
        expect(yield* read(provider, "PATH")).toBe("/a");
        env.PATH = "/a;/b";
        env.NEW_NAME = "later";
        expect(yield* read(provider, "PATH")).toBe("/a;/b");
        expect(yield* read(provider, "NEW_NAME")).toBe("later");
      }
    }),
  );

  it("the Windows view is read-only and lists the real names", () => {
    const env: NodeJS.ProcessEnv = { Path: "x" };
    const view = caseInsensitiveEnv(env);
    expect(view.PATH).toBe("x");
    expect("path" in view).toBe(true);
    expect(Object.keys(view)).toEqual(["Path"]);
    expect(Reflect.set(view, "PATH", "y")).toBe(false);
    expect(env).toEqual({ Path: "x" });
  });
});
