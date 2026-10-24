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
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
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
