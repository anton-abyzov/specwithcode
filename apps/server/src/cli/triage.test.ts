// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { parseJson } from "../json.ts";
import { claudeRulePath } from "../provider/AgentProtectedPaths.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  checkPublicReleaseTag,
  describeServerProcess,
  describeSourceToClone,
  runInteractiveSession,
  triageAgentSettingsArgs,
} from "./triage.ts";

it.effect("starts triage Claude with the credential-store deny settings, Codex without", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-triage-" });
    const stateDir = path.join(baseDir, "userdata");
    const config = { baseDir, stateDir, secretsDir: path.join(stateDir, "secrets") };
    const scratchDir = path.join(stateDir, "triage", "now");
    yield* fileSystem.makeDirectory(scratchDir, { recursive: true });

    const args = yield* triageAgentSettingsArgs({
      agentId: "claude",
      scratchDir,
      config,
      homeDir: baseDir,
    });
    assert.strictEqual(args[0], "--settings");
    const settings = parseJson(yield* fileSystem.readFileString(args[1]!)) as {
      permissions: { deny: ReadonlyArray<string> };
      sandbox: { filesystem: { denyRead: ReadonlyArray<string> } };
    };
    // Claude rules spell paths POSIX-style, //c/Users/... on Windows.
    assert.include(settings.permissions.deny, `Read(${claudeRulePath(config.secretsDir)}/**)`);
    assert.include(
      settings.permissions.deny,
      `Read(${claudeRulePath(path.join(baseDir, "studio-fleet.json"))})`,
    );
    assert.include(settings.sandbox.filesystem.denyRead, config.secretsDir);

    assert.deepEqual(
      yield* triageAgentSettingsArgs({ agentId: "codex", scratchDir, config, homeDir: baseDir }),
      [],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("starts the triage agent with the headless browser environment", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        PWDEBUG: process.env.PWDEBUG,
        PLAYWRIGHT_HTML_OPEN: process.env.PLAYWRIGHT_HTML_OPEN,
      };
      // An inspector setting in the user's shell must not reach the agent.
      process.env.PWDEBUG = "1";
      process.env.PLAYWRIGHT_HTML_OPEN = "always";
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        // The child exits 0 only when it sees the headless values and PATH.
        const exitCode = yield* runInteractiveSession({
          command: process.execPath,
          args: [
            "-e",
            'process.exit(process.env.PWDEBUG === "0" && process.env.PLAYWRIGHT_HTML_OPEN === "never" && typeof process.env.PATH === "string" ? 0 : 3)',
          ],
          shell: false,
          cwd: process.cwd(),
        });
        assert.equal(exitCode, 0);
      }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  ),
);

it.effect("reports the version the running server recorded, not the CLI's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "studio-triage-" }),
      "server-runtime.json",
    );
    // The test process stands in for the server, so its pid is alive.
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({ path: statePath, state });

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version ${packageJson.version})`,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("says the server version is unknown when the state file has none", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "studio-triage-" }),
      "server-runtime.json",
    );
    // A server from before versions were recorded.
    yield* fs.writeFileString(
      statePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-09-24T00:08:56.777Z",
      }),
    );

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version not recorded)`,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("checks the release tag against the public repo and tolerates no network", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A local repo stands in for anton-abyzov/specwithcode, so the test runs offline.
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "studio-triage-repo-" });
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
        stdio: "ignore",
      });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "snapshot");
    git("tag", "-a", "v1.0.106", "-m", "SpecWithCode 1.0.106");
    // A tag whose name only extends the one asked for must not count.
    git("tag", "v1.0.1060");

    assert.equal(yield* checkPublicReleaseTag({ tag: "v1.0.106", repoUrl: repo }), "published");
    assert.equal(yield* checkPublicReleaseTag({ tag: "v1.0.107", repoUrl: repo }), "missing");
    assert.equal(
      yield* checkPublicReleaseTag({ tag: "v1.0.106", repoUrl: path.join(repo, "nowhere") }),
      "unknown",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("tells the agent to clone main, and why, when the tag is not public", () => {
  const missing = describeSourceToClone({
    version: "1.0.106-dev",
    versionSource: "server",
    status: "missing",
  });
  assert.match(
    missing,
    /^main\. Tag v1\.0\.106-dev \(the local server's version\) is not published/,
  );
  assert.include(missing, "private development repo, which users cannot clone");

  assert.equal(
    describeSourceToClone({ version: "1.0.106", versionSource: "cli", status: "published" }),
    "tag v1.0.106 (this CLI's version; published on anton-abyzov/specwithcode)",
  );
  assert.include(
    describeSourceToClone({ version: "1.0.106", versionSource: "server", status: "unknown" }),
    "if the tag clone fails, clone main",
  );
});
