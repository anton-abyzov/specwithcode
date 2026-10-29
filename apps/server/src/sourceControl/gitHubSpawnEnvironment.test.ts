// @effect-diagnostics nodeBuiltinImport:off - runs real git against a throwaway config.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { REDACTED_SECRET_MARKER } from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import { runGit } from "../fleet/folderTransfer/git.ts";
import { scrubDetail } from "../fleet/MachineReadiness.ts";
import { scrubLogSecrets } from "../pullRequest/gitHubCheckFailureLog.ts";
import * as ProcessRunner from "../processRunner.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { serverEnvironment } from "../provider/opencode2/OpenCode2Server.ts";
import { withSpecweaveAgentEnvironment } from "../provider/RuntimeInstructions.ts";
import {
  GITHUB_HELPER_KEY,
  GITHUB_HELPER_VALUE,
  gitHubSpawnEnvironment,
  setGitHubSpawnToken,
} from "./gitHubSpawnEnvironment.ts";
import { chosenSavedGitHubToken } from "./gitHubSpawnEnvironmentSync.ts";

const TOKEN = "gho_spawnTestTokenNeverLogged0123";
const github = (patch: Record<string, unknown> = {}) =>
  ({
    hosts: {},
    tokens: {},
    copiedTokens: {},
    copyHostSignIn: true,
    confirmCopySignIn: true,
    ...patch,
  }) as never;

afterEach(() => setGitHubSpawnToken(null));

describe("gitHubSpawnEnvironment", () => {
  it("adds GH_TOKEN, GITHUB_TOKEN and a github.com-only helper after existing git config", () => {
    const env = gitHubSpawnEnvironment(
      {
        PATH: "/usr/bin",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "false",
      },
      TOKEN,
    );
    expect(env).toMatchObject({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_KEY_1: GITHUB_HELPER_KEY,
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: GITHUB_HELPER_KEY,
      GIT_CONFIG_VALUE_2: GITHUB_HELPER_VALUE,
    });
    // The helper reads the token from the environment; no config value holds it.
    expect(GITHUB_HELPER_VALUE).not.toContain(TOKEN);
  });

  it("adds nothing twice", () => {
    const once = gitHubSpawnEnvironment({ PATH: "/usr/bin" }, TOKEN);
    expect(gitHubSpawnEnvironment(once, TOKEN)).toEqual(once);
  });

  it("leaves GitHub access the user set alone: a token adds nothing, a helper adds no helper", () => {
    for (const own of [{ GH_TOKEN: "users-own" }, { GITHUB_TOKEN: "users-own" }]) {
      const env = { PATH: "/usr/bin", ...own };
      expect(gitHubSpawnEnvironment(env, TOKEN)).toBe(env);
    }
    const helper = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "osxkeychain",
    };
    const env = gitHubSpawnEnvironment(helper, TOKEN);
    expect(env).toEqual({ ...helper, GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN });
    expect(
      gitHubSpawnEnvironment({ ...helper, GIT_CONFIG_KEY_0: "credential.helper" }, TOKEN),
    ).not.toHaveProperty("GIT_CONFIG_KEY_1");
  });

  it("adds nothing without a chosen saved token", () => {
    const env = { PATH: "/usr/bin" };
    expect(gitHubSpawnEnvironment(env, null)).toBe(env);
  });
});

describe("chosenSavedGitHubToken", () => {
  it("is the saved or copied token, and nothing when gh's own login is the chosen one", () => {
    expect(chosenSavedGitHubToken(github({ tokens: { "github.com": ` ${TOKEN} ` } }))).toBe(TOKEN);
    expect(chosenSavedGitHubToken(github())).toBeNull();
    // An unreadable secret leaves the redaction marker; it is never handed out.
    expect(
      chosenSavedGitHubToken(github({ tokens: { "github.com": REDACTED_SECRET_MARKER } })),
    ).toBe("unreadable");
    expect(
      chosenSavedGitHubToken(
        github({ tokens: { "github.com": TOKEN }, hosts: { "github.com": { enabled: false } } }),
      ),
    ).toBeNull();
  });
});

describe("spawned environments", () => {
  it("resolves the token per spawn: a copy after the adapter exists arrives, a removal leaves", () => {
    // The adapter's base is built once, before any copy, and never holds GitHub variables.
    const base = mergeProviderInstanceEnvironment(undefined, { PATH: "/usr/bin" }, "linux");
    expect(base).not.toHaveProperty("GH_TOKEN");
    const identity = { threadId: "thread-1", tool: "claude" } as never;
    expect(withSpecweaveAgentEnvironment(base, identity)).not.toHaveProperty("GH_TOKEN");

    setGitHubSpawnToken(TOKEN);
    const copied = withSpecweaveAgentEnvironment(base, identity);
    expect(copied.GH_TOKEN).toBe(TOKEN);
    expect(copied.GIT_CONFIG_VALUE_1).toBe(GITHUB_HELPER_VALUE);

    // A GH_TOKEN set in the provider instance's own environment wins over the copy.
    const instance = mergeProviderInstanceEnvironment(
      [{ name: "GH_TOKEN", value: "instance-own" }] as never,
      { PATH: "/usr/bin" },
      "linux",
    );
    const own = withSpecweaveAgentEnvironment(instance, identity);
    expect(own.GH_TOKEN).toBe("instance-own");
    expect(own).not.toHaveProperty("GITHUB_TOKEN");
    expect(own).not.toHaveProperty("GIT_CONFIG_COUNT");

    // The token the server itself started with does not count as the user's choice.
    const serverOwn = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "server-own";
    try {
      const inheritedEnv = withSpecweaveAgentEnvironment(
        { ...base, GH_TOKEN: "server-own" },
        identity,
      );
      expect(inheritedEnv.GH_TOKEN).toBe(TOKEN);
      expect(inheritedEnv.GITHUB_TOKEN).toBe(TOKEN);
      expect(inheritedEnv.GIT_CONFIG_VALUE_1).toBe(GITHUB_HELPER_VALUE);
    } finally {
      if (serverOwn === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = serverOwn;
    }

    setGitHubSpawnToken(null);
    const removed = withSpecweaveAgentEnvironment(base, identity);
    expect(removed).not.toHaveProperty("GH_TOKEN");
    expect(removed).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(base).not.toHaveProperty("GH_TOKEN");
  });

  it("hands Codex tool commands the variables through shell_environment_policy.set", () => {
    expect(codexThreadRuntimeParams({ threadId: null, environment: {} }).config).not.toHaveProperty(
      "shell_environment_policy.set.GH_TOKEN",
    );
    setGitHubSpawnToken(TOKEN);
    const config = codexThreadRuntimeParams({
      threadId: null,
      environment: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "false",
      },
    }).config;
    expect(config).toMatchObject({
      "shell_environment_policy.set.GH_TOKEN": TOKEN,
      "shell_environment_policy.set.GITHUB_TOKEN": TOKEN,
      "shell_environment_policy.set.GIT_CONFIG_COUNT": "3",
      "shell_environment_policy.set.GIT_CONFIG_KEY_0": "core.fsmonitor",
      "shell_environment_policy.set.GIT_CONFIG_KEY_2": GITHUB_HELPER_KEY,
      "shell_environment_policy.set.GIT_CONFIG_VALUE_2": GITHUB_HELPER_VALUE,
    });
    // The instance's own token reaches tool commands through inheritance; nothing is set over it.
    expect(
      codexThreadRuntimeParams({ threadId: null, environment: { GH_TOKEN: "instance-own" } })
        .config,
    ).not.toHaveProperty("shell_environment_policy.set.GH_TOKEN");
  });

  it("gives the shared OpenCode 2 server the access current when it starts", () => {
    setGitHubSpawnToken(TOKEN);
    expect(serverEnvironment({ PATH: "/usr/bin" }, Redacted.make("pw")).GH_TOKEN).toBe(TOKEN);
  });

  const spawnedEnv = (command: string, host: Record<string, string> = { PATH: "/usr/bin" }) => {
    let seen: Record<string, string | undefined> | undefined;
    const spawner = ChildProcessSpawner.make((spawned) =>
      Effect.sync(() => {
        seen = (spawned as unknown as { options: { env?: Record<string, string> } }).options.env;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return Effect.service(ProcessRunner.ProcessRunner).pipe(
      Effect.flatMap((runner) => runner.run({ command, args: ["status"] })),
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, host),
      Effect.map(() => seen),
    );
  };

  it.effect("gives SpecWithCode's git the token unless the user set their own", () =>
    Effect.gen(function* () {
      setGitHubSpawnToken(TOKEN);
      const git = yield* spawnedEnv("git");
      expect(git).toMatchObject({
        GH_TOKEN: TOKEN,
        GITHUB_TOKEN: TOKEN,
        GIT_CONFIG_COUNT: "2",
      });
      const own = yield* spawnedEnv("git", { PATH: "/usr/bin", GITHUB_TOKEN: "users-own" });
      expect(own).toMatchObject({ GITHUB_TOKEN: "users-own" });
      expect(own).not.toHaveProperty("GH_TOKEN");
      expect(own).not.toHaveProperty("GIT_CONFIG_COUNT");
      // gh is given the token per call, so its own login checks stay untouched.
      expect(yield* spawnedEnv("gh")).toBeUndefined();
      setGitHubSpawnToken(null);
      expect(yield* spawnedEnv("git")).toBeUndefined();
    }),
  );

  it("lets git answer github.com with the token and other hosts with their own helpers", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-gh-spawn-"));
    try {
      const global = NodePath.join(home, "gitconfig");
      NodeFS.writeFileSync(
        global,
        '[credential]\n\thelper = "!f() { test \\"$1\\" = get && echo username=stale && echo password=stale-keychain; }; f"\n',
      );
      const env = gitHubSpawnEnvironment(
        {
          PATH: process.env.PATH,
          HOME: home,
          GIT_CONFIG_GLOBAL: global,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        TOKEN,
      );
      const fill = (host: string) =>
        NodeChildProcess.execFileSync("git", ["credential", "fill"], {
          env,
          input: `protocol=https\nhost=${host}\n\n`,
        }).toString();
      expect(fill("github.com")).toContain(`username=x-access-token\npassword=${TOKEN}`);
      expect(fill("gitlab.com")).toContain("password=stale-keychain");
      // Nothing was written to the global config.
      expect(NodeFS.readFileSync(global, "utf8")).not.toContain("x-access-token");

      // The folder-transfer git gets the same helper.
      setGitHubSpawnToken(TOKEN);
      const helpers = await runGit(home, ["config", "--get-all", GITHUB_HELPER_KEY], {
        env: { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" },
      });
      expect(helpers.stdout.split("\n").filter(Boolean)).toEqual([GITHUB_HELPER_VALUE]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("redaction", () => {
  it("scrubs token variables from log and detail text", () => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) {
      expect(scrubLogSecrets(`${name}=opaque-value-123456`)).not.toContain("opaque-value-123456");
      expect(scrubDetail(`${name}=opaque-value-123456`)).not.toContain("opaque-value-123456");
    }
    expect(scrubLogSecrets(`password=${TOKEN}`)).not.toContain(TOKEN);
  });
});
