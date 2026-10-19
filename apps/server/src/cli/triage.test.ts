import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseJson } from "../json.ts";
import { runInteractiveSession, triageAgentSettingsArgs } from "./triage.ts";

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
    assert.include(settings.permissions.deny, `Read(/${config.secretsDir}/**)`);
    assert.include(settings.permissions.deny, `Read(/${path.join(baseDir, "studio-fleet.json")})`);
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
