// @effect-diagnostics nodeBuiltinImport:off - fake CLIs are written into a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import {
  DISCOVERED_AGENTS,
  discoverAgents,
  discoveryEnvironment,
  parseOpenCodeAuthList,
  parsePiListModels,
  probeCursor,
  probeGit,
  probeGrok,
  probeMuse,
  probeOpenCode,
  probePi,
  layerSearch,
  runProviderDiscovery,
  searchedFolders,
} from "./providerDiscovery.ts";
import { AgentSearch } from "./agentSearch.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

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

/**
 * A PATH with `node` and the system tools and nothing else, so a test never
 * runs an agent CLI that happens to be installed on the machine.
 */
const isolatedPath = () => {
  const directory = fakeCliDirectory();
  if (HostProcessPlatform.defaultValue() === "win32") {
    NodeFS.writeFileSync(
      NodePath.join(directory, "node.cmd"),
      `@"${process.execPath}" %*\r\n`,
      "utf8",
    );
    return [directory, NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(
      ";",
    );
  }
  const node = NodePath.join(directory, "node");
  NodeFS.writeFileSync(node, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, "utf8");
  NodeFS.chmodSync(node, 0o755);
  return [directory, "/usr/bin", "/bin"].join(":");
};

/** `isolatedPath` without /usr/bin, where a real git and xcode-select live. */
const withoutSystemTools = () => {
  // The fake CLI launcher is a shell script that calls `dirname`.
  const tools = fakeCliDirectory();
  for (const folder of ["/usr/bin", "/bin"]) {
    if (!NodeFS.existsSync(`${folder}/dirname`)) continue;
    NodeFS.symlinkSync(`${folder}/dirname`, NodePath.join(tools, "dirname"));
    break;
  }
  return [
    tools,
    ...isolatedPath()
      .split(":")
      .filter((folder) => folder !== "/usr/bin"),
  ].join(":");
};

const PI_MODELS = [
  "provider   model            context  max-out  thinking  images",
  "anthropic  claude-sonnet-5  200K     64K      yes       yes",
  "",
].join("\n");
const PI_NO_MODELS = "No models available. Set API keys in environment variables.\n";

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
      assert.deepEqual([...candidates].sort(), ["cursor", "grok", "opencode", "pi"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("never makes a provider the user switched off, or used, a candidate", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile('{"providers":{"grok":{"enabled":false}}}');
      yield* recordProviderUsage("opencode");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const candidates = yield* settings.providerDiscoveryCandidates!;
      assert.deepEqual([...candidates], ["pi", "cursor"]);
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
      assert.deepEqual(
        [...(yield* settings.providerDiscoveryCandidates!)],
        ["grok", "pi", "cursor"],
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("leaves a hand-written default slot to the user", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile(
        '{"providerInstances":{"grok":{"driver":"grok","config":{"binaryPath":"/opt/grok"}}}}',
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      assert.deepEqual(
        [...(yield* settings.providerDiscoveryCandidates!)],
        ["opencode", "pi", "cursor"],
      );
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
      assert.deepEqual(
        [...(yield* settings.providerDiscoveryCandidates!)],
        ["opencode", "pi", "cursor"],
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps a candidate after the server's own write persists the default", () =>
    Effect.gen(function* () {
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.updateSettings({ responseStreamingMode: "turn" });
      assert.deepEqual([...(yield* settings.providerDiscoveryCandidates!)].sort(), [
        "cursor",
        "grok",
        "opencode",
        "pi",
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
        assert.equal((yield* settings.providerDiscoveryCandidates!).size, 4);
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
        Effect.provideService(HostProcessEnvironment, { PATH: isolatedPath() }),
        Effect.provideService(HostProcessPlatform, HostProcessPlatform.defaultValue()),
      );
      assert.deepEqual(enabled, ["grok"]);
      const current = yield* settings.getSettings;
      assert.isTrue(current.providers.grok.enabled);
      assert.isFalse(current.providers.opencode.enabled);
    }).pipe(Effect.provide(Layer.provideMerge(layerServerSettings(), NodeServices.layer))),
  );
});

describe("finding every agent", () => {
  it("reads Pi's model list as the sign-in", () => {
    expect(parsePiListModels(PI_MODELS)).toBe(true);
    expect(parsePiListModels(PI_NO_MODELS)).toBe(false);
    expect(parsePiListModels("")).toBe(null);
  });

  it.live("reports Pi with models as ready, and without as signed out", () =>
    Effect.gen(function* () {
      const ready = fakeCli("pi", ["--list-models"], PI_MODELS);
      const signedOut = fakeCli("pi", ["--list-models"], PI_NO_MODELS);
      assert.equal(yield* probePi(ready, cleanEnvironment()), "ready");
      assert.equal(yield* probePi(signedOut, cleanEnvironment()), "signed-out");
      assert.equal(
        yield* probePi("pi-not-installed-anywhere", cleanEnvironment()),
        "not-installed",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("takes a Cursor key as the sign-in, and the CLI alone as installed", () =>
    Effect.gen(function* () {
      const cli = fakeCli("cursor-agent", ["never"], "");
      assert.equal(yield* probeCursor(cli, cleanEnvironment()), "installed");
      assert.equal(
        yield* probeCursor("cursor-agent-not-installed-anywhere", {
          ...cleanEnvironment(),
          CURSOR_API_KEY: "test-key",
        }),
        "ready",
      );
      assert.equal(
        yield* probeCursor("cursor-agent-not-installed-anywhere", cleanEnvironment()),
        "not-installed",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a signed-in Muse Code as ready, and a signed-out one as installed", () =>
    Effect.gen(function* () {
      const signedIn = fakeCli("muse", ["usage", "--json"], "{}", "Muse Code 1.4.15");
      const signedOut = fakeCli("muse", ["never"], "", "Muse Code 1.4.15");
      assert.equal(yield* probeMuse(signedIn, cleanEnvironment()), "ready");
      assert.equal(yield* probeMuse(signedOut, cleanEnvironment()), "installed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("asks a Mac's developer tools for Git, and never the /usr/bin shim", () =>
    Effect.gen(function* () {
      if (HostProcessPlatform.defaultValue() === "win32") return;
      const tool = (directory: string, name: string, exit: number) =>
        writeFakeCli({ directory, name, source: `process.exit(${exit});` });
      const developer = fakeCliDirectory();
      NodeFS.mkdirSync(NodePath.join(developer, "usr/bin"), { recursive: true });
      tool(NodePath.join(developer, "usr/bin"), "git", 0);
      const says = (directory: string, folder: string) =>
        writeFakeCli({
          directory,
          name: "xcode-select",
          source: `console.log(${JSON.stringify(folder)}); process.exit(0);`,
        });
      const withTools = fakeCliDirectory();
      says(withTools, developer);
      // A macOS upgrade can remove the tools and leave their path behind.
      const stale = fakeCliDirectory();
      says(stale, NodePath.join(developer, "gone"));
      const withoutTools = fakeCliDirectory();
      tool(withoutTools, "xcode-select", 2);
      const brewGit = fakeCliDirectory();
      tool(brewGit, "xcode-select", 2);
      tool(brewGit, "git", 0);
      const path = (directory: string) => [directory, withoutSystemTools()].join(":");
      assert.equal(yield* probeGit({ PATH: path(withTools) }, "darwin"), "present");
      assert.equal(yield* probeGit({ PATH: path(withoutTools) }, "darwin"), "missing");
      assert.equal(yield* probeGit({ PATH: path(stale) }, "darwin"), "missing");
      // A Git that does not come from the developer tools counts.
      assert.equal(yield* probeGit({ PATH: path(brewGit) }, "darwin"), "present");
      // The shim's folder is never searched: running it opens macOS's install prompt.
      if (HostProcessPlatform.defaultValue() === "darwin") {
        const shimOnly = [withoutTools, withoutSystemTools(), "/usr/bin"].join(":");
        assert.equal(yield* probeGit({ PATH: shimOnly }, "darwin"), "missing");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("looks for Git by running it on Linux", () =>
    Effect.gen(function* () {
      if (HostProcessPlatform.defaultValue() === "win32") return;
      const directory = fakeCliDirectory();
      writeFakeCli({ directory, name: "git", source: "process.exit(0);" });
      const path = [directory, withoutSystemTools()].join(":");
      assert.equal(yield* probeGit({ PATH: path }, "linux"), "present");
      assert.equal(yield* probeGit({ PATH: withoutSystemTools() }, "linux"), "missing");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("lists the folders it looked in, once each", () => {
    expect(searchedFolders({ PATH: "/a:/b::/a" }, "linux")).toEqual(["/a", "/b"]);
    expect(searchedFolders({ Path: "C:\\a;C:\\b" }, "win32")).toEqual(["C:\\a", "C:\\b"]);
  });

  it("gives Muse Code a default row that is off until someone turns it on", () => {
    const fresh = DEFAULT_SERVER_SETTINGS;
    assert.deepEqual(deriveProviderInstanceConfigMap(fresh)[ProviderInstanceId.make("muse")], {
      driver: ProviderDriverKind.make("muse"),
      enabled: false,
      config: {},
    });
    assert.isFalse(
      resolveProviderInstanceEnabled(
        deriveProviderInstanceConfigMap(fresh)[ProviderInstanceId.make("muse")]!,
      ),
    );
    const chosen = {
      driver: ProviderDriverKind.make("muse"),
      enabled: true,
      config: { binaryPath: "/opt/muse" },
    };
    assert.deepEqual(
      deriveProviderInstanceConfigMap({
        ...fresh,
        providerInstances: { [ProviderInstanceId.make("muse")]: chosen },
      })[ProviderInstanceId.make("muse")],
      chosen,
    );
  });

  it.live("finds each agent by its command and never turns on Muse Code or a registry agent", () =>
    Effect.gen(function* () {
      const directory = fakeCliDirectory();
      const cli = (name: string, statusArgs: ReadonlyArray<string>, statusOutput: string) =>
        writeFakeCli({
          directory,
          name,
          source: `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("${name} 1.0.0"); process.exit(0); }
if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(statusArgs))}) {
  process.stdout.write(${JSON.stringify(statusOutput)});
  process.exit(0);
}
process.exit(2);
`,
        });
      cli("muse", ["usage", "--json"], "{}");
      cli("pi", ["--list-models"], PI_MODELS);
      cli("gemini", ["never"], "");
      cli("claude", ["never"], "");
      const path = [directory, isolatedPath()].join(NodePath.delimiter);
      yield* writeSettingsFile("{}");
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.start;

      const report = yield* discoverAgents(yield* settings.getSettings).pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: path }),
        Effect.provideService(HostProcessPlatform, HostProcessPlatform.defaultValue()),
      );
      assert.deepEqual(
        Object.fromEntries(report.results.map(({ agent, state }) => [agent, state])),
        {
          codex: "not-installed",
          claudeAgent: "installed",
          cursor: "not-installed",
          grok: "not-installed",
          muse: "ready",
          opencode: "not-installed",
          pi: "ready",
          antigravity: "not-installed",
          gemini: "installed",
          "github-copilot-cli": "not-installed",
        },
      );
      assert.equal(report.results.length, DISCOVERED_AGENTS.length);
      assert.equal(report.searched[0], directory);

      const enabled = yield* runProviderDiscovery.pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: path }),
        Effect.provideService(HostProcessPlatform, HostProcessPlatform.defaultValue()),
      );
      assert.deepEqual(enabled, ["pi"]);
      const current = yield* settings.getSettings;
      assert.isTrue(current.providers.pi.enabled);
      assert.deepEqual(Object.keys(current.providerDiscovery.autoEnabled), ["pi"]);
      assert.deepEqual(current.providerInstances, {});
    }).pipe(Effect.provide(Layer.provideMerge(layerServerSettings(), NodeServices.layer))),
  );
});

describe("finding agents on demand", () => {
  /** A search service whose PATH holds that Pi and nothing else. */
  const layerSearchWith = (pi: string) => {
    const path = [NodePath.dirname(pi), isolatedPath()].join(NodePath.delimiter);
    return layerSearch.pipe(
      Layer.provide(Layer.succeed(HostProcessEnvironment, { PATH: path })),
      Layer.provideMerge(Layer.provideMerge(layerServerSettings(), NodeServices.layer)),
    );
  };
  const layerSearchWithPi = () => layerSearchWith(fakeCli("pi", ["--list-models"], PI_MODELS));
  /** A signed-in Pi that takes a while to list its models. */
  const slowPi = () =>
    writeFakeCli({
      directory: fakeCliDirectory(),
      name: "pi",
      source: `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("pi 1.0.0"); process.exit(0); }
setTimeout(() => { process.stdout.write(${JSON.stringify(PI_MODELS)}); process.exit(0); }, 1500);
`,
    });

  const startSettings = Effect.gen(function* () {
    yield* writeSettingsFile("{}");
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    yield* settings.start;
    return settings;
  });

  const untilDone = (search: AgentSearch["Service"]["search"]) =>
    search({ fresh: false }).pipe(
      Effect.repeat({
        until: (snapshot) => snapshot.pending.length === 0,
        schedule: Schedule.spaced("50 millis"),
      }),
      Effect.timeout("30 seconds"),
    );

  it.live("answers at once, fills in as agents answer, and turns on the signed-in one", () =>
    Effect.gen(function* () {
      const settings = yield* startSettings;
      const { search } = yield* AgentSearch;

      const first = yield* search({ fresh: false });
      assert.deepEqual(first.agents, []);
      assert.deepEqual(
        first.pending,
        DISCOVERED_AGENTS.map(({ agent }) => agent),
      );
      assert.isUndefined(first.checkedAt);
      assert.isAbove(first.searched.length, 0);

      // Nothing pending means the search is finished: listed order, and a time.
      const done = yield* untilDone(search);
      assert.deepEqual(
        done.agents.map(({ agent }) => agent),
        DISCOVERED_AGENTS.map(({ agent }) => agent),
      );
      assert.equal(done.agents.find(({ agent }) => agent === "pi")?.state, "ready");
      assert.equal(done.agents.find(({ agent }) => agent === "codex")?.state, "not-installed");
      assert.isString(done.checkedAt);
      assert.isTrue((yield* settings.getSettings).providers.pi.enabled);
    }).pipe(Effect.provide(layerSearchWithPi())),
  );

  it.live("keeps a recent search, and starts another only when asked", () =>
    Effect.gen(function* () {
      yield* startSettings;
      const { search } = yield* AgentSearch;
      yield* search({ fresh: false });
      const done = yield* untilDone(search);

      // Recent: answered from what is known, nothing is run again.
      const again = yield* search({ fresh: false });
      assert.deepEqual(again, done);

      // Asked for: every agent is checked again, and the rows stay meanwhile.
      const fresh = yield* search({ fresh: true });
      assert.equal(fresh.pending.length, DISCOVERED_AGENTS.length);
      assert.deepEqual(fresh.agents, done.agents);
      const finished = yield* untilDone(search);
      assert.deepEqual(finished.agents, done.agents);
    }).pipe(Effect.provide(layerSearchWithPi())),
  );

  it.live("joins a search that is running instead of starting a second one", () =>
    Effect.gen(function* () {
      yield* startSettings;
      const { search } = yield* AgentSearch;
      // Codex is not installed, so it answers long before the slow Pi.
      const partial = yield* search({ fresh: false }).pipe(
        Effect.repeat({
          until: (snapshot) => !snapshot.pending.includes("codex"),
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("30 seconds"),
      );
      assert.include(partial.pending, "pi");

      // A second search would list every agent as pending again.
      const joined = yield* search({ fresh: true });
      assert.notInclude(joined.pending, "codex");
      assert.include(joined.pending, "pi");
      const done = yield* untilDone(search);
      assert.equal(done.agents.find(({ agent }) => agent === "pi")?.state, "ready");
    }).pipe(Effect.provide(Layer.suspend(() => layerSearchWith(slowPi())))),
  );

  it.live("ends a search that died with no answer for the rest", () => {
    let searches = 0;
    const brokenSettings = Layer.succeed(ServerSettingsModule.ServerSettingsService, {
      ready: Effect.suspend(() => {
        searches += 1;
        return Effect.die("settings are gone");
      }),
    } as unknown as ServerSettingsModule.ServerSettingsService["Service"]);
    return Effect.gen(function* () {
      const { search } = yield* AgentSearch;
      yield* search({ fresh: false });
      const died = yield* untilDone(search);
      assert.deepEqual(
        died.agents.map(({ agent, state }) => [agent, state]),
        DISCOVERED_AGENTS.map(({ agent }) => [agent, "unknown"]),
      );
      assert.isString(died.checkedAt);
      assert.equal(searches, 1);

      // Kept like any other, so reading it again starts nothing. Asking does.
      yield* search({ fresh: false });
      assert.equal(searches, 1);
      yield* search({ fresh: true });
      const again = yield* untilDone(search);
      assert.equal(searches, 2);
      assert.lengthOf(again.agents, DISCOVERED_AGENTS.length);
    }).pipe(
      Effect.provide(
        layerSearch.pipe(
          Layer.provide(Layer.succeed(HostProcessEnvironment, { PATH: isolatedPath() })),
          Layer.provide(brokenSettings),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
