import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  buildOpenModelEnvironment,
  OPEN_MODEL_PRESETS,
  OPEN_MODEL_PRESET_ENV,
  openModelPresetById,
} from "@specweave-studio/shared/openModelPresets";

import {
  isDirectAnthropicApiKeyEnvironment,
  mergeProviderInstanceEnvironment,
  mergeNativeSubscriptionEnvironment,
  hasExplicitProviderApiEnvironment,
  OPEN_MODEL_MISSING_KEY,
  withOpenModelSlots,
} from "./ProviderInstanceEnvironment.ts";
import { withInheritedSubagentModel } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

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

  it("scrubs only a Linux AppImage launch; APPDIR alone is someone else's variable", () => {
    const appDirOnly = { APPDIR: "/opt/tool", PATH: "/opt/tool/bin:/usr/bin" };
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const merged = mergeProviderInstanceEnvironment(undefined, appDirOnly, platform);
      expect(merged.APPDIR).toBe("/opt/tool");
      expect(merged.PATH).toBe("/opt/tool/bin:/usr/bin");
    }
    const onMac = mergeProviderInstanceEnvironment(undefined, appImageBase(), "darwin");
    expect(onMac.APPIMAGE).toBe("/home/a/SpecWithCode.AppImage");
    expect(onMac.PATH).toBe("/tmp/.mount_Spec1/usr/bin:/usr/local/bin:/usr/bin");
  });
});

describe("thread credentials in the server environment", () => {
  const leaked = {
    PATH: "/usr/bin",
    HOME: "/home/a",
    STUDIO_ACP_MCP_AUTHORIZATION: "Bearer other-thread",
    studio_acp_mcp_endpoint: "http://127.0.0.1:1/mcp",
    SPECWEAVE_STUDIO_THREAD_ID: "thread-other",
  };

  it("agent environments never inherit another thread's MCP credentials or identity", () => {
    for (const environment of [undefined, [{ name: "EXTRA", value: "1", sensitive: false }]]) {
      const merged = mergeProviderInstanceEnvironment(environment, leaked, "linux");
      expect(merged.STUDIO_ACP_MCP_AUTHORIZATION).toBeUndefined();
      expect(merged.studio_acp_mcp_endpoint).toBeUndefined();
      expect(merged.SPECWEAVE_STUDIO_THREAD_ID).toBeUndefined();
      expect(merged.HOME).toBe("/home/a");
    }
  });

  it("keeps credentials an instance sets for itself", () => {
    const merged = mergeProviderInstanceEnvironment(
      [{ name: "STUDIO_ACP_MCP_AUTHORIZATION", value: "Bearer own", sensitive: true }],
      leaked,
      "linux",
    );
    expect(merged.STUDIO_ACP_MCP_AUTHORIZATION).toBe("Bearer own");
    expect(merged.SPECWEAVE_STUDIO_THREAD_ID).toBeUndefined();
  });
});

describe("open-model preset launches", () => {
  const host = {
    PATH: "/bin",
    HOME: "/home/a",
    ANTHROPIC_API_KEY: "sk-ant-test-host-key",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-test-host-bearer",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test-host",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
  };
  const preset = (id: string) => {
    const found = openModelPresetById(id);
    if (!found) throw new Error(`no preset ${id}`);
    return found;
  };
  const launch = (
    environment: Parameters<typeof mergeNativeSubscriptionEnvironment>[0],
  ): NodeJS.ProcessEnv => {
    const env = mergeNativeSubscriptionEnvironment(environment, host, "claudeAgent", "linux");
    return { ...host, ...env }; // extendEnv:true semantics
  };

  it("sends only the preset's token, never a host credential, with the subprocess scrub on", () => {
    for (const each of OPEN_MODEL_PRESETS) {
      const environment = buildOpenModelEnvironment({
        preset: each,
        key: "sk-test-preset-key",
        model: "test-model",
      });
      const env = launch(environment);
      expect(env.ANTHROPIC_BASE_URL).toBe(each.baseUrl);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(
        each.kind === "key" ? "sk-test-preset-key" : each.localToken,
      );
      expect(env).toMatchObject({
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        CLAUDE_CODE_USE_BEDROCK: "",
        CLAUDE_CODE_USE_VERTEX: "",
        CLAUDE_CODE_USE_FOUNDRY: "",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        PATH: "/bin",
        HOME: "/home/a",
      });
      expect(JSON.stringify(env)).not.toContain("test-host");
      // Turns go to the vendor, so they never count as Anthropic API-key billing.
      expect(isDirectAnthropicApiKeyEnvironment(env)).toBe(false);
    }
  });

  it("blanks host credentials the marker instance's own rows leave out, and forces the scrub", () => {
    const env = launch([
      { name: OPEN_MODEL_PRESET_ENV, value: "deepseek", sensitive: false },
      { name: "ANTHROPIC_BASE_URL", value: preset("deepseek").baseUrl, sensitive: false },
      { name: "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", value: "0", sensitive: false },
    ]);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: OPEN_MODEL_MISSING_KEY,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
  });

  it("keeps a credential the marker instance sets for itself", () => {
    const env = launch([
      { name: OPEN_MODEL_PRESET_ENV, value: "openrouter", sensitive: false },
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      { name: "ANTHROPIC_API_KEY", value: "sk-or-test-own", sensitive: true },
    ]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-or-test-own");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  it("leaves a hand-built base-URL instance exactly as before (D-05)", () => {
    const handBuilt = [
      { name: "ANTHROPIC_BASE_URL", value: "https://api.deepseek.com/anthropic", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-test-hand-built", sensitive: true },
    ];
    const env = mergeNativeSubscriptionEnvironment(handBuilt, host, "claudeAgent", "linux");
    expect({ ...env }).toEqual({
      ...host,
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-test-hand-built",
    });
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    // An unknown marker value is no preset either.
    const unknown = mergeNativeSubscriptionEnvironment(
      [...handBuilt, { name: OPEN_MODEL_PRESET_ENV, value: "mistral", sensitive: false }],
      host,
      "claudeAgent",
      "linux",
    );
    expect(unknown.ANTHROPIC_API_KEY).toBe("sk-ant-test-host-key");
    expect(unknown.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
  });

  it("sends a placeholder bearer, never the claude.ai login, when a keyed route's key is missing", () => {
    // The secret store had no entry, so the sensitive row hydrated to "".
    const environment = buildOpenModelEnvironment({ preset: preset("kimi"), key: "sk-test" }).map(
      (row) => (row.name === "ANTHROPIC_AUTH_TOKEN" ? { ...row, value: "" } : row),
    );
    const env = launch(environment);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(OPEN_MODEL_MISSING_KEY);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  it("drops a marker inherited from the host, so only the instance's own row makes a route", () => {
    const hostWithMarker = { ...host, [OPEN_MODEL_PRESET_ENV]: "deepseek" };
    const subscription = mergeNativeSubscriptionEnvironment(
      undefined,
      hostWithMarker,
      "claudeAgent",
      "linux",
    );
    expect(subscription[OPEN_MODEL_PRESET_ENV]).toBeUndefined();
    const handBuilt = mergeNativeSubscriptionEnvironment(
      [{ name: "ANTHROPIC_BASE_URL", value: "https://example.invalid", sensitive: false }],
      hostWithMarker,
      "claudeAgent",
      "linux",
    );
    expect(handBuilt[OPEN_MODEL_PRESET_ENV]).toBeUndefined();
    expect(handBuilt.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    const route = mergeNativeSubscriptionEnvironment(
      buildOpenModelEnvironment({ preset: preset("ollama") }),
      hostWithMarker,
      "claudeAgent",
      "linux",
    );
    expect(route[OPEN_MODEL_PRESET_ENV]).toBe("ollama");
  });

  it("does not harden Codex launches that happen to carry the marker", () => {
    const env = mergeNativeSubscriptionEnvironment(
      [
        { name: OPEN_MODEL_PRESET_ENV, value: "deepseek", sensitive: false },
        { name: "OPENAI_BASE_URL", value: "https://example.invalid/v1", sensitive: false },
      ],
      { PATH: "/bin", CODEX_HOME: "/home/a/.codex" },
      "codex",
      "linux",
    );
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps PATH live on a hardened launch", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin" };
    const env = mergeNativeSubscriptionEnvironment(
      buildOpenModelEnvironment({ preset: preset("ollama") }),
      base,
      "claudeAgent",
      "linux",
    );
    base.PATH = "/bin:/new";
    expect(env.PATH).toBe("/bin:/new");
  });
});

describe("local preset model slots at launch", () => {
  const host = {
    PATH: "/bin",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-host",
    CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-host",
  };
  const ollama = openModelPresetById("ollama");

  it("never passes a host Claude model slot to a local runtime", () => {
    if (!ollama) throw new Error("no ollama preset");
    const env = mergeNativeSubscriptionEnvironment(
      buildOpenModelEnvironment({ preset: ollama }),
      host,
      "claudeAgent",
      "linux",
    );
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("");
    // The adapter's per-turn step then runs every slot on the launching model.
    expect(withInheritedSubagentModel(env, "qwen3-coder:30b")).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3-coder:30b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder:30b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-coder:30b",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3-coder:30b",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
  });

  it("keeps a model the local instance's rows name", () => {
    if (!ollama) throw new Error("no ollama preset");
    const env = mergeNativeSubscriptionEnvironment(
      buildOpenModelEnvironment({ preset: ollama, model: "llama4" }),
      host,
      "claudeAgent",
      "linux",
    );
    expect(withInheritedSubagentModel(env, "qwen3-coder:30b")).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "llama4",
      CLAUDE_CODE_SUBAGENT_MODEL: "llama4",
    });
  });

  it("leaves a non-preset launch's slots to the existing subagent rule", () => {
    const env = mergeNativeSubscriptionEnvironment(
      [{ name: "ANTHROPIC_BASE_URL", value: "http://localhost:11434", sensitive: false }],
      { PATH: "/bin" },
      "claudeAgent",
      "linux",
    );
    expect({ ...withInheritedSubagentModel(env, "claude-opus-5-5") }).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
  });
});

describe("withOpenModelSlots", () => {
  const local = { PATH: "/bin", [OPEN_MODEL_PRESET_ENV]: "ollama" };

  it("points a local preset's background and subagent slots at the launching model", () => {
    expect(withOpenModelSlots(local, "qwen3-coder:30b")).toEqual({
      ...local,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3-coder:30b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder:30b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-coder:30b",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3-coder:30b",
    });
    expect(local).toEqual({ PATH: "/bin", [OPEN_MODEL_PRESET_ENV]: "ollama" });
  });

  it("keeps slots the instance set", () => {
    const set = { ...local, ANTHROPIC_DEFAULT_HAIKU_MODEL: "small-local" };
    expect(withOpenModelSlots(set, "big-local")).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "small-local",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "big-local",
    });
    const full = {
      ...local,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "a",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "a",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "a",
      CLAUDE_CODE_SUBAGENT_MODEL: "a",
    };
    expect(withOpenModelSlots(full, "b")).toBe(full);
  });

  it("returns keyed presets, hand-built and plain launches as they are", () => {
    for (const environment of [
      { PATH: "/bin" },
      { PATH: "/bin", ANTHROPIC_BASE_URL: "http://localhost:11434" },
      { PATH: "/bin", [OPEN_MODEL_PRESET_ENV]: "deepseek" },
    ]) {
      expect(withOpenModelSlots(environment, "claude-opus-5-5")).toBe(environment);
    }
  });
});
