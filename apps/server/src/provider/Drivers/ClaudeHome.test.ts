import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { OPEN_MODEL_PRESET_ENV } from "@specweave-studio/shared/openModelPresets";

import { claudeHomeFromContinuationKey } from "./ClaudeTranscriptTransfer.ts";
import {
  claudeEndpointFromContinuationKey,
  claudeHomeKeyOfContinuationKey,
  claudeNotSignedInMessage,
  claudeOpenModelEndpoint,
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("keeps the plain home key for every instance without the preset marker", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve("/tmp/claude-endpoint-home");
        const plain = `claude:home:${home}`;
        const handBuilt = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" };
        const unknownMarker = { [OPEN_MODEL_PRESET_ENV]: "not-a-preset", ...handBuilt };
        for (const environment of [undefined, {}, handBuilt, unknownMarker]) {
          expect(yield* makeClaudeContinuationGroupKey({ homePath: home }, environment)).toBe(
            plain,
          );
          expect(claudeOpenModelEndpoint(environment)).toBeNull();
        }
        expect(claudeEndpointFromContinuationKey(plain)).toBeNull();
        expect(claudeHomeKeyOfContinuationKey(plain)).toBe(plain);
        expect(claudeEndpointFromContinuationKey("codex:home:/tmp/codex")).toBeNull();
      }),
    );

    it.effect("folds a preset instance's endpoint into its continuation key", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve("/tmp/claude-endpoint-home");
        const environment = {
          [OPEN_MODEL_PRESET_ENV]: "deepseek",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: "sk-test-not-a-real-key",
        };
        const key = yield* makeClaudeContinuationGroupKey({ homePath: home }, environment);

        expect(key).toBe(
          `claude:endpoint:${encodeURIComponent("https://api.deepseek.com/anthropic")}:claude:home:${home}`,
        );
        expect(key).not.toContain("sk-test");
        expect(claudeEndpointFromContinuationKey(key)).toBe("https://api.deepseek.com/anthropic");
        expect(claudeHomeKeyOfContinuationKey(key)).toBe(`claude:home:${home}`);
        // Folder moves still find the home; crossing endpoints is refused in the switch.
        expect(claudeHomeFromContinuationKey(key)).toBe("/tmp/claude-endpoint-home");
      }),
    );

    it("normalizes a preset endpoint and never drops it", () => {
      const endpoint = (preset: string, baseUrl?: string) =>
        claudeOpenModelEndpoint({
          [OPEN_MODEL_PRESET_ENV]: preset,
          ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
        });
      const deepseek = "https://api.deepseek.com/anthropic";
      expect(endpoint("deepseek", deepseek)).toBe(deepseek);
      expect(endpoint("DeepSeek", " HTTPS://API.DeepSeek.com/Anthropic/ ")).toBe(deepseek);
      expect(endpoint("deepseek", "https://user:pw@api.deepseek.com:443/anthropic?x=1#y")).toBe(
        deepseek,
      );
      expect(endpoint("ollama", "http://127.0.0.1:11500/")).toBe("http://127.0.0.1:11500");
      expect(endpoint("ollama")).toBe("http://localhost:11434");
      expect(endpoint("ollama", "")).toBe("http://localhost:11434");
      expect(endpoint("kimi", "not a url")).toBe("not a url");
      expect(endpoint("kimi")).not.toBe(endpoint("deepseek"));
    });

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it("says which other sign-ins do not count, wherever Claude is signed out", () => {
      const read = (platform: NodeJS.Platform) =>
        claudeNotSignedInMessage({
          executablePath: "/synthetic/claude",
          configDir: "/synthetic/.claude",
          customConfigDir: false,
          platform,
        });
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(read(platform)).toContain(
          "The Claude desktop app has its own sign-in, and it does not count here.",
        );
      }
      expect(read("win32")).toContain("inside WSL");
      expect(read("darwin")).not.toContain("WSL");
      expect(read("linux")).toMatch(/refresh provider status\. The Claude desktop app/);
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
