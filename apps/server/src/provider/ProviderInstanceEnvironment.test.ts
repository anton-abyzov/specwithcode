import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  isDirectAnthropicApiKeyEnvironment,
  mergeProviderInstanceEnvironment,
  mergeNativeSubscriptionEnvironment,
  hasExplicitProviderApiEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("applies Windows PATH overrides once regardless of key casing", () => {
    const base = { PATH: "C:\\Old", Path: "C:\\Other", CUSTOM: "kept" };
    for (const name of ["PATH", "Path", "pAtH"]) {
      expect(
        mergeProviderInstanceEnvironment(
          [{ name, value: "C:\\Tools", sensitive: false }],
          base,
          "win32",
        ),
      ).toEqual({ PATH: "C:\\Tools", CUSTOM: "kept" });
    }
    expect(base).toEqual({ PATH: "C:\\Old", Path: "C:\\Other", CUSTOM: "kept" });
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "Path", value: "", sensitive: false }],
        base,
        "win32",
      ),
    ).toEqual({ PATH: "", CUSTOM: "kept" });
  });

  it("reads PATH from the server at each use, so an agent installed later is found", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/dev" };
    const merged = mergeProviderInstanceEnvironment(
      [{ name: "GROK_CHANNEL", value: "stable", sensitive: false }],
      base,
      "linux",
    );
    expect(merged.PATH).toBe("/usr/bin");
    base.PATH = "/home/dev/.local/bin:/usr/bin";
    expect(merged.PATH).toBe("/home/dev/.local/bin:/usr/bin");
    // A spread, which is how a spawn reads it, takes the value of that moment.
    expect({ ...merged }.PATH).toBe("/home/dev/.local/bin:/usr/bin");
    expect(Object.keys(merged)).toContain("PATH");
  });

  it("keeps an instance's own PATH, and a PATH set on the copy later", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const own = mergeProviderInstanceEnvironment(
      [{ name: "PATH", value: "/opt/agent/bin", sensitive: false }],
      base,
      "linux",
    );
    base.PATH = "/somewhere/else";
    expect(own.PATH).toBe("/opt/agent/bin");

    const copy = mergeProviderInstanceEnvironment(
      [{ name: "GROK_CHANNEL", value: "stable", sensitive: false }],
      base,
      "linux",
    );
    copy.PATH = "/set/by/hand";
    base.PATH = "/moved/again";
    expect(copy.PATH).toBe("/set/by/hand");
  });

  it("keeps PATH live in the copy a subscription agent runs with", () => {
    // Claude and Codex run with this copy; with no instance variables it is still a copy.
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "set-by-parent" };
    const plain = mergeNativeSubscriptionEnvironment(undefined, base, "claudeAgent", "linux");
    const withVariables = mergeNativeSubscriptionEnvironment(
      [{ name: "CLAUDE_CONFIG_DIR", value: "/home/dev/.claude-work", sensitive: false }],
      base,
      "claudeAgent",
      "linux",
    );
    base.PATH = "/home/dev/.local/bin:/usr/bin";
    expect(plain.PATH).toBe("/home/dev/.local/bin:/usr/bin");
    expect(withVariables.PATH).toBe("/home/dev/.local/bin:/usr/bin");
    expect(plain.ANTHROPIC_API_KEY).toBe("");

    const own = mergeNativeSubscriptionEnvironment(
      [{ name: "PATH", value: "/opt/agent/bin", sensitive: false }],
      base,
      "codex",
      "linux",
    );
    base.PATH = "/moved";
    expect(own.PATH).toBe("/opt/agent/bin");
  });

  it("follows the server's PATH under the name Windows gave it", () => {
    const base: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    const merged = mergeProviderInstanceEnvironment(
      [{ name: "GROK_CHANNEL", value: "stable", sensitive: false }],
      base,
      "win32",
    );
    base.Path = "C:\\Users\\dev\\.local\\bin;C:\\Windows";
    expect(merged.Path).toBe("C:\\Users\\dev\\.local\\bin;C:\\Windows");
    expect(Object.keys(merged).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
  });

  it("keeps case-sensitive environment names on POSIX", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "Path", value: "/tools", sensitive: false }],
        { PATH: "/bin" },
        "linux",
      ),
    ).toEqual({ PATH: "/bin", Path: "/tools" });
  });

  it("retains inherited API configuration for generic OpenCode/Pi/ACP and terminal environments", () => {
    const base = {
      PATH: "/bin",
      OPENAI_API_KEY: "synthetic-key",
      ANTHROPIC_BASE_URL: "http://example.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
    };
    expect(mergeProviderInstanceEnvironment(undefined, base)).toEqual(base);
    expect(mergeProviderInstanceEnvironment([], base)).toEqual(base);
    expect(
      mergeProviderInstanceEnvironment([{ name: "CUSTOM", value: "x", sensitive: false }], base),
    ).toEqual({ ...base, CUSTOM: "x" });
  });
  it("neutralizes native subscription overrides even when a subprocess extends its parent environment", () => {
    const base = {
      PATH: "/bin",
      HOME: "/home/native",
      CODEX_HOME: "/home/native/.codex",
      OPENAI_API_KEY: "synthetic",
      ANTHROPIC_AUTH_TOKEN: "synthetic",
      ANTHROPIC_BASE_URL: "http://example.invalid",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    };
    const env = mergeNativeSubscriptionEnvironment(undefined, base);
    const effectiveChildEnv = { ...base, ...env }; // extendEnv:true semantics
    expect(effectiveChildEnv).toMatchObject({
      PATH: "/bin",
      HOME: "/home/native",
      CODEX_HOME: "/home/native/.codex",
      OPENAI_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
    });
    expect(base.OPENAI_API_KEY).toBe("synthetic");
    expect(mergeNativeSubscriptionEnvironment([], base)).toEqual(env);
  });
  it("retains deliberate API instances and blocks copied OAuth in subscription mode", () => {
    const api = [{ name: "ANTHROPIC_API_KEY", value: "synthetic-explicit", sensitive: true }];
    expect(hasExplicitProviderApiEnvironment(api)).toBe(true);
    expect(
      hasExplicitProviderApiEnvironment([
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "synthetic", sensitive: true },
      ]),
    ).toBe(false);
    expect(
      mergeNativeSubscriptionEnvironment(api, { ANTHROPIC_BASE_URL: "http://explicit.invalid" }),
    ).toEqual({
      ANTHROPIC_API_KEY: "synthetic-explicit",
      ANTHROPIC_BASE_URL: "http://explicit.invalid",
    });
    expect(
      mergeNativeSubscriptionEnvironment(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "synthetic", sensitive: true }],
        {},
      ),
    ).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "" });
  });
  it("bills an instance to its API key only when the key goes straight to Anthropic", () => {
    const key = [{ name: "ANTHROPIC_API_KEY", value: "synthetic-explicit", sensitive: true }];
    const launch = (environment: typeof key, base: NodeJS.ProcessEnv = {}) =>
      isDirectAnthropicApiKeyEnvironment(
        mergeNativeSubscriptionEnvironment(environment, base, "claudeAgent"),
      );
    expect(launch(key, { PATH: "/bin" })).toBe(true);
    // A subscription instance never inherits the parent's key.
    expect(launch([], { ANTHROPIC_API_KEY: "synthetic-ambient" })).toBe(false);
    expect(launch(key, { ANTHROPIC_BASE_URL: "http://router.invalid" })).toBe(false);
    expect(
      launch([...key, { name: "ANTHROPIC_AUTH_TOKEN", value: "synthetic", sensitive: true }]),
    ).toBe(false);
    expect(
      launch([...key, { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", sensitive: false }]),
    ).toBe(false);
    expect(
      launch([
        { name: "ANTHROPIC_API_KEY", value: " ", sensitive: true },
        { name: "ANTHROPIC_BASE_URL", value: "http://router.invalid", sensitive: false },
      ]),
    ).toBe(false);
  });
  it("does not treat another provider's explicit key as subscription API opt-in", () => {
    const environment = [
      { name: "ANTHROPIC_API_KEY", value: "synthetic-explicit", sensitive: true },
    ];
    expect(hasExplicitProviderApiEnvironment(environment, "codex")).toBe(false);
    expect(
      mergeNativeSubscriptionEnvironment(
        environment,
        { OPENAI_API_KEY: "synthetic-ambient" },
        "codex",
      ).OPENAI_API_KEY,
    ).toBe("");
    expect(hasExplicitProviderApiEnvironment(environment, "claudeAgent")).toBe(true);
  });
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        COPILOT_HOME: "~/.inherited-copilot",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "COPILOT_HOME", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        COPILOT_HOME: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        COPILOT_HOME: "~/.inherited-copilot",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

describe("AppImage runtime environment", () => {
  const appImageBase = () => ({
    APPIMAGE: "/home/a/SpecWithCode.AppImage",
    APPDIR: "/tmp/.mount_Spec1/",
    ARGV0: "SpecWithCode",
    OWD: "/home/a",
    PATH: "/tmp/.mount_Spec1/usr/bin:/usr/local/bin:/usr/bin",
    LD_LIBRARY_PATH: "/tmp/.mount_Spec1/usr/lib:/usr/lib",
    XDG_DATA_DIRS: "/tmp/.mount_Spec1/usr/share",
    HOME: "/home/a",
  });

  it("agent sessions get no AppImage variables or mount entries", () => {
    for (const environment of [undefined, [], [{ name: "EXTRA", value: "1", sensitive: false }]]) {
      const merged = mergeProviderInstanceEnvironment(environment, appImageBase(), "linux");
      expect(merged.APPIMAGE).toBeUndefined();
      expect(merged.APPDIR).toBeUndefined();
      expect(merged.ARGV0).toBeUndefined();
      expect(merged.OWD).toBeUndefined();
      expect(merged.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(merged.LD_LIBRARY_PATH).toBe("/usr/lib");
      expect(Object.hasOwn(merged, "XDG_DATA_DIRS")).toBe(false);
      expect(merged.HOME).toBe("/home/a");
    }
  });

  it("drops mount entries ld.so reads after a semicolon", () => {
    const merged = mergeProviderInstanceEnvironment(
      undefined,
      { ...appImageBase(), LD_LIBRARY_PATH: "/usr/lib;/tmp/.mount_Spec1/usr/lib" },
      "linux",
    );
    expect(merged.LD_LIBRARY_PATH).toBe("/usr/lib");
  });

  it("keeps an instance's own values over the scrub", () => {
    const merged = mergeProviderInstanceEnvironment(
      [
        { name: "LD_LIBRARY_PATH", value: "/tmp/.mount_Spec1/usr/lib", sensitive: false },
        { name: "PATH", value: "/opt/agent/bin", sensitive: false },
      ],
      appImageBase(),
      "linux",
    );
    expect(merged.LD_LIBRARY_PATH).toBe("/tmp/.mount_Spec1/usr/lib");
    expect(merged.PATH).toBe("/opt/agent/bin");
  });

  it("follows the server's PATH without its mount entries", () => {
    const base: NodeJS.ProcessEnv = appImageBase();
    const merged = mergeProviderInstanceEnvironment(
      [{ name: "EXTRA", value: "1", sensitive: false }],
      base,
      "linux",
    );
    base.PATH = "/tmp/.mount_Spec1/usr/bin:/home/a/.local/bin:/usr/bin";
    expect(merged.PATH).toBe("/home/a/.local/bin:/usr/bin");
    const subscription = mergeNativeSubscriptionEnvironment(undefined, base, "codex", "linux");
    expect(subscription.PATH).toBe("/home/a/.local/bin:/usr/bin");
    expect(subscription.APPIMAGE).toBeUndefined();
  });

  it("leaves an environment without AppImage untouched", () => {
    const base = { PATH: "/tmp/.mount_x/usr/bin:/usr/bin" };
    expect(mergeProviderInstanceEnvironment(undefined, base, "linux")).toBe(base);
  });
});
