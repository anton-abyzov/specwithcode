import { describe, expect, it } from "vite-plus/test";

import { makeUpdateTokenResolver, readEnvironmentUpdateToken } from "./updateToken.ts";

describe("updateToken", () => {
  it("prefers the Studio variable, then the gh and GitHub ones", () => {
    expect(readEnvironmentUpdateToken({ GH_TOKEN: "b", STUDIO_UPDATE_TOKEN: "a" })).toBe("a");
    expect(readEnvironmentUpdateToken({ GITHUB_TOKEN: "c", GH_TOKEN: " b " })).toBe("b");
    expect(readEnvironmentUpdateToken({ GH_TOKEN: "  " })).toBeNull();
  });

  it("uses an environment token without asking gh", async () => {
    const asked: string[] = [];
    const resolver = makeUpdateTokenResolver({
      env: { GH_TOKEN: "from-env" },
      runGh: async (command) => {
        asked.push(command);
        return "from-gh";
      },
    });
    expect(await resolver.resolve()).toBe("from-env");
    expect(asked).toEqual([]);
  });

  it("tries each gh location and caches the answer for a while", async () => {
    let clock = 0;
    const asked: string[] = [];
    const resolver = makeUpdateTokenResolver({
      env: {},
      now: () => clock,
      runGh: async (command) => {
        asked.push(command);
        return command === "/usr/local/bin/gh" ? "gho_token" : null;
      },
    });
    expect(await resolver.resolve()).toBe("gho_token");
    expect(asked).toEqual(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);

    clock = 60_000;
    expect(await resolver.resolve()).toBe("gho_token");
    expect(asked).toHaveLength(2);

    resolver.invalidate();
    expect(await resolver.resolve()).toBe("gho_token");
    expect(asked).toHaveLength(4);

    clock = 60_000 + 11 * 60_000;
    await resolver.resolve();
    expect(asked).toHaveLength(6);
  });

  it("answers null when gh is missing or signed out", async () => {
    const resolver = makeUpdateTokenResolver({ env: {}, runGh: async () => null });
    expect(await resolver.resolve()).toBeNull();
  });
});
