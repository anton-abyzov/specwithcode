// @effect-diagnostics nodeBuiltinImport:off - fake CLIs are written into a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import {
  discoveryEnvironment,
  parseOpenCodeAuthList,
  probeGrok,
  probeOpenCode,
  runProviderDiscovery,
} from "./providerDiscovery.ts";

const fakeCliDirectory = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "discovery-"));

/** A fake CLI answering `--version` and one status command with `statusOutput`. */
const fakeCli = (
  name: string,
  statusArgs: ReadonlyArray<string>,
  statusOutput: string,
  version = `${name} 1.0.0`,
) =>
  writeFakeCli({
    directory: fakeCliDirectory(),
    name,
    source: `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(statusArgs))}) {
  process.stdout.write(${JSON.stringify(statusOutput)});
  process.exit(0);
}
process.exit(2);
`,
  });

const GROK_LOGGED_IN =
  "You are logged in with grok.com.\n\nAvailable models:\n  * grok-4 (default)\n";
const GROK_LOGGED_OUT = "You are not logged in. Run `grok login`.\n";
const OPENCODE_ONE_CREDENTIAL = [
  "\u001b[0m",
  "┌  Credentials \u001b[90m~/.local/share/opencode/auth.json",
  "│",
  "●  OpenRouter \u001b[90mapi",
  "│",
  "└  1 credentials",
  "",
].join("\n");
const OPENCODE_NONE = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
// OpenCode 2 prints one row per integration.
const OPENCODE_TWO_STORED = "OpenRouter  API key                     stored\n";
const OPENCODE_TWO_NONE = "No authenticated integrations\n";

const cleanEnvironment = () =>
  discoveryEnvironment({ PATH: process.env.PATH }, HostProcessPlatform.defaultValue());

describe("parseOpenCodeAuthList", () => {
  it("counts stored credentials and provider keys in the environment", () => {
    expect(parseOpenCodeAuthList(OPENCODE_ONE_CREDENTIAL)).toBe(true);
    expect(
      parseOpenCodeAuthList(
        "└  0 credentials\n\n┌  Environment\n│\n●  Google \u001b[90mGEMINI_API_KEY\n│\n└  1 environment variable\n",
      ),
    ).toBe(true);
    expect(parseOpenCodeAuthList(OPENCODE_NONE)).toBe(false);
  });

  it("ignores environment variables that are not provider keys", () => {
    const environmentOnly = (variables: ReadonlyArray<string>) =>
      [
        "└  0 credentials",
        "",
        "┌  Environment",
        "│",
        ...variables.map((name) => `●  Some Provider \u001b[90m${name}`),
        "│",
        `└  ${variables.length} environment variables`,
      ].join("\n");
    expect(parseOpenCodeAuthList(environmentOnly(["AWS_REGION"]))).toBe(false);
    expect(parseOpenCodeAuthList(environmentOnly(["GITHUB_TOKEN"]))).toBe(false);
    expect(parseOpenCodeAuthList(environmentOnly(["AWS_REGION", "GEMINI_API_KEY"]))).toBe(true);
  });

  it("reads the OpenCode 2 integration rows", () => {
    expect(parseOpenCodeAuthList(OPENCODE_TWO_STORED)).toBe(true);
    expect(parseOpenCodeAuthList(OPENCODE_TWO_NONE)).toBe(false);
    expect(parseOpenCodeAuthList("OpenAI      OPENAI_API_KEY              environment\n")).toBe(
      true,
    );
    expect(parseOpenCodeAuthList("GitHub Copilot  GITHUB_TOKEN                environment\n")).toBe(
      false,
    );
    expect(
      parseOpenCodeAuthList(
        "GitHub Copilot  GITHUB_TOKEN                environment\nOpenRouter      API key                     stored\n",
      ),
    ).toBe(true);
  });

  it("returns unknown for output it does not recognise", () => {
    expect(parseOpenCodeAuthList("Usage: opencode auth list\n")).toBeNull();
  });
});

describe("discoveryEnvironment", () => {
  it("keeps status commands from prompting or opening a browser", () => {
    expect(discoveryEnvironment({ HOME: "/h" }, "darwin")).toEqual({
      HOME: "/h",
      CI: "1",
      NO_COLOR: "1",
      BROWSER: "/usr/bin/false",
    });
    expect(discoveryEnvironment({}, "win32").BROWSER).toBeUndefined();
  });
});

// Live clock, so the probe timeouts really fire; only the top-level `it` has `live`.
describe("provider discovery probes", () => {
  it.live("reports a signed-in Grok CLI as ready", () =>
    Effect.gen(function* () {
      const grok = fakeCli("grok", ["models"], GROK_LOGGED_IN);
      assert.equal(yield* probeGrok(grok, cleanEnvironment()), "ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a logged-out Grok CLI as signed out", () =>
    Effect.gen(function* () {
      const grok = fakeCli("grok", ["models"], GROK_LOGGED_OUT);
      assert.equal(yield* probeGrok(grok, cleanEnvironment()), "signed-out");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("counts an xAI API key as signed in without running grok models", () =>
    Effect.gen(function* () {
      // Without the key this CLI would fail `grok models`.
      const grok = fakeCli("grok", ["never"], "");
      assert.equal(
        yield* probeGrok(grok, { ...cleanEnvironment(), XAI_API_KEY: "test-key" }),
        "ready",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports OpenCode with a stored credential as ready, and none as signed out", () =>
    Effect.gen(function* () {
      const ready = fakeCli("opencode", ["auth", "list"], OPENCODE_ONE_CREDENTIAL);
      const signedOut = fakeCli("opencode", ["auth", "list"], OPENCODE_NONE);
      assert.equal(yield* probeOpenCode(ready, cleanEnvironment()), "ready");
      assert.equal(yield* probeOpenCode(signedOut, cleanEnvironment()), "signed-out");
      // OpenCode 2 is asked with --standalone, so no shared background service starts.
      const two = fakeCli(
        "opencode",
        ["auth", "list", "--standalone"],
        OPENCODE_TWO_STORED,
        "opencode v2.2.0",
      );
      const twoSignedOut = fakeCli(
        "opencode",
        ["auth", "list", "--standalone"],
        OPENCODE_TWO_NONE,
        "opencode v2.2.0",
      );
      assert.equal(yield* probeOpenCode(two, cleanEnvironment()), "ready");
      assert.equal(yield* probeOpenCode(twoSignedOut, cleanEnvironment()), "signed-out");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(fakeCliDirectory(), "no-such-grok");
      assert.equal(yield* probeGrok(missing, cleanEnvironment()), "not-installed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("gives up on a CLI that hangs and reports unknown", () =>
    Effect.gen(function* () {
      const hanging = writeFakeCli({
        directory: fakeCliDirectory(),
        name: "grok",
        source: "setInterval(() => {}, 1000);",
      });
      assert.equal(yield* probeGrok(hanging, cleanEnvironment()), "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("kills a hung CLI that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const stubborn = writeFakeCli({
        directory: fakeCliDirectory(),
        name: "grok",
        source: 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      });
      assert.equal(yield* probeGrok(stubborn, cleanEnvironment()), "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("closes stdin, so a CLI waiting for input cannot stall the probe", () =>
    Effect.gen(function* () {
      const prompting = writeFakeCli({
        directory: fakeCliDirectory(),
        name: "opencode",
        source: `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0"); process.exit(0); }
process.stdin.resume();
process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(OPENCODE_NONE)}); process.exit(0); });
`,
      });
      assert.equal(yield* probeOpenCode(prompting, cleanEnvironment()), "signed-out");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "studio-provider-discovery-test-" }),
      ),
    ),
  );

const writeSettingsFile = (contents: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(serverConfig.settingsPath, contents);
  });

const readSettingsFile = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(serverConfig.settingsPath);
});

const recordProviderUsage = (provider: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, updated_at
      )
      VALUES (${`thread-${provider}`}, ${"ready"}, ${provider}, ${provider}, ${"2026-10-21T00:00:00.000Z"})
    `;
  });

const AT = "2026-10-21T15:00:00.000Z";

/** What the provider card's switch (and its Undo) writes for a default slot. */
const setDefaultInstanceEnabled = (
  settings: ServerSettingsModule.ServerSettingsService["Service"],
  driver: "grok" | "opencode",
  enabled: boolean,
) =>
  settings.updateProviderInstance({
    operation: "upsert",
    instanceId: ProviderInstanceId.make(driver),
    instance: { driver: ProviderDriverKind.make(driver), enabled, config: {} },
  });

it.layer(NodeServices.layer)("provider discovery settings", (it) => {
  it.effect("treats providers the file never decided as candidates", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const candidates = yield* settings.providerDiscoveryCandidates!;
      assert.deepEqual([...candidates].sort(), ["grok", "opencode"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("never makes a provider the user switched off, or used, a candidate", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile('{"providers":{"grok":{"enabled":false}}}');
      yield* recordProviderUsage("opencode");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const candidates = yield* settings.providerDiscoveryCandidates!;
      assert.deepEqual([...candidates], []);
      assert.deepEqual(yield* settings.autoEnableDiscoveredProviders!(["grok"], AT), []);
      assert.isFalse((yield* settings.getSettings).providers.grok.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("ignores an explicit enabled flag on the default provider instance", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile(
        '{"providerInstances":{"opencode":{"driver":"opencode","enabled":false,"config":{}}}}',
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      assert.deepEqual([...(yield* settings.providerDiscoveryCandidates!)], ["grok"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("leaves a hand-written default slot to the user", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile(
        '{"providerInstances":{"grok":{"driver":"grok","config":{"binaryPath":"/opt/grok"}}}}',
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      assert.deepEqual([...(yield* settings.providerDiscoveryCandidates!)], ["opencode"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps the record when an edit leaves the provider on", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.autoEnableDiscoveredProviders!(["grok"], AT);
      // The card writes the whole default slot, switch included, on any edit.
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make("grok"),
        instance: {
          driver: ProviderDriverKind.make("grok"),
          enabled: true,
          config: { binaryPath: "/opt/grok" },
        },
      });
      assert.deepEqual((yield* settings.getSettings).providerDiscovery.autoEnabled, { grok: AT });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("turns a ready candidate on, records it, and persists both", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      assert.deepEqual(yield* settings.autoEnableDiscoveredProviders!(["grok"], AT), ["grok"]);

      const current = yield* settings.getSettings;
      assert.isTrue(current.providers.grok.enabled);
      assert.isFalse(current.providers.opencode.enabled);
      assert.deepEqual(current.providerDiscovery.autoEnabled, { grok: AT });
      const file = JSON.parse(yield* readSettingsFile);
      assert.isTrue(file.providers.grok.enabled);
      assert.deepEqual(file.providerDiscovery, { autoEnabled: { grok: AT } });
      // Decided now: a second run changes nothing.
      assert.deepEqual([...(yield* settings.providerDiscoveryCandidates!)], ["opencode"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps a candidate after the server's own write persists the default", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.updateSettings({ responseStreamingMode: "turn" });
      assert.deepEqual([...(yield* settings.providerDiscoveryCandidates!)].sort(), [
        "grok",
        "opencode",
      ]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("drops a candidate the user switches before the probe finishes", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* setDefaultInstanceEnabled(settings, "grok", true);
      yield* setDefaultInstanceEnabled(settings, "grok", false);
      assert.deepEqual(yield* settings.autoEnableDiscoveredProviders!(["grok"], AT), []);
      const current = yield* settings.getSettings;
      assert.isFalse(current.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.deepEqual(current.providerDiscovery.autoEnabled, {});
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("forgets the automatic turn-on once the user switches the provider off", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.autoEnableDiscoveredProviders!(["opencode"], AT);
      // An unrelated write keeps the record.
      yield* settings.updateSettings({ responseStreamingMode: "turn" });
      assert.deepEqual((yield* settings.getSettings).providerDiscovery.autoEnabled, {
        opencode: AT,
      });
      // Undo on the card writes the default instance's switch.
      yield* setDefaultInstanceEnabled(settings, "opencode", false);
      const current = yield* settings.getSettings;
      assert.deepEqual(current.providerDiscovery.autoEnabled, {});
      assert.isFalse(current.providerInstances[ProviderInstanceId.make("opencode")]?.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});

/** Rewrites the watched file until the service reports the reload. */
const writeUntilReloaded = (
  settings: ServerSettingsModule.ServerSettingsService["Service"],
  contents: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      for (let attempt = 0; attempt < 6; attempt++) {
        yield* writeSettingsFile(contents);
        const change = yield* changes.pipe(Stream.runHead, Effect.timeoutOption("5 seconds"));
        if (Option.isSome(change)) return;
      }
    }),
  );

const liveSettings = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ServerSettingsModule.ServerSettingsService | ServerConfig.ServerConfig | FileSystem.FileSystem
  >,
) => effect.pipe(Effect.provide(Layer.provideMerge(layerServerSettings(), NodeServices.layer)));

describe("provider discovery at startup", () => {
  it.live("never writes over a settings file that stopped decoding", () =>
    liveSettings(
      Effect.gen(function* () {
        yield* writeSettingsFile("{}");
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        yield* settings.start;
        assert.equal((yield* settings.providerDiscoveryCandidates!).size, 2);
        yield* writeUntilReloaded(settings, "{broken");
        assert.deepEqual(yield* settings.autoEnableDiscoveredProviders!(["grok"], AT), []);
        assert.equal(yield* readSettingsFile, "{broken");
      }),
    ),
  );

  it.live("respects an off the user writes into the file while the probes run", () =>
    liveSettings(
      Effect.gen(function* () {
        yield* writeSettingsFile("{}");
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        yield* settings.start;
        yield* writeUntilReloaded(settings, '{"providers":{"grok":{"enabled":false}}}');
        assert.deepEqual(yield* settings.autoEnableDiscoveredProviders!(["grok"], AT), []);
        assert.isFalse((yield* settings.getSettings).providers.grok.enabled);
      }),
    ),
  );

  it.live("probes candidates on startup and turns on only the signed-in ones", () =>
    Effect.gen(function* () {
      const grok = fakeCli("grok", ["models"], GROK_LOGGED_IN);
      const opencode = fakeCli("opencode", ["auth", "list"], OPENCODE_NONE);
      yield* writeSettingsFile(
        JSON.stringify({
          providers: { grok: { binaryPath: grok }, opencode: { binaryPath: opencode } },
        }),
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.start;
      const enabled = yield* runProviderDiscovery.pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
        Effect.provideService(HostProcessPlatform, HostProcessPlatform.defaultValue()),
      );
      assert.deepEqual(enabled, ["grok"]);
      const current = yield* settings.getSettings;
      assert.isTrue(current.providers.grok.enabled);
      assert.isFalse(current.providers.opencode.enabled);
    }).pipe(Effect.provide(Layer.provideMerge(layerServerSettings(), NodeServices.layer))),
  );
});
