import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  providerSettingsPasswordKeys,
  REDACTED_SECRET_MARKER,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
} from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { BUILT_IN_DRIVERS } from "./provider/builtInDrivers.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistryMutator from "./provider/ProviderInstanceRegistryMutator.ts";
import * as ProviderCredentialStore from "./provider/ProviderCredentialStore.ts";
import { resolveAntigravityInstanceDirectories } from "./provider/antigravityAuthSupport.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

/**
 * Rewrites a watched settings file until the service reports a change. On a loaded Mac the event
 * for a write made just after a directory watch starts can be lost (1 in 60 at load 780), while a
 * path the service does not watch never reports a change however often it is written.
 */
const writeUntilChanged = <A>(changes: Stream.Stream<A>, filePath: string, contents: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 6; attempt++) {
      yield* writeFileStringAtomically({ filePath, contents });
      const change = yield* changes.pipe(Stream.runHead, Effect.timeoutOption("5 seconds"));
      if (Option.isSome(change)) return change.value;
    }
    return Option.none<A>();
  });

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "studio-server-settings-test-",
        }),
      ),
    ),
  );

/** Like `layerServerSettings`, but also exposes the secret store for assertions. */
const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "studio-server-settings-test-",
        }),
      ),
    ),
  );

/** Like `layerServerSettingsWithSecrets`, with sign-in removal failing while `failing` is set. */
const layerServerSettingsWithFlakySecretRemoval = () => {
  const removal = { failing: false };
  const secretStore = Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.map(ServerSecretStore.make, (store) =>
      ServerSecretStore.ServerSecretStore.of({
        ...store,
        remove: (name) =>
          removal.failing && name.startsWith("provider-auth-")
            ? Effect.fail(
                new ServerSecretStore.SecretStoreRemoveError({
                  resource: "provider sign-in",
                  cause: new Error("Secret backend unavailable."),
                }),
              )
            : store.remove(name),
      }),
    ),
  );
  const layer = ServerSettingsModule.layer.pipe(
    Layer.provideMerge(secretStore),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "studio-server-settings-test-",
        }),
      ),
    ),
  );
  return { layer, removal };
};

/** Like `layerServerSettingsWithSecrets`, counting secret-store reads by name. */
const layerServerSettingsCountingSecretReads = () => {
  const reads = new Map<string, number>();
  const secretStore = Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.map(ServerSecretStore.make, (store) =>
      ServerSecretStore.ServerSecretStore.of({
        ...store,
        get: (name) =>
          Effect.sync(() => reads.set(name, (reads.get(name) ?? 0) + 1)).pipe(
            Effect.andThen(store.get(name)),
          ),
      }),
    ),
  );
  const layer = ServerSettingsModule.layer.pipe(
    Layer.provideMerge(secretStore),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "studio-server-settings-test-",
        }),
      ),
    ),
  );
  return { layer, reads };
};

const SIGN_IN_TOMBSTONES_FILE = "provider-sign-in-tombstones.json";

/** Writes (or, with `undefined`, deletes) a file until the watcher reports a matching change. */
const changeFileUntil = <A>(
  changes: Stream.Stream<A>,
  filePath: string,
  contents: string | undefined,
  matches: (change: A) => boolean,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (contents === undefined) yield* fileSystem.remove(filePath, { force: true });
      else yield* writeFileStringAtomically({ filePath, contents });
      for (;;) {
        const change = yield* changes.pipe(Stream.runHead, Effect.timeoutOption("5 seconds"));
        if (Option.isNone(change) || Option.isNone(change.value)) break;
        if (matches(change.value.value)) return true;
      }
    }
    return false;
  });

const layerFailingSecretStore = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const readApiKey = (config: unknown) =>
  (config as { readonly apiKey?: string } | undefined)?.apiKey;

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("migrates saved token delivery to paragraph buffering without resetting settings", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        `{
          "responseStreamingMode": "token",
          "enableAgentBrowserAccess": false,
          "projectSettingsSimplified": true,
          "projectSettingsOverrides": {
            "legacy": { "responseStreamingMode": "token", "defaultAutoPull": true },
            "buffered": { "responseStreamingMode": "turn" },
            "inherited": { "defaultAutoPull": false }
          }
        }`,
      );

      const settings = yield* service.getSettings;
      assert.equal(settings.responseStreamingMode, "paragraph");
      assert.isFalse(settings.enableAgentBrowserAccess);
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("legacy")]: { responseStreamingMode: "paragraph", defaultAutoPull: true },
        [ProjectId.make("buffered")]: { responseStreamingMode: "turn" },
        [ProjectId.make("inherited")]: { defaultAutoPull: false },
      });

      yield* service.updateSettings({ responseStreamingMode: "turn" });
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "turn");
      assert.deepEqual(persisted.projectSettingsOverrides, settings.projectSettingsOverrides);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("saves a sidebar project order whose pinned or unpinned list is empty", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;

      const unpinnedOnly = { pinned: [], unpinned: ["project-b", "project-a"] };
      yield* service.updateSettings({ sidebarProjectOrder: unpinnedOnly });
      let persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.deepEqual(persisted.sidebarProjectOrder, unpinnedOnly);

      const pinnedOnly = { pinned: ["project-a"], unpinned: [] };
      yield* service.updateSettings({ sidebarProjectOrder: pinnedOnly });
      persisted = yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath));
      assert.deepEqual(persisted.sidebarProjectOrder, pinnedOnly);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("saves through a symlinked settings file without replacing the link", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "studio-settings-dotfiles-" });
      const linkedSettingsPath = path.join(dotfiles, "settings.json");
      yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
      yield* fs.remove(config.settingsPath, { force: true });
      yield* fs.symlink(linkedSettingsPath, config.settingsPath);

      yield* service.updateSettings({ responseStreamingMode: "paragraph" });

      assert.equal(yield* fs.readLink(config.settingsPath), linkedSettingsPath);
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(linkedSettingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "paragraph");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("reloads when the destination of a symlinked settings file changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "studio-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "settings.json");
        yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        const change = yield* writeUntilChanged(
          changes,
          linkedSettingsPath,
          `{ "responseStreamingMode": "paragraph" }`,
        );
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("follows a settings link that is repointed to another directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "studio-settings-dotfiles-" });
        const firstSettingsPath = path.join(dotfiles, "first", "settings.json");
        const secondSettingsPath = path.join(dotfiles, "second", "settings.json");
        yield* fs.makeDirectory(path.dirname(firstSettingsPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(secondSettingsPath), { recursive: true });
        yield* fs.writeFileString(firstSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.writeFileString(secondSettingsPath, `{ "responseStreamingMode": "paragraph" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(firstSettingsPath, config.settingsPath);
        yield* service.start;

        const repointChanges = yield* service.subscribeChanges;
        yield* fs.remove(config.settingsPath);
        yield* fs.symlink(secondSettingsPath, config.settingsPath);
        const repointed = yield* repointChanges.pipe(Stream.runHead, Effect.timeout("15 seconds"));
        assert.equal(Option.getOrUndefined(repointed)?.responseStreamingMode, "paragraph");

        const editChanges = yield* service.subscribeChanges;
        const edited = yield* writeUntilChanged(
          editChanges,
          secondSettingsPath,
          `{ "responseStreamingMode": "turn" }`,
        );
        assert.equal(Option.getOrUndefined(edited)?.responseStreamingMode, "turn");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("reloads when a dangling settings link gets its destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "studio-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "not-yet", "settings.json");
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        const change = yield* writeUntilChanged(
          changes,
          linkedSettingsPath,
          `{ "responseStreamingMode": "paragraph" }`,
        );
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const layerConfig = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "studio-server-settings-secret-failure-test-",
      }),
    );
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerFailingSecretStore(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(layerConfig),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect("identifies provider history query failures", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_thread_sessions`;

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-provider-history",
        settingsPath: serverConfig.settingsPath,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("retries a failed settings read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // A directory where the file should be makes the read itself fail.
      yield* fileSystem.makeDirectory(serverConfig.settingsPath);

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.deepInclude(error, { _tag: "ServerSettingsError", operation: "read-file" });

      yield* fileSystem.remove(serverConfig.settingsPath, { recursive: true });
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{ "responseStreamingMode": "turn" }`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.equal(settings.responseStreamingMode, "turn");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }),
        {
          providers: { codex: { binaryPath: "/tmp/codex" } },
        },
      );

      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/dev/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/dev/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        launchArgs: "",
        autoCompactWindow: "",
        idleCompaction: true,
      });
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("creates provider instances atomically without overwriting a concurrent add", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("acpRegistry_shared");
      const results = yield* Effect.all(
        ["First", "Second"].map((displayName) =>
          serverSettings
            .updateProviderInstance({
              operation: "create",
              instanceId,
              instance: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName,
                config: { agentId: "shared", distribution: "auto" },
              },
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
      assert.isTrue(
        ["First", "Second"].includes(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName ?? "",
        ),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("pauses provider-instance mutations while a settings snapshot is in use", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const snapshotEntered = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const mutationCompleted = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");

      const snapshotFiber = yield* serverSettings
        .withSettingsSnapshot(() =>
          Deferred.succeed(snapshotEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSnapshot)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(snapshotEntered);

      const mutationFiber = yield* serverSettings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Kilo",
            config: { agentId: "kilo", distribution: "auto" },
          },
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(mutationCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;

      assert.isTrue(Option.isNone(yield* Deferred.poll(mutationCompleted)));
      yield* Deferred.succeed(releaseSnapshot, undefined);
      yield* Fiber.join(snapshotFiber);
      yield* Fiber.join(mutationFiber);
      assert.equal(
        (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName,
        "Kilo",
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex-next",
            },
          },
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("15 seconds"));
        assert.equal(
          Option.getOrUndefined(firstChange)?.providers.codex.binaryPath,
          "/usr/local/bin/codex-next",
        );
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("persists custom usage prices and removes them from the settings file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const prices = {
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8,
          cacheReadCostPerMillionTokens: 0,
        };
        const readPersisted = fileSystem
          .readFileString(serverConfig.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))));

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": prices } });
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("persists and broadcasts thread settlement settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        const next = yield* serverSettings.updateSettings({
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
        });
        const change = Option.getOrUndefined(yield* Stream.runHead(changes));
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        // Inspect raw persisted JSON before schema decoding can apply defaults.
        const persisted = JSON.parse(raw) as Record<string, unknown>;

        assert.strictEqual(next.sidebarAutoSettleAfterDays, null);
        assert.isFalse(next.sidebarAutoSettleOnMerge);
        assert.strictEqual(change?.sidebarAutoSettleAfterDays, null);
        assert.isFalse(change?.sidebarAutoSettleOnMerge);
        assert.strictEqual(persisted.sidebarAutoSettleAfterDays, null);
        assert.isFalse(persisted.sidebarAutoSettleOnMerge);
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(layerServerSettings())),
  );

  // Only driver-keyed instances are fallback candidates; a custom instance id
  // is not one, so the selection stays put until the user changes it.
  it.effect.each(["codex"])(
    "falls back to enabled instance %s after disabling the selection",
    (fallbackId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
          const serverConfig = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const writerId = ProviderInstanceId.make("writer");
          const fallbackInstanceId = ProviderInstanceId.make(fallbackId);
          const selection = { instanceId: writerId, model: "claude-sonnet-4-6" };
          const providerInstances = {
            [fallbackInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [writerId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: {},
            },
          };

          yield* serverSettings.updateSettings({
            providers: Object.fromEntries(
              Object.keys(DEFAULT_SERVER_SETTINGS.providers).map(
                (provider) => [provider, { enabled: false }] as const,
              ),
            ),
            providerInstances,
            textGenerationModelSelection: selection,
          });
          const changes = yield* serverSettings.subscribeChanges;

          const next = yield* serverSettings.updateSettings({
            providerInstances: {
              ...providerInstances,
              [writerId]: { ...providerInstances[writerId]!, enabled: false },
            },
          });
          const fallbackSelection = {
            instanceId: fallbackInstanceId,
            model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          };
          assert.deepEqual(next.textGenerationModelSelection, fallbackSelection);
          assert.deepEqual(
            (yield* serverSettings.getSettings).textGenerationModelSelection,
            fallbackSelection,
          );
          const change = Option.getOrUndefined(yield* Stream.runHead(changes));
          assert.deepEqual(change?.textGenerationModelSelection, fallbackSelection);

          const persisted = yield* fileSystem
            .readFileString(serverConfig.settingsPath)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))),
            );
          assert.deepEqual(persisted.textGenerationModelSelection, selection);

          const restored = yield* serverSettings.updateSettings({ providerInstances });
          assert.deepEqual(restored.textGenerationModelSelection, selection);
        }),
      ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("skips explicitly disabled instances when choosing a legacy fallback", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: {},
          },
        },
      });

      assert.equal(next.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("enables previously used providers from sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"opencode":{"serverUrl":"http://127.0.0.1:4096"}}}',
      );
      yield* recordProviderUsage("opencode");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.equal(settings.providers.opencode.serverUrl, "http://127.0.0.1:4096");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves existing provider instances without explicit enabled flags", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"cursor_work":{"driver":"cursor","config":{}},"grok":{"driver":"grok","config":{}},"opencode_work":{"driver":"opencode","config":{"serverUrl":"http://127.0.0.1:4096"}},"opencode_unused":{"driver":"opencode","config":{}}}}',
      );
      yield* recordProviderUsage("cursor", "cursor_work");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("opencode", "opencode_work");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("opencode_work")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves explicit provider disables in existing settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"grok":{"enabled":false},"opencode":{"enabled":false},"cursor":{"enabled":false}},"providerInstances":{"grok":{"driver":"grok","enabled":false,"config":{}},"opencode":{"driver":"opencode","config":{"enabled":false}},"cursor":{"driver":"cursor","enabled":false,"config":{}}}}',
      );
      yield* recordProviderUsage("grok");
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("opencode")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("skips a disabled provider instance when picking the text generation fallback", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // The Providers UI writes providerInstances only, so the legacy providers
      // map decodes to defaults where codex is enabled and listed first.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps unused providers disabled in existing sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves provider history when no settings file exists", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves provider history when the settings file is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{invalid json");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves valid provider flags when another settings field is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"addProjectBaseDirectory":42,"providers":{"cursor":{"enabled":false},"grok":{"enabled":true}}}',
      );
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.cursor.enabled);
      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("restores providers from persisted runtime sessions", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          status,
          last_seen_at
        )
        VALUES (
          ${"thread-opencode-runtime"},
          ${"opencode"},
          ${"opencode"},
          ${"opencode"},
          ${"ready"},
          ${"2026-08-25T00:00:00.000Z"}
        )
      `;

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("persists explicit disables after a provider has been used", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      assert.isTrue((yield* serverSettings.getSettings).providers.grok.enabled);

      const settings = yield* serverSettings.updateSettings({
        providers: { grok: { enabled: false } },
      });
      assert.isFalse(settings.providers.grok.enabled);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.isFalse(JSON.parse(raw).providers.grok.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("persists explicit provider enables before their first use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          cursor: { enabled: true },
          grok: { enabled: true },
          opencode: { enabled: true },
        },
      });
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = JSON.parse(raw);
      assert.isTrue(persisted.providers.cursor.enabled);
      assert.isTrue(persisted.providers.grok.enabled);
      assert.isTrue(persisted.providers.opencode.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps optional providers disabled after a new installation writes settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const initial = yield* serverSettings.getSettings;
      assert.isFalse(initial.providers.grok.enabled);
      assert.isFalse(initial.providers.opencode.enabled);
      assert.isFalse(initial.providers.cursor.enabled);

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      assert.isFalse(next.providers.grok.enabled);
      assert.isFalse(next.providers.opencode.enabled);
      assert.isFalse(next.providers.cursor.enabled);
      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = JSON.parse(raw);
      assert.isFalse(persisted.providers.cursor.enabled);
      assert.isFalse(persisted.providers.grok.enabled);
      assert.isFalse(persisted.providers.opencode.enabled);
      assert.isUndefined(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable sticks.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });
      // A lone in-config flag is lifted to the envelope and stripped.
      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });
      // A malformed flag is left alone so driver schema validation can
      // surface it instead of the fold silently repairing the config.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        launchArgs: "",
        autoCompactWindow: "",
        idleCompaction: true,
      });
      assert.deepEqual(next.providers.opencode, {
        // OpenCode is disabled by default; this update only touches paths.
        enabled: false,
        binaryPath: "/opt/homebrew/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "secret-password",
        customModels: [],
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("writes non-default settings and explicit optional provider defaults to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          cursor: {
            enabled: false,
          },
          grok: {
            enabled: false,
          },
          opencode: {
            enabled: false,
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        backgroundActivity: {
          schemaVersion: 1,
          profile: "custom",
          baseProfile: "balanced",
          overrides: {
            automaticGitFetchInterval: 10_000,
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps the inline value on disk when secret migration fails", () => {
    const cause = new ServerSecretStore.SecretStorePersistError({
      resource: "provider environment secret",
      cause: new Error("Secret storage unavailable"),
    });
    const layerSecret = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerSecret),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "studio-inline-secret-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const original =
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}';
      yield* fs.writeFileString(config.settingsPath, original);
      const error = yield* Effect.flip(
        service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
              config: {},
            },
          },
        }),
      );
      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, cause);
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
      const settings = yield* service.getSettings;
      assert.equal(
        settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect.each(
    [
      {
        label: "preserves an inline secret on a redacted settings save",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "inline-test-token",
      },
      {
        label: "preserves the effective last inline secret when names are duplicated",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "last-inline-test-token",
        duplicate: true,
      },
      {
        label: "replaces an inline secret with an explicit value",
        variable: { name: "API_TOKEN", value: "replacement-test-token", sensitive: true },
        expected: "replacement-test-token",
      },
      {
        label: "clears an inline secret with an explicit empty value",
        variable: { name: "API_TOKEN", value: "", sensitive: true },
        expected: "",
      },
    ].map((testCase) => [testCase.label, testCase] as const),
  )("%s", ([, { variable, expected, duplicate }]) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        duplicate
          ? '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true},{"name":"API_TOKEN","value":"last-inline-test-token","sensitive":true}],"config":{}}}}'
          : '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}',
      );
      const initial = yield* serverSettings.getSettings;
      assert.equal(
        initial.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Renamed provider",
            environment: duplicate ? [variable, variable] : [variable],
            config: {},
          },
        },
      });
      assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, expected);
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "inline-test-token");
      assert.notInclude(raw, "replacement-test-token");

      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );
      assert.equal(reloaded.providerInstances[instanceId]?.environment?.[0]?.value, expected);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect.each([true, false])(
    "preserves duplicate secret operation order (sensitive last: %s)",
    (sensitiveLast) =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_duplicate");
        const secret = { name: "API_TOKEN", value: "secret-last", sensitive: true };
        const plain = { name: "API_TOKEN", value: "plain-last", sensitive: false };
        const next = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: sensitiveLast ? [plain, secret] : [secret, plain],
              config: {},
            },
          },
        });
        assert.equal(
          next.providerInstances[instanceId]?.environment?.at(-1)?.value,
          sensitiveLast ? "secret-last" : "plain-last",
        );
        assert.equal(
          next.providerInstances[instanceId]?.environment?.find((v) => v.sensitive)?.value,
          sensitiveLast ? "secret-last" : "",
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "keeps Bitbucket tokens in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          bitbucket: { email: "me@example.com", accessToken: "bb-access", apiToken: "bb-api" },
        });
        assert.deepEqual(saved.bitbucket, {
          email: "me@example.com",
          accessToken: "bb-access",
          apiToken: "bb-api",
        });

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "bb-access");
        assert.notInclude(raw, "bb-api");
        assert.include(raw, "me@example.com");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).bitbucket;
        assert.equal(forClient.email, "me@example.com");
        assert.notInclude(forClient.accessToken, "bb-access");
        assert.notInclude(forClient.apiToken, "bb-api");
        assert.isAbove(forClient.accessToken.length, 0);
        assert.isAbove(forClient.apiToken.length, 0);

        // A client echoing the redacted values back, or omitting them, keeps the saved tokens.
        yield* serverSettings.updateSettings({ bitbucket: forClient });
        yield* serverSettings.updateSettings({ bitbucket: { email: "other@example.com" } });
        assert.deepEqual((yield* serverSettings.getSettings).bitbucket, {
          email: "other@example.com",
          accessToken: "bb-access",
          apiToken: "bb-api",
        });

        const cleared = yield* serverSettings.updateSettings({ bitbucket: { accessToken: "" } });
        assert.equal(cleared.bitbucket.accessToken, "");
        assert.equal(cleared.bitbucket.apiToken, "bb-api");
        assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
        assert.equal(
          ServerSettingsModule.redactServerSettingsForClient(cleared).bitbucket.accessToken,
          "",
        );
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "keeps the ElevenLabs voice key in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          voice: {
            provider: "elevenlabs",
            elevenLabsVoiceId: "voice-1",
            elevenLabsApiKey: "xi-test-key",
          },
        });
        assert.equal(saved.voice.provider, "elevenlabs");
        assert.equal(saved.voice.elevenLabsApiKey, "xi-test-key");

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "xi-test-key");
        assert.include(raw, "voice-1");
        const stored = yield* secrets.get("elevenlabs-voice-api-key");
        assert.equal(
          Option.isSome(stored) ? new TextDecoder().decode(stored.value) : null,
          "xi-test-key",
        );

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).voice;
        assert.notInclude(forClient.elevenLabsApiKey, "xi-test-key");
        assert.isAbove(forClient.elevenLabsApiKey.length, 0);

        // Echoing the marker back, or omitting the key, keeps the saved one.
        yield* serverSettings.updateSettings({ voice: forClient });
        yield* serverSettings.updateSettings({ voice: { rate: 0.52 } });
        const kept = yield* serverSettings.getSettings;
        assert.equal(kept.voice.elevenLabsApiKey, "xi-test-key");
        assert.equal(kept.voice.rate, 0.52);
        assert.equal(kept.voice.provider, "elevenlabs");

        const cleared = yield* serverSettings.updateSettings({
          voice: { provider: "local", elevenLabsApiKey: "" },
        });
        assert.equal(cleared.voice.elevenLabsApiKey, "");
        assert.isTrue(Option.isNone(yield* secrets.get("elevenlabs-voice-api-key")));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("reads a redacted secret once until settings or the secret store change", () => {
    const { layer, reads } = layerServerSettingsCountingSecretReads();
    const voiceKeyReads = () => reads.get("elevenlabs-voice-api-key") ?? 0;
    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* serverSettings.updateSettings({
        voice: { provider: "elevenlabs", elevenLabsVoiceId: "voice-1", elevenLabsApiKey: "xi-1" },
      });

      // Any write through the store drops what was read before.
      yield* secrets.set("unrelated-secret", new TextEncoder().encode("x"));
      reads.clear();
      for (let read = 0; read < 100; read++) {
        assert.equal((yield* serverSettings.getSettings).voice.elevenLabsApiKey, "xi-1");
      }
      assert.equal(voiceKeyReads(), 1);

      // A settings update makes a new settings object, so the secret is read again.
      reads.clear();
      yield* serverSettings.updateSettings({ voice: { rate: 0.6 } });
      const afterUpdate = voiceKeyReads();
      assert.isAtLeast(afterUpdate, 1);
      yield* serverSettings.getSettings;
      yield* serverSettings.getSettings;
      assert.equal(voiceKeyReads(), afterUpdate);

      // A write through the store is seen by the next read.
      yield* secrets.set("elevenlabs-voice-api-key", new TextEncoder().encode("xi-2"));
      reads.clear();
      assert.equal((yield* serverSettings.getSettings).voice.elevenLabsApiKey, "xi-2");
      assert.equal((yield* serverSettings.getSettings).voice.elevenLabsApiKey, "xi-2");
      assert.equal(voiceKeyReads(), 1);

      yield* secrets.remove("elevenlabs-voice-api-key");
      assert.equal((yield* serverSettings.getSettings).voice.elevenLabsApiKey, "");
    }).pipe(Effect.provide(layer));
  });

  it.effect("moves a hand-edited ElevenLabs key into the secret store when settings load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"voice":{"provider":"elevenlabs","elevenLabsVoiceId":"v","elevenLabsApiKey":"hand-key"}}',
      );

      const loaded = yield* serverSettings.getSettings;

      assert.equal(loaded.voice.elevenLabsApiKey, "hand-key");
      assert.notInclude(yield* fileSystem.readFileString(serverConfig.settingsPath), "hand-key");
      assert.isTrue(Option.isSome(yield* secrets.get("elevenlabs-voice-api-key")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("drops a saved hub key when the hub URL moves to another origin", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const hubId = UsageLimitSourceId.make("hub");
      const hub = {
        kind: "cliproxy",
        url: "http://127.0.0.1:8317",
        managementKey: "hub-management-key",
        enabled: true,
      } as const;

      const saved = yield* serverSettings.updateSettings({ usageLimitSources: { [hubId]: hub } });
      assert.equal(saved.usageLimitSources[hubId]?.managementKey, "hub-management-key");
      const forClient =
        ServerSettingsModule.redactServerSettingsForClient(saved).usageLimitSources[hubId]!;
      assert.notInclude(forClient.managementKey, "hub-management-key");

      // Echoing the redacted key back for the same origin keeps it.
      const samePath = yield* serverSettings.updateSettings({
        usageLimitSources: { [hubId]: { ...forClient, url: "http://127.0.0.1:8317/" } },
      });
      assert.equal(samePath.usageLimitSources[hubId]?.managementKey, "hub-management-key");

      // Pointing the source elsewhere must not carry the key to the new host.
      const moved = yield* serverSettings.updateSettings({
        usageLimitSources: { [hubId]: { ...forClient, url: "https://elsewhere.example.com" } },
      });
      assert.equal(moved.usageLimitSources[hubId]?.url, "https://elsewhere.example.com");
      assert.equal(moved.usageLimitSources[hubId]?.managementKey, "");
      assert.isTrue(
        Option.isNone(
          yield* secrets.get(`usage-limit-source-${Buffer.from("hub").toString("base64url")}`),
        ),
      );
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "keeps GitHub tokens per host in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          github: { tokens: { "GitHub.com": "ghp_dotcom", "ghe.acme.test": "ghp_ghe" } },
        });
        assert.deepEqual(saved.github.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "ghp_dotcom");
        assert.notInclude(raw, "ghp_ghe");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).github;
        assert.notInclude(forClient.tokens["github.com"]!, "ghp_dotcom");
        assert.isAbove(forClient.tokens["github.com"]!.length, 0);

        // Echoing the redacted values back keeps them; host and account changes leave tokens alone.
        yield* serverSettings.updateSettings({ github: { tokens: forClient.tokens } });
        yield* serverSettings.updateSettings({
          github: { hosts: { "github.com": { enabled: true, account: "work" } } },
        });
        assert.deepEqual((yield* serverSettings.getSettings).github.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });

        // An empty token removes that host's token and nothing else.
        const cleared = yield* serverSettings.updateSettings({
          github: { tokens: { "github.com": "" } },
        });
        assert.equal(cleared.github.tokens["github.com"] ?? "", "");
        assert.equal(cleared.github.tokens["ghe.acme.test"], "ghp_ghe");
        const remaining = yield* Effect.forEach(["github.com", "ghe.acme.test"], (host) =>
          secrets.get(`github-token-${Buffer.from(host, "utf8").toString("base64url")}`),
        );
        assert.isTrue(Option.isNone(remaining[0]!));
        assert.isTrue(Option.isSome(remaining[1]!));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("removes a Bitbucket secret once its token is cleared by hand in settings.json", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // A token was saved, then the user deleted it from settings.json directly.
      yield* secrets.set("bitbucket-access-token", new TextEncoder().encode("stale-token"));
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      yield* serverSettings.updateSettings({ cursorKeychainUsageEnabled: true });

      assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("moves a hand-edited Bitbucket token into the secret store when settings load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"bitbucket":{"accessToken":"hand-edited-token"}}',
      );

      // Loading alone moves it: no settings update is needed.
      const loaded = yield* serverSettings.getSettings;

      assert.equal(loaded.bitbucket.accessToken, "hand-edited-token");
      assert.notInclude(
        yield* fileSystem.readFileString(serverConfig.settingsPath),
        "hand-edited-token",
      );
      const stored = yield* secrets.get("bitbucket-access-token");
      assert.equal(
        Option.isSome(stored) ? new TextDecoder().decode(stored.value) : null,
        "hand-edited-token",
      );
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "moves a hand-edited Bitbucket token into the secret store when a client echoes the marker",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          '{"bitbucket":{"email":"me@example.com","apiToken":"hand-edited-token"}}',
        );

        // The form resends the redacted token when only the email changes.
        const forClient = ServerSettingsModule.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        ).bitbucket;
        const updated = yield* serverSettings.updateSettings({
          bitbucket: { email: "new@example.com", apiToken: forClient.apiToken },
        });

        assert.equal(updated.bitbucket.apiToken, "hand-edited-token");
        assert.equal((yield* serverSettings.getSettings).bitbucket.apiToken, "hand-edited-token");
        assert.notInclude(
          yield* fileSystem.readFileString(serverConfig.settingsPath),
          "hand-edited-token",
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("materializes provider secrets for terminal environment resolution", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("codex_terminal");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-terminal-secret", sensitive: true },
            ],
            config: { homePath: "~/.codex-terminal" },
          },
        },
      });

      const environment = yield* resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: instanceId,
        env: undefined,
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);

      assert.equal(environment.OPENROUTER_API_KEY, "sk-terminal-secret");
      assert.match(environment.CODEX_HOME ?? "", /[\\/][.]codex-terminal$/);
      assert.notInclude(persisted, "sk-terminal-secret");
      assert.include(persisted, '"valueRedacted": true');
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("rolls back provider secret changes when the settings file commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failRename = false;
      let settingsPathToFail: string | undefined;
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "Forced settings write failure.",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (fromPath, toPath) =>
          failRename && toPath === settingsPathToFail
            ? Effect.fail(writeFailure)
            : fileSystem.rename(fromPath, toPath),
      });
      const instanceId = ProviderInstanceId.make("codex_write_failure");
      const layerSettings = layerServerSettings().pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
      );

      yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        settingsPathToFail = (yield* ServerConfig.ServerConfig).settingsPath;
        yield* serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
            config: {},
          },
        });

        failRename = true;
        const failedUpdate = yield* serverSettings
          .updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
              config: {},
            },
          })
          .pipe(Effect.result);
        assert.equal(failedUpdate._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );

        const failed = yield* serverSettings
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    }),
  );

  it.effect.each(["response materialization", "partially committed write"] as const)(
    "rolls back provider secret changes after %s fails",
    (failure) => {
      const textDecoder = new TextDecoder();
      const secrets = new Map<string, Uint8Array>();
      let rejectNewSecret = false;
      const layerSecretStore = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.suspend(() => {
              const value = secrets.get(name);
              if (
                failure === "response materialization" &&
                rejectNewSecret &&
                value !== undefined &&
                textDecoder.decode(value) === "sk-new"
              ) {
                return Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: `secret ${name}`,
                    cause: "Forced response materialization failure.",
                  }),
                );
              }
              return Effect.succeed(
                value === undefined ? Option.none() : Option.some(Uint8Array.from(value)),
              );
            }),
          set: (name, value) =>
            Effect.suspend(() => {
              secrets.set(name, Uint8Array.from(value));
              return failure === "partially committed write" &&
                rejectNewSecret &&
                textDecoder.decode(value) === "sk-new"
                ? Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: `secret ${name}`,
                      cause: "chmod failed after rename",
                    }),
                  )
                : Effect.void;
            }),
          create: (name, value) =>
            Effect.sync(() => {
              secrets.set(name, Uint8Array.from(value));
            }),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const value = secrets.get(name) ?? new Uint8Array(bytes);
              secrets.set(name, value);
              return Uint8Array.from(value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              secrets.delete(name);
            }),
        }),
      );
      const layerSettings = ServerSettingsModule.layer.pipe(
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(layerSecretStore),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "studio-server-settings-materialization-failure-test-",
            }),
          ),
        ),
      );
      const instanceId = ProviderInstanceId.make("codex_materialization_failure");

      return Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: {},
            },
          },
        });

        rejectNewSecret = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: {},
              },
            },
          })
          .pipe(Effect.result);

        assert.equal(failedUpdate._tag, "Failure");
        rejectNewSecret = false;
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    },
  );

  it.effect("folds legacy project overrides into projectSettingsOverrides once", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacyProject = ProjectId.make("project-legacy");
      const scriptedProject = ProjectId.make("project-scripted");
      const script: ProjectScript = {
        id: "check",
        name: "Check",
        command: "npm test",
        icon: "play",
        runOnWorktreeCreate: false,
      };
      const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
      const modelJson = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
      const scriptsJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(ProjectScript)),
      )([script]);
      for (const [projectId, modelColumn, envMode, autoPull, scripts] of [
        // The legacy project also carries aggregate scripts, but its stored
        // null override reset them; the fold must not bring them back.
        [legacyProject, modelJson, "worktree", 1, scriptsJson],
        [scriptedProject, null, null, 0, scriptsJson],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${modelColumn},
            ${envMode}, ${autoPull}, ${scripts},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{"projectSettingsSimplified":true,"projectAgentBrowserAccessOverrides":{"${legacyProject}":false},"projectAutoPullOverrides":{"${scriptedProject}":true},"projectScriptOverrides":{"${legacyProject}":null}}`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.projectSettingsFolded);
      assert.deepEqual<ServerSettings["projectSettingsOverrides"]>(
        settings.projectSettingsOverrides,
        {
          [legacyProject]: {
            enableAgentBrowserAccess: false,
            defaultModelSelection: model,
            defaultThreadEnvMode: "worktree",
            defaultAutoPull: true,
          },
          [scriptedProject]: { defaultAutoPull: true, defaultProjectScripts: [script] },
        },
      );
      // Derived legacy views keep older clients reading the same values.
      assert.deepEqual<ServerSettings["projectAutoPullOverrides"]>(
        settings.projectAutoPullOverrides,
        {
          [legacyProject]: true,
          [scriptedProject]: true,
        },
      );
      assert.deepEqual<ServerSettings["projectScriptOverrides"]>(settings.projectScriptOverrides, {
        [scriptedProject]: [script],
      });

      // A reset survives the next load: the fold does not run again.
      yield* serverSettings.updateSettings({
        projectSettingsOverrides: { [legacyProject]: null },
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodeServerSettings(JSON.parse(raw));
      assert.isTrue(persisted.projectSettingsFolded);
      assert.isUndefined(persisted.projectSettingsOverrides[legacyProject]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("simplifies project overrides once settings are global", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      for (const projectId of ["alpha", "beta"]) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${"[]"},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          projectSettingsFolded: true,
          providerLimitAction: "switch",
          projectSettingsOverrides: {
            alpha: { providerLimitAction: "ask", defaultThreadEnvMode: "local" },
            beta: { providerLimitAction: "switch", defaultThreadEnvMode: "local" },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.projectSettingsSimplified);
      assert.equal(settings.defaultThreadEnvMode, "local");
      assert.equal(settings.providerLimitAction, "switch");
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("alpha")]: { providerLimitAction: "ask" },
      });
      const persisted = yield* decodeServerSettings(
        JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath)),
      );
      assert.isTrue(persisted.projectSettingsSimplified);
      assert.deepEqual(persisted.projectSettingsOverrides, settings.projectSettingsOverrides);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("leaves an unreadable settings.json untouched instead of folding over it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at
        )
        VALUES (
          ${"project-broken"}, ${"Project"}, ${"/tmp/project-broken"}, ${1}, ${"[]"},
          ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
        )
      `;
      const broken = '{"defaultAutoPull": tru';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, broken);

      const settings = yield* serverSettings.getSettings;
      assert.isFalse(settings.projectSettingsFolded);
      assert.deepEqual(settings.projectSettingsOverrides, {});
      // The user's file is still there to repair; nothing was written over it.
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), broken);
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("redacts every provider password field the settings form knows about", () =>
    Effect.sync(() => {
      for (const driver of BUILT_IN_DRIVERS) {
        const schema = driver.configSchema as unknown as { readonly fields?: Schema.Struct.Fields };
        const expected = schema.fields
          ? providerSettingsPasswordKeys({ fields: schema.fields })
          : [];
        assert.deepEqual(
          ServerSettingsModule.PROVIDER_SETTINGS_SECRET_KEYS[driver.driverKind] ?? [],
          expected,
          driver.driverKind,
        );
      }
      assert.deepEqual(ServerSettingsModule.PROVIDER_SETTINGS_SECRET_KEYS.antigravity, ["apiKey"]);
      assert.deepEqual(ServerSettingsModule.PROVIDER_SETTINGS_SECRET_KEYS.opencode, [
        "serverPassword",
      ]);
    }),
  );

  it.effect("never sends provider API keys or passwords to clients and keeps them on echo", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const geminiId = ProviderInstanceId.make("antigravity_work");
      const opencodeId = ProviderInstanceId.make("opencode_remote");
      const saved = yield* serverSettings.updateSettings({
        providers: {
          antigravity: { apiKey: "legacy-gemini-key", gcpProject: "legacy-project" },
          opencode: { serverPassword: "legacy-oc-pass" },
        },
        providerInstances: {
          [geminiId]: {
            driver: ProviderDriverKind.make("antigravity"),
            config: { apiKey: "instance-gemini-key", gcpProject: "work-project" },
          },
          [opencodeId]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "instance-oc-pass" },
          },
        },
      });

      const forClient = ServerSettingsModule.redactServerSettingsForClient(saved);
      const wire = JSON.stringify(forClient);
      for (const secret of [
        "legacy-gemini-key",
        "legacy-oc-pass",
        "instance-gemini-key",
        "instance-oc-pass",
      ]) {
        assert.notInclude(wire, secret);
      }
      assert.equal(forClient.providers.antigravity.apiKey, REDACTED_SECRET_MARKER);
      assert.equal(forClient.providers.antigravity.gcpProject, "legacy-project");
      assert.equal(forClient.providers.opencode.serverPassword, REDACTED_SECRET_MARKER);
      assert.deepEqual(forClient.providerInstances[geminiId]?.config, {
        apiKey: REDACTED_SECRET_MARKER,
        gcpProject: "work-project",
      });
      assert.deepEqual(forClient.providerInstances[opencodeId]?.config, {
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: REDACTED_SECRET_MARKER,
      });
      // An empty secret stays empty, so clients can tell "not set" from "set".
      assert.equal(
        ServerSettingsModule.redactServerSettingsForClient(DEFAULT_SERVER_SETTINGS).providers
          .antigravity.apiKey,
        "",
      );

      // A client saving from its redacted copy keeps every stored secret.
      yield* serverSettings.updateSettings({
        providers: forClient.providers,
        providerInstances: {
          ...forClient.providerInstances,
          [geminiId]: {
            ...forClient.providerInstances[geminiId]!,
            config: { apiKey: REDACTED_SECRET_MARKER, gcpProject: "renamed-project" },
          },
        },
      });
      const kept = yield* serverSettings.getSettings;
      assert.equal(kept.providers.antigravity.apiKey, "legacy-gemini-key");
      assert.equal(kept.providers.opencode.serverPassword, "legacy-oc-pass");
      assert.deepEqual(kept.providerInstances[geminiId]?.config, {
        apiKey: "instance-gemini-key",
        gcpProject: "renamed-project",
      });
      assert.deepEqual(kept.providerInstances[opencodeId]?.config, {
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "instance-oc-pass",
      });

      // A new value replaces the stored one; an omitted or empty one clears it.
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: geminiId,
        instance: {
          driver: ProviderDriverKind.make("antigravity"),
          config: { apiKey: "rotated-gemini-key", gcpProject: "renamed-project" },
        },
      });
      assert.equal(
        readApiKey((yield* serverSettings.getSettings).providerInstances[geminiId]?.config),
        "rotated-gemini-key",
      );
      const cleared = yield* serverSettings.updateSettings({
        providers: { opencode: { serverPassword: "" } },
        providerInstances: {
          ...forClient.providerInstances,
          [opencodeId]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverUrl: "http://127.0.0.1:4096" },
          },
        },
      });
      assert.equal(cleared.providers.opencode.serverPassword, "");
      assert.deepEqual(cleared.providerInstances[opencodeId]?.config, {
        serverUrl: "http://127.0.0.1:4096",
      });
      // The marker restores the current stored key, not the one the client last saw.
      assert.equal(readApiKey(cleared.providerInstances[geminiId]?.config), "rotated-gemini-key");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps a legacy provider key when its default instance is first edited", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const saved = yield* serverSettings.updateSettings({
        providers: { antigravity: { apiKey: "legacy-gemini-key", gcpProject: "p" } },
      });
      const forClient = ServerSettingsModule.redactServerSettingsForClient(saved);
      const defaultId = ProviderInstanceId.make("antigravity");
      // The web moves the default instance's config into `providerInstances`
      // and resets the legacy entry in the same save.
      const next = yield* serverSettings.updateProviderInstance(
        {
          operation: "upsert",
          instanceId: defaultId,
          instance: {
            driver: ProviderDriverKind.make("antigravity"),
            config: { ...forClient.providers.antigravity, gcpProject: "edited" },
          },
        },
        {
          providers: {
            ...forClient.providers,
            antigravity: DEFAULT_SERVER_SETTINGS.providers.antigravity,
          },
        },
      );
      const config = next.providerInstances[defaultId]?.config as {
        readonly apiKey?: string;
        readonly gcpProject?: string;
      };
      assert.equal(config.apiKey, "legacy-gemini-key");
      assert.equal(config.gcpProject, "edited");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("removes the stored sign-in of a deleted Cursor or Codex instance", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const signIn = new TextEncoder().encode("{}");
      const cursorId = ProviderInstanceId.make("cursor_work");
      const codexId = ProviderInstanceId.make("codex_personal");
      for (const [driver, instanceId] of [
        ["cursor", cursorId],
        ["codex", codexId],
        ["codex", ProviderInstanceId.make("codex")],
      ] as const) {
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId,
          instance: { driver: ProviderDriverKind.make(driver), config: {} },
        });
      }
      const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
      const codexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
      const codexRegistration = yield* ProviderCredentialStore.make(
        "codex-chatgpt-registration",
        codexId,
      );
      const defaultCodexStore = yield* ProviderCredentialStore.make("codex-chatgpt", "codex");
      for (const store of [cursorStore, codexStore, codexRegistration, defaultCodexStore]) {
        yield* store.set(signIn);
      }

      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: codexId });
      // Resetting the built-in default removes its entry but not the provider.
      yield* serverSettings.updateProviderInstance({
        operation: "remove",
        instanceId: ProviderInstanceId.make("codex"),
      });

      assert.isTrue(Option.isNone(yield* cursorStore.get));
      assert.isTrue(Option.isNone(yield* codexStore.get));
      assert.isTrue(Option.isNone(yield* codexRegistration.get));
      assert.isTrue(Option.isSome(yield* defaultCodexStore.get));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
  it.effect("drops a stored provider password when its server moves to another origin", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("opencode_remote");
      const opencode = ProviderDriverKind.make("opencode");
      const readPassword = (config: unknown) =>
        (config as { readonly serverPassword?: string } | undefined)?.serverPassword;
      assert.deepEqual(ServerSettingsModule.PROVIDER_SETTINGS_SECRET_DESTINATION_KEYS.opencode, [
        "serverUrl",
      ]);
      yield* serverSettings.updateSettings({
        providers: {
          opencode: { serverUrl: "http://127.0.0.1:4096", serverPassword: "legacy-oc-pass" },
        },
        providerInstances: {
          [instanceId]: {
            driver: opencode,
            config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "instance-oc-pass" },
          },
        },
      });

      // Same origin, different path: the marker keeps the stored password.
      const samePlace = yield* serverSettings.updateSettings({
        providers: {
          opencode: { serverUrl: "http://127.0.0.1:4096/", serverPassword: REDACTED_SECRET_MARKER },
        },
        providerInstances: {
          [instanceId]: {
            driver: opencode,
            config: {
              serverUrl: "http://127.0.0.1:4096/api",
              serverPassword: REDACTED_SECRET_MARKER,
            },
          },
        },
      });
      assert.equal(samePlace.providers.opencode.serverPassword, "legacy-oc-pass");
      assert.equal(
        readPassword(samePlace.providerInstances[instanceId]?.config),
        "instance-oc-pass",
      );

      // A new origin with the marker, or with the password left out of a
      // partial `providers` patch, never carries the stored password along.
      const moved = yield* serverSettings.updateSettings({
        providers: { opencode: { serverUrl: "https://attacker.example" } },
        providerInstances: {
          [instanceId]: {
            driver: opencode,
            config: {
              serverUrl: "https://attacker.example",
              serverPassword: REDACTED_SECRET_MARKER,
            },
          },
        },
      });
      assert.equal(moved.providers.opencode.serverPassword, "");
      assert.isUndefined(readPassword(moved.providerInstances[instanceId]?.config));

      // A password typed together with the new address is saved.
      const retyped = yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: opencode,
          config: { serverUrl: "https://other.example", serverPassword: "new-oc-pass" },
        },
      });
      assert.equal(readPassword(retyped.providerInstances[instanceId]?.config), "new-oc-pass");

      // Typing the same password again with a new address keeps it: only the
      // marker or a value the caller left out is dropped.
      const sameTyped = yield* serverSettings.updateSettings({
        providers: {
          opencode: { serverUrl: "https://typed.example", serverPassword: "typed-oc-pass" },
        },
      });
      assert.equal(sameTyped.providers.opencode.serverPassword, "typed-oc-pass");
      const movedTyped = yield* serverSettings.updateSettings({
        providers: {
          opencode: { serverUrl: "https://typed-again.example", serverPassword: "typed-oc-pass" },
        },
        providerInstances: {
          [instanceId]: {
            driver: opencode,
            config: { serverUrl: "https://third.example", serverPassword: "new-oc-pass" },
          },
        },
      });
      assert.equal(movedTyped.providers.opencode.serverPassword, "typed-oc-pass");
      assert.equal(readPassword(movedTyped.providerInstances[instanceId]?.config), "new-oc-pass");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps a sign-in when a stale whole-map save drops its instance", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex_other_window");
      const cursorId = ProviderInstanceId.make("cursor_kept");
      const saved = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: { driver: ProviderDriverKind.make("codex"), config: {} },
          [cursorId]: { driver: ProviderDriverKind.make("cursor"), config: {} },
        },
      });
      const signIn = new TextEncoder().encode("{}");
      const dropped = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
      const kept = yield* ProviderCredentialStore.make("cursor", cursorId);
      for (const store of [dropped, kept]) yield* store.set(signIn);

      // A window that never saw `codexId` saves its full map without it.
      yield* serverSettings.updateSettings({
        providerInstances: { [cursorId]: saved.providerInstances[cursorId]! },
      });
      assert.isTrue(Option.isSome(yield* dropped.get));
      assert.isTrue(Option.isSome(yield* kept.get));

      // Restoring the dropped instance finds its sign-in where it was.
      yield* serverSettings.updateSettings({ providerInstances: saved.providerInstances });
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: codexId,
        instance: saved.providerInstances[codexId]!,
      });
      assert.isTrue(Option.isSome(yield* dropped.get));
      assert.isTrue(Option.isSome(yield* kept.get));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("keeps every sign-in when settings.json is briefly malformed or missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexId = ProviderInstanceId.make("codex_watched");
        const cursorId = ProviderInstanceId.make("cursor_watched");
        const geminiId = ProviderInstanceId.make("antigravity_watched");
        yield* serverSettings.updateSettings({
          providerInstances: {
            [codexId]: { driver: ProviderDriverKind.make("codex"), config: {} },
            [cursorId]: { driver: ProviderDriverKind.make("cursor"), config: {} },
            [geminiId]: { driver: ProviderDriverKind.make("antigravity"), config: {} },
          },
        });
        const signIn = new TextEncoder().encode("{}");
        const codexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
        const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
        for (const store of [codexStore, cursorStore]) yield* store.set(signIn);
        const { profile } = yield* resolveAntigravityInstanceDirectories(config.stateDir, geminiId);
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        const geminiCreds = path.join(profile, "oauth_creds.json");
        yield* fileSystem.writeFileString(geminiCreds, "{}");
        const valid = yield* fileSystem.readFileString(config.settingsPath);

        yield* serverSettings.start;
        const changes = yield* serverSettings.subscribeChanges;
        const hasInstances = (settings: ServerSettings) =>
          [codexId, cursorId, geminiId].every((id) => settings.providerInstances[id] !== undefined);
        const lacksInstances = (settings: ServerSettings) =>
          [codexId, cursorId, geminiId].every((id) => settings.providerInstances[id] === undefined);
        const expectSignedIn = Effect.gen(function* () {
          assert.isTrue(Option.isSome(yield* codexStore.get));
          assert.isTrue(Option.isSome(yield* cursorStore.get));
          assert.isTrue(yield* fileSystem.exists(geminiCreds));
        });

        // A typo makes the file unreadable, then the user fixes it.
        assert.isTrue(
          yield* changeFileUntil(changes, config.settingsPath, "{ broken", lacksInstances),
        );
        assert.isTrue(yield* changeFileUntil(changes, config.settingsPath, valid, hasInstances));
        yield* expectSignedIn;

        // A non-atomic replace or a restore from backup.
        assert.isTrue(
          yield* changeFileUntil(changes, config.settingsPath, undefined, lacksInstances),
        );
        assert.isTrue(yield* changeFileUntil(changes, config.settingsPath, valid, hasInstances));
        yield* expectSignedIn;

        // Saving again through the app keeps them too.
        yield* serverSettings.updateSettings({
          providerInstances: (yield* serverSettings.getSettings).providerInstances,
        });
        yield* expectSignedIn;
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("starts an explicitly removed and re-created instance signed out", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const signIn = new TextEncoder().encode("{}");
      const instances = {
        [ProviderInstanceId.make("codex_again")]: { driver: ProviderDriverKind.make("codex") },
        [ProviderInstanceId.make("cursor_again")]: { driver: ProviderDriverKind.make("cursor") },
        [ProviderInstanceId.make("antigravity_again")]: {
          driver: ProviderDriverKind.make("antigravity"),
        },
      };
      const codexStore = yield* ProviderCredentialStore.make(
        "codex-chatgpt",
        ProviderInstanceId.make("codex_again"),
      );
      const cursorStore = yield* ProviderCredentialStore.make(
        "cursor",
        ProviderInstanceId.make("cursor_again"),
      );
      const { profile } = yield* resolveAntigravityInstanceDirectories(
        stateDir,
        ProviderInstanceId.make("antigravity_again"),
      );
      for (const [id, instance] of Object.entries(instances)) {
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: ProviderInstanceId.make(id),
          instance: { ...instance, config: {} },
        });
      }
      for (const store of [codexStore, cursorStore]) yield* store.set(signIn);
      yield* fileSystem.makeDirectory(profile, { recursive: true });
      yield* fileSystem.writeFileString(path.join(profile, "oauth_creds.json"), "{}");

      for (const id of Object.keys(instances)) {
        yield* serverSettings.updateProviderInstance({
          operation: "remove",
          instanceId: ProviderInstanceId.make(id),
        });
      }
      for (const [id, instance] of Object.entries(instances)) {
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: ProviderInstanceId.make(id),
          instance: { ...instance, config: {} },
        });
      }

      assert.isTrue(Option.isNone(yield* codexStore.get));
      assert.isTrue(Option.isNone(yield* cursorStore.get));
      assert.isFalse(yield* fileSystem.exists(profile));
      // The registry clears once more just before it starts them.
      const blocked = yield* serverSettings.clearSignInsBeforeStart!(Object.keys(instances));
      assert.equal(blocked.size, 0);
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, SIGN_IN_TOMBSTONES_FILE)));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("clears a sign-in whose removal failed before its id is used again", () => {
    const { layer, removal } = layerServerSettingsWithFlakySecretRemoval();
    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
      const signIn = new TextEncoder().encode("{}");
      const codexId = ProviderInstanceId.make("codex_flaky");
      const cursorId = ProviderInstanceId.make("cursor_flaky");
      const codex = { driver: ProviderDriverKind.make("codex"), config: {} };
      const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
      yield* serverSettings.updateSettings({
        providerInstances: { [codexId]: codex, [cursorId]: cursor },
      });
      const codexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
      const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
      for (const store of [codexStore, cursorStore]) yield* store.set(signIn);

      removal.failing = true;
      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: codexId });
      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
      assert.isTrue(Option.isSome(yield* codexStore.get));
      assert.isTrue(Option.isSome(yield* cursorStore.get));
      assert.include(yield* fileSystem.readFileString(tombstones), "codex_flaky");

      // While the leftover cannot be cleared, the id cannot be used again.
      const blocked = yield* serverSettings
        .updateProviderInstance({ operation: "create", instanceId: cursorId, instance: cursor })
        .pipe(Effect.flip);
      assert.equal(blocked.operation, "remove-secret");
      assert.isUndefined((yield* serverSettings.getSettings).providerInstances[cursorId]);

      removal.failing = false;
      yield* serverSettings.updateProviderInstance({
        operation: "create",
        instanceId: cursorId,
        instance: cursor,
      });
      // A whole-map write that adds the id clears it the same way.
      yield* serverSettings.updateSettings({
        providerInstances: {
          ...(yield* serverSettings.getSettings).providerInstances,
          [codexId]: codex,
        },
      });
      assert.isTrue(Option.isNone(yield* codexStore.get));
      assert.isTrue(Option.isNone(yield* cursorStore.get));
      yield* serverSettings.clearSignInsBeforeStart!([codexId, cursorId]);
      assert.isFalse(yield* fileSystem.exists(tombstones));

      // A sign-in made after the instance is back survives later saves.
      for (const store of [codexStore, cursorStore]) yield* store.set(signIn);
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: codexId,
        instance: { ...codex, displayName: "Renamed" },
      });
      assert.isTrue(Option.isSome(yield* codexStore.get));
      assert.isTrue(Option.isSome(yield* cursorStore.get));
    }).pipe(Effect.provide(layer));
  });

  it.effect("never restores a password into an instance that did not hold it", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const readSecret = (config: unknown, key: string) =>
        (config as Record<string, unknown> | undefined)?.[key];
      const switchedId = ProviderInstanceId.make("switching_driver");
      yield* serverSettings.updateSettings({
        providers: {
          antigravity: { apiKey: "legacy-gemini-key" },
          opencode: { serverPassword: "legacy-oc-pass" },
        },
        providerInstances: {
          [switchedId]: {
            driver: ProviderDriverKind.make("antigravity"),
            config: { apiKey: "instance-gemini-key" },
          },
        },
      });
      const saved = yield* serverSettings.updateSettings({
        providerInstances: {
          // A brand-new id has nothing stored to keep.
          [ProviderInstanceId.make("opencode_new")]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverPassword: REDACTED_SECRET_MARKER },
          },
          // Changing driver starts from nothing, even when the marker comes back.
          [switchedId]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverPassword: REDACTED_SECRET_MARKER, apiKey: REDACTED_SECRET_MARKER },
          },
          // Only an id equal to its own driver reads the legacy entry.
          [ProviderInstanceId.make("antigravity")]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverPassword: REDACTED_SECRET_MARKER },
          },
        },
      });
      for (const id of ["opencode_new", "switching_driver", "antigravity"]) {
        const config = saved.providerInstances[ProviderInstanceId.make(id)]?.config;
        assert.isUndefined(readSecret(config, "serverPassword"), id);
        assert.notInclude(JSON.stringify(config), "legacy-");
        assert.notInclude(JSON.stringify(config), "instance-gemini-key");
      }
      assert.equal(saved.providers.antigravity.apiKey, "legacy-gemini-key");
      assert.equal(saved.providers.opencode.serverPassword, "legacy-oc-pass");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("removes a deleted Antigravity instance's Google sign-in profile", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workId = ProviderInstanceId.make("antigravity_work");
      const defaultId = ProviderInstanceId.make("antigravity");
      const driver = ProviderDriverKind.make("antigravity");
      yield* serverSettings.updateSettings({
        providerInstances: {
          [workId]: { driver, config: {} },
          [defaultId]: { driver, config: {} },
        },
      });
      const profiles = [];
      for (const id of [workId, defaultId]) {
        const { profile } = yield* resolveAntigravityInstanceDirectories(stateDir, id);
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* fileSystem.writeFileString(path.join(profile, "oauth_creds.json"), "{}");
        profiles.push(profile);
      }

      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: workId });
      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: defaultId });

      assert.isFalse(yield* fileSystem.exists(profiles[0]!));
      assert.isTrue(yield* fileSystem.exists(path.join(profiles[1]!, "oauth_creds.json")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("keeps a live instance's sign-in when a leftover tombstone names it", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
      const signIn = new TextEncoder().encode("{}");
      const cursorId = ProviderInstanceId.make("cursor_live");
      const codexId = ProviderInstanceId.make("codex_live");
      const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
      const codex = { driver: ProviderDriverKind.make("codex"), config: {} };
      yield* serverSettings.updateSettings({
        providerInstances: { [cursorId]: cursor, [codexId]: codex },
      });
      const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
      const codexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
      for (const store of [cursorStore, codexStore]) yield* store.set(signIn);
      const leftover = JSON.stringify({
        [cursorId]: [{ driver: "cursor" }],
        [codexId]: [{ driver: "codex" }],
      });

      // A remove interrupted after recording its tombstone, or a failed save
      // that could not drop it, leaves a tombstone beside the live instance.
      yield* fileSystem.writeFileString(tombstones, leftover);
      // An ordinary edit naming the instance keeps its sign-in.
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: cursorId,
        instance: { ...cursor, displayName: "Renamed" },
      });
      assert.isTrue(Option.isSome(yield* cursorStore.get));
      assert.isTrue(Option.isSome(yield* codexStore.get));
      assert.isFalse(yield* fileSystem.exists(tombstones));

      // The cleanup after a registry reconcile drops it the same way.
      yield* fileSystem.writeFileString(tombstones, leftover);
      yield* serverSettings.clearRemovedInstanceSignIns!([]);
      assert.isTrue(Option.isSome(yield* cursorStore.get));
      assert.isTrue(Option.isSome(yield* codexStore.get));
      assert.isFalse(yield* fileSystem.exists(tombstones));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("handles drivers and ids named like Object.prototype members", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
      const signIn = new TextEncoder().encode("{}");
      const instances = [
        ["constructor_agent", "constructor"],
        ["to_string_agent", "toString"],
        ["has_own_agent", "hasOwnProperty"],
        // Ids too: tombstones are keyed by instance id.
        ["constructor", "cursor"],
        ["toString", "codex"],
      ] as const;
      for (const [id, driver] of instances) {
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: ProviderInstanceId.make(id),
          instance: {
            driver: ProviderDriverKind.make(driver),
            config: { token: `${id}-secret`, count: 1 },
          },
        });
      }
      const cursorStore = yield* ProviderCredentialStore.make(
        "cursor",
        ProviderInstanceId.make("constructor"),
      );
      const codexStore = yield* ProviderCredentialStore.make(
        "codex-chatgpt",
        ProviderInstanceId.make("toString"),
      );
      for (const store of [cursorStore, codexStore]) yield* store.set(signIn);

      // A driver this build does not know has every string field withheld.
      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* serverSettings.getSettings,
      );
      for (const [id] of instances.slice(0, 3)) {
        assert.deepEqual(forClient.providerInstances[ProviderInstanceId.make(id)]?.config, {
          token: REDACTED_SECRET_MARKER,
          count: 1,
        });
        assert.notInclude(JSON.stringify(forClient), `${id}-secret`);
      }
      // Saving the client copy restores each withheld value.
      yield* serverSettings.updateSettings({ providerInstances: forClient.providerInstances });
      const restored = yield* serverSettings.getSettings;
      for (const [id] of instances) {
        assert.deepEqual(restored.providerInstances[ProviderInstanceId.make(id)]?.config, {
          token: `${id}-secret`,
          count: 1,
        });
      }

      for (const [id] of instances) {
        yield* serverSettings.updateProviderInstance({
          operation: "remove",
          instanceId: ProviderInstanceId.make(id),
        });
      }
      assert.isTrue(Option.isNone(yield* cursorStore.get));
      assert.isTrue(Option.isNone(yield* codexStore.get));
      yield* serverSettings.clearRemovedInstanceSignIns!([]);
      assert.isFalse(yield* fileSystem.exists(tombstones));
      assert.deepEqual((yield* serverSettings.getSettings).providerInstances, {});
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("serves settings.json entries whose driver is named like a prototype member", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providerInstances: {
            odd_one: { driver: "toString", config: { apiKey: "hand-edited-key" } },
            odd_two: { driver: "constructor", config: { serverUrl: "http://127.0.0.1:1" } },
          },
        }),
      );
      const settings = yield* serverSettings.getSettings;
      const forClient = ServerSettingsModule.redactServerSettingsForClient(settings);
      assert.notInclude(JSON.stringify(forClient), "hand-edited-key");
      assert.deepEqual(forClient.providerInstances[ProviderInstanceId.make("odd_one")]?.config, {
        apiKey: REDACTED_SECRET_MARKER,
      });
      // An unrelated save through the app keeps them as they are on disk.
      yield* serverSettings.updateSettings({ providerInstances: forClient.providerInstances });
      assert.deepEqual(
        (yield* serverSettings.getSettings).providerInstances[ProviderInstanceId.make("odd_two")]
          ?.config,
        { serverUrl: "http://127.0.0.1:1" },
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("deletes a removed instance's sign-in again once its driver is disposed", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
      const signIn = new TextEncoder().encode("{}");
      const cursorId = ProviderInstanceId.make("cursor_late");
      const codexId = ProviderInstanceId.make("codex_late");
      const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
      const codex = { driver: ProviderDriverKind.make("codex"), config: {} };
      yield* serverSettings.updateSettings({
        providerInstances: { [cursorId]: cursor, [codexId]: codex },
      });
      const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
      const codexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
      for (const store of [cursorStore, codexStore]) yield* store.set(signIn);

      for (const instanceId of [cursorId, codexId]) {
        yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId });
      }
      assert.isTrue(Option.isNone(yield* cursorStore.get));
      assert.isTrue(Option.isNone(yield* codexStore.get));
      // Their drivers still run, so the tombstones stay.
      const kept = yield* fileSystem.readFileString(tombstones);
      assert.include(kept, "cursor_late");
      assert.include(kept, "codex_late");

      // Before disposal a driver writes back: a token refresh or OAuth completion.
      for (const store of [cursorStore, codexStore]) yield* store.set(signIn);
      // The registry has disposed Codex but still runs Cursor.
      yield* serverSettings.clearRemovedInstanceSignIns!([cursorId]);
      assert.isTrue(Option.isNone(yield* codexStore.get));
      assert.isTrue(Option.isSome(yield* cursorStore.get));
      const pending = yield* fileSystem.readFileString(tombstones);
      assert.include(pending, "cursor_late");
      assert.notInclude(pending, "codex_late");

      // Creating the id again before that disposal still starts signed out.
      yield* serverSettings.updateProviderInstance({
        operation: "create",
        instanceId: cursorId,
        instance: cursor,
      });
      assert.isTrue(Option.isNone(yield* cursorStore.get));
      // The old driver, disposed only now, writes once more; the registry
      // clears it before starting the new instance.
      yield* cursorStore.set(signIn);
      yield* serverSettings.clearRemovedInstanceSignIns!([]);
      assert.isTrue(Option.isSome(yield* cursorStore.get));
      yield* serverSettings.clearSignInsBeforeStart!([cursorId]);
      assert.isTrue(Option.isNone(yield* cursorStore.get));
      assert.isFalse(yield* fileSystem.exists(tombstones));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("clears a sign-in the registry's driver writes while it is disposed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
        const signIn = new TextEncoder().encode("{}");
        const cursorId = ProviderInstanceId.make("cursor_disposing");
        const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
        const lateWrite = yield* Deferred.make<void>();
        // Stands in for the registry: disposing the removed instance's driver
        // writes its token back, as a refresh finishing during shutdown would.
        const mutator = ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator.of({
          reconcile: (configMap) =>
            Object.hasOwn(configMap, cursorId)
              ? Effect.void
              : Effect.gen(function* () {
                  if (yield* Deferred.isDone(lateWrite)) return;
                  yield* cursorStore.set(signIn).pipe(Effect.orDie);
                  yield* Deferred.succeed(lateWrite, undefined);
                }),
        });
        yield* Layer.build(
          ProviderInstanceRegistryHydration.layerSettingsWatcher({}).pipe(
            Layer.provide(
              Layer.succeed(
                ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
                mutator,
              ),
            ),
            Layer.provide(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
          ),
        );

        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: { driver: ProviderDriverKind.make("cursor"), config: {} },
        });
        yield* cursorStore.set(signIn);
        yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
        yield* Deferred.await(lateWrite).pipe(Effect.timeout("10 seconds"));
        for (let attempt = 0; attempt < 100; attempt++) {
          if (!(yield* fileSystem.exists(tombstones))) break;
          yield* Effect.sleep("50 millis");
        }
        assert.isFalse(yield* fileSystem.exists(tombstones));
        assert.isTrue(Option.isNone(yield* cursorStore.get));
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("starts a re-created instance signed out when it was re-added during disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
        const oldAccount = new TextEncoder().encode("old");
        const newAccount = new TextEncoder().encode("new");
        const cursorId = ProviderInstanceId.make("cursor_work");
        const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
        const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
        const recreated = yield* Deferred.make<void>();
        const disposing = yield* Deferred.make<void>();
        const started = yield* Deferred.make<Option.Option<Uint8Array>>();
        const reconciles = yield* Ref.make(0);
        let running = false;
        // Stands in for the registry: disposing the removed instance takes
        // until after the user re-creates it, then writes its token back.
        const mutator = ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator.of({
          reconcile: (configMap) =>
            Effect.gen(function* () {
              yield* Ref.update(reconciles, (count) => count + 1);
              const wanted = Object.hasOwn(configMap, cursorId);
              if (running && !wanted) {
                yield* Deferred.succeed(disposing, undefined);
                yield* Deferred.await(recreated);
                yield* cursorStore.set(oldAccount).pipe(Effect.orDie);
              } else if (!running && wanted && (yield* Deferred.isDone(recreated))) {
                // What the new instance finds when it starts.
                yield* Deferred.succeed(started, yield* cursorStore.get.pipe(Effect.orDie));
              }
              running = wanted;
            }),
        });
        yield* Layer.build(
          ProviderInstanceRegistryHydration.layerSettingsWatcher({}).pipe(
            Layer.provide(
              Layer.succeed(
                ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
                mutator,
              ),
            ),
            Layer.provide(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
          ),
        );

        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: cursor,
        });
        yield* cursorStore.set(oldAccount);
        yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
        yield* Deferred.await(disposing).pipe(Effect.timeout("10 seconds"));
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: cursor,
        });
        yield* Deferred.succeed(recreated, undefined);

        const found = yield* Deferred.await(started).pipe(Effect.timeout("10 seconds"));
        assert.isTrue(Option.isNone(found));
        assert.isTrue(Option.isNone(yield* cursorStore.get));
        assert.isFalse(yield* fileSystem.exists(tombstones));

        // A sign-in made on the new instance survives later saves and cleanups.
        yield* cursorStore.set(newAccount);
        const seen = yield* Ref.get(reconciles);
        yield* serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: cursorId,
          instance: { ...cursor, displayName: "Renamed" },
        });
        for (let attempt = 0; attempt < 100 && (yield* Ref.get(reconciles)) === seen; attempt++) {
          yield* Effect.sleep("20 millis");
        }
        yield* serverSettings.clearRemovedInstanceSignIns!([cursorId]);
        yield* serverSettings.clearSignInsBeforeStart!([cursorId]);
        assert.deepEqual(
          Option.map(yield* cursorStore.get, (bytes) => new TextDecoder().decode(bytes)),
          Option.some("new"),
        );
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("stops a re-added instance still running from before and clears it once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
        const oldAccount = new TextEncoder().encode("old");
        const newAccount = new TextEncoder().encode("new");
        const cursorId = ProviderInstanceId.make("cursor_failed_stop");
        const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
        const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const started = yield* Deferred.make<Option.Option<Uint8Array>>();
        let running = false;
        let failNextStop = true;
        // Stands in for the registry: the reconcile that should stop the
        // removed instance fails, so it keeps running under its id.
        const mutator = ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator.of({
          reconcile: (configMap) =>
            Effect.gen(function* () {
              const wanted = Object.hasOwn(configMap, cursorId);
              if (running && !wanted) {
                if (failNextStop) {
                  failNextStop = false;
                  return yield* Effect.die(new Error("dispose failed"));
                }
                // The old driver writes its token back as it stops.
                yield* cursorStore.set(oldAccount).pipe(Effect.orDie);
                yield* Ref.update(events, (all) => [...all, "stop"]);
              } else if (!running && wanted) {
                yield* Ref.update(events, (all) => [...all, "start"]);
                if (!failNextStop) {
                  yield* Deferred.succeed(started, yield* cursorStore.get.pipe(Effect.orDie));
                }
              }
              running = wanted;
            }),
        });
        yield* Layer.build(
          ProviderInstanceRegistryHydration.layerSettingsWatcher({}).pipe(
            Layer.provide(
              Layer.succeed(
                ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
                mutator,
              ),
            ),
            Layer.provide(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
          ),
        );
        const settle = (count: number) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 200; attempt++) {
              if ((yield* Ref.get(events)).length >= count) return;
              yield* Effect.sleep("20 millis");
            }
          });

        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: cursor,
        });
        yield* settle(1);
        yield* cursorStore.set(oldAccount);
        yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
        // Give the failing reconcile time to run.
        for (let attempt = 0; attempt < 200 && failNextStop; attempt++) {
          yield* Effect.sleep("20 millis");
        }
        assert.isFalse(failNextStop);
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: cursor,
        });

        // The old generation is stopped, its token cleared, then the new one starts.
        const found = yield* Deferred.await(started).pipe(Effect.timeout("10 seconds"));
        assert.isTrue(Option.isNone(found));
        assert.deepEqual(yield* Ref.get(events), ["start", "stop", "start"]);
        assert.isFalse(yield* fileSystem.exists(tombstones));

        // A sign-in made in the new instance survives the next boot's clear.
        yield* cursorStore.set(newAccount);
        yield* serverSettings.clearSignInsBeforeStart!([cursorId]);
        assert.deepEqual(
          Option.map(yield* cursorStore.get, (bytes) => new TextDecoder().decode(bytes)),
          Option.some("new"),
        );
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "starts a not-yet-running re-added id only after its clear while restarting another",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
          const oldAccount = new TextEncoder().encode("old");
          const runningId = ProviderInstanceId.make("cursor_still_running");
          const newId = ProviderInstanceId.make("cursor_not_running");
          const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
          const stores = {
            [runningId]: yield* ProviderCredentialStore.make("cursor", runningId),
            [newId]: yield* ProviderCredentialStore.make("cursor", newId),
          };
          const events = yield* Ref.make<ReadonlyArray<string>>([]);
          const running = new Set<string>([runningId]);
          // Stands in for the registry; records what each instance finds when it starts.
          const mutator = ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator.of({
            reconcile: (configMap) =>
              Effect.gen(function* () {
                for (const id of [runningId, newId]) {
                  const wanted = Object.hasOwn(configMap, id);
                  if (running.has(id) && !wanted) {
                    yield* Ref.update(events, (all) => [...all, `stop ${id}`]);
                  } else if (!running.has(id) && wanted) {
                    const found = yield* stores[id]!.get.pipe(Effect.orDie);
                    const state = Option.isSome(found) ? "signed in" : "signed out";
                    yield* Ref.update(events, (all) => [...all, `start ${id} ${state}`]);
                  }
                  if (wanted) running.add(id);
                  else running.delete(id);
                }
              }),
          });
          yield* serverSettings.updateSettings({ providerInstances: { [runningId]: cursor } });
          yield* Layer.build(
            ProviderInstanceRegistryHydration.layerSettingsWatcher({ [runningId]: cursor }).pipe(
              Layer.provide(
                Layer.succeed(
                  ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
                  mutator,
                ),
              ),
              Layer.provide(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
              ),
            ),
          );

          // Both ids re-added with an old sign-in still to delete; one still runs.
          yield* fileSystem.writeFileString(
            tombstones,
            JSON.stringify({
              [runningId]: [{ driver: "cursor", readded: true }],
              [newId]: [{ driver: "cursor", readded: true }],
            }),
          );
          for (const store of Object.values(stores)) yield* store.set(oldAccount);
          yield* serverSettings.updateSettings({
            providerInstances: { [runningId]: cursor, [newId]: cursor },
          });
          for (let attempt = 0; attempt < 200; attempt++) {
            if ((yield* Ref.get(events)).length >= 3) break;
            yield* Effect.sleep("20 millis");
          }
          assert.deepEqual(yield* Ref.get(events), [
            `stop ${runningId}`,
            `start ${runningId} signed out`,
            `start ${newId} signed out`,
          ]);
          assert.isFalse(yield* fileSystem.exists(tombstones));
        }),
      ).pipe(TestClock.withLive, Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("retries a start held back by a failed sign-in delete", () => {
    const { layer, removal } = layerServerSettingsWithFlakySecretRemoval();
    return Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
        const cursorId = ProviderInstanceId.make("cursor_retry");
        const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
        const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
        const reconciles = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const started = yield* Deferred.make<void>();
        const mutator = ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator.of({
          reconcile: (configMap) =>
            Effect.gen(function* () {
              yield* Ref.update(reconciles, (all) => [...all, Object.keys(configMap)]);
              if (Object.hasOwn(configMap, cursorId)) yield* Deferred.succeed(started, undefined);
            }),
        });
        yield* Layer.build(
          ProviderInstanceRegistryHydration.layerSettingsWatcher({}, new Set(), ["50 millis"]).pipe(
            Layer.provide(
              Layer.succeed(
                ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
                mutator,
              ),
            ),
            Layer.provide(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
          ),
        );

        // A re-added id whose old sign-in is still to be deleted, and the
        // secret store refuses that delete once.
        yield* fileSystem.writeFileString(
          tombstones,
          JSON.stringify({ [cursorId]: [{ driver: "cursor", readded: true }] }),
        );
        yield* cursorStore.set(new TextEncoder().encode("old"));
        removal.failing = true;
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: cursor,
        });
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((yield* Ref.get(reconciles)).length > 0) break;
          yield* Effect.sleep("20 millis");
        }
        const first = yield* Ref.get(reconciles);
        assert.equal(first.length, 1);
        assert.isFalse(first[0]!.includes(cursorId));
        removal.failing = false;

        // No further settings write: the retry starts it.
        yield* Deferred.await(started).pipe(Effect.timeout("10 seconds"));
        assert.isTrue(Option.isNone(yield* cursorStore.get));
        assert.isFalse(yield* fileSystem.exists(tombstones));
      }),
    ).pipe(TestClock.withLive, Effect.provide(layer));
  });

  it.effect("saves settings while the tombstone file cannot be read", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
      const cursorId = ProviderInstanceId.make("cursor_unreadable");
      const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
      // Reading a directory fails with EISDIR, like an unreadable file.
      yield* fileSystem.makeDirectory(tombstones, { recursive: true });

      yield* serverSettings.updateProviderInstance({
        operation: "create",
        instanceId: cursorId,
        instance: cursor,
      });
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: cursorId,
        instance: { ...cursor, displayName: "Renamed" },
      });
      assert.equal(
        (yield* serverSettings.getSettings).providerInstances[cursorId]?.displayName,
        "Renamed",
      );

      // An explicit remove still works: the tombstone cannot be recorded in
      // place of a directory, so the sign-in is deleted at once instead.
      const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
      yield* cursorStore.set(new TextEncoder().encode("{}"));
      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
      assert.isUndefined((yield* serverSettings.getSettings).providerInstances[cursorId]);
      assert.isTrue(Option.isNone(yield* cursorStore.get));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  // chmod 0o000 only sets the read-only flag on Windows; the file stays readable.
  it.effect.skipIf(process.platform === "win32")(
    "replaces an unreadable tombstone file when an instance is removed",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tombstones = path.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
        const cursorId = ProviderInstanceId.make("cursor_replaced");
        const cursor = { driver: ProviderDriverKind.make("cursor"), config: {} };
        yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId: cursorId,
          instance: cursor,
        });
        const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
        yield* cursorStore.set(new TextEncoder().encode("{}"));
        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(tombstones, "{}");
        yield* fileSystem.chmod(tombstones, 0o000);

        yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: cursorId });
        assert.isUndefined((yield* serverSettings.getSettings).providerInstances[cursorId]);
        assert.isTrue(Option.isNone(yield* cursorStore.get));
        // Replaced by a readable file holding this remove, so cleanup goes on as usual.
        assert.include(yield* fileSystem.readFileString(tombstones), "cursor_replaced");
        yield* serverSettings.clearRemovedInstanceSignIns!([]);
        assert.isFalse(yield* fileSystem.exists(tombstones));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("withholds every string a driver or field this build does not know", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const futureId = ProviderInstanceId.make("future_agent");
      const opencodeId = ProviderInstanceId.make("opencode_newer");
      const future = {
        driver: ProviderDriverKind.make("futureAgent"),
        config: {
          serverUrl: "https://agent.example",
          auth: { token: "nested-token", scopes: ["scope-secret"], retries: 2 },
          headers: [{ name: "Authorization", value: "Bearer array-token" }],
        },
      };
      const opencode = {
        driver: ProviderDriverKind.make("opencode"),
        config: {
          serverUrl: "http://127.0.0.1:4096",
          // A field a newer build added, unknown here.
          apiToken: "newer-build-token",
          extra: { refresh: "nested-newer-token" },
        },
      };
      yield* serverSettings.updateSettings({
        providerInstances: { [futureId]: future, [opencodeId]: opencode },
      });

      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* serverSettings.getSettings,
      );
      const wire = JSON.stringify(forClient);
      for (const secret of [
        "nested-token",
        "scope-secret",
        "array-token",
        "agent.example",
        "newer-build-token",
        "nested-newer-token",
      ]) {
        assert.notInclude(wire, secret);
      }
      const M = REDACTED_SECRET_MARKER;
      assert.deepEqual(forClient.providerInstances[futureId]?.config, {
        serverUrl: M,
        auth: { token: M, scopes: [M], retries: 2 },
        headers: [{ name: M, value: M }],
      });
      assert.deepEqual(forClient.providerInstances[opencodeId]?.config, {
        serverUrl: "http://127.0.0.1:4096",
        apiToken: M,
        extra: { refresh: M },
      });

      // Saving the client copy back restores every stored value in place.
      yield* serverSettings.updateSettings({ providerInstances: forClient.providerInstances });
      const kept = yield* serverSettings.getSettings;
      assert.deepEqual(kept.providerInstances[futureId]?.config, future.config);
      assert.deepEqual(kept.providerInstances[opencodeId]?.config, opencode.config);

      // An edited string the server cannot interpret (here the address the
      // token goes to) drops the markers rather than send old secrets along.
      const moved = yield* serverSettings.updateSettings({
        providerInstances: {
          ...forClient.providerInstances,
          [futureId]: {
            ...future,
            config: {
              ...(forClient.providerInstances[futureId]!.config as Record<string, unknown>),
              serverUrl: "https://attacker.example",
            },
          },
          [opencodeId]: {
            ...opencode,
            config: {
              ...(forClient.providerInstances[opencodeId]!.config as Record<string, unknown>),
              serverUrl: "https://attacker.example",
            },
          },
        },
      });
      assert.deepEqual(moved.providerInstances[futureId]?.config, {
        serverUrl: "https://attacker.example",
        auth: { scopes: [""], retries: 2 },
        headers: [{}],
      });
      assert.deepEqual(moved.providerInstances[opencodeId]?.config, {
        serverUrl: "https://attacker.example",
        extra: {},
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("withholds a config that is not an object, such as an array", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const arrayId = ProviderInstanceId.make("future_array");
      const stringId = ProviderInstanceId.make("future_string");
      const driver = ProviderDriverKind.make("futureAgent");
      const arrayConfig = ["Bearer array-config-token", { refresh: "nested-array-token" }, 3];
      yield* serverSettings.updateSettings({
        providerInstances: {
          [arrayId]: { driver, config: arrayConfig },
          [stringId]: { driver, config: "string-config-token" },
        },
      });

      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* serverSettings.getSettings,
      );
      const wire = JSON.stringify(forClient);
      for (const secret of ["array-config-token", "nested-array-token", "string-config-token"]) {
        assert.notInclude(wire, secret);
      }
      const M = REDACTED_SECRET_MARKER;
      assert.deepEqual(forClient.providerInstances[arrayId]?.config, [M, { refresh: M }, 3]);
      assert.equal(forClient.providerInstances[stringId]?.config, M);

      // Saved back unchanged, the stored values return.
      yield* serverSettings.updateSettings({ providerInstances: forClient.providerInstances });
      const kept = yield* serverSettings.getSettings;
      assert.deepEqual(kept.providerInstances[arrayId]?.config, arrayConfig);
      assert.equal(kept.providerInstances[stringId]?.config, "string-config-token");

      // An edited element drops the rest instead.
      const edited = yield* serverSettings.updateSettings({
        providerInstances: {
          ...forClient.providerInstances,
          [arrayId]: { driver, config: ["https://attacker.example", { refresh: M }, 3] },
        },
      });
      assert.deepEqual(edited.providerInstances[arrayId]?.config, [
        "https://attacker.example",
        {},
        3,
      ]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps Muse custom models readable and saves added ones", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const museId = ProviderInstanceId.make("muse_custom");
      const muse = {
        driver: ProviderDriverKind.make("muse"),
        config: { customModels: [{ slug: "muse-large", name: "Muse Large" }] },
      };
      yield* serverSettings.updateSettings({ providerInstances: { [museId]: muse } });
      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* serverSettings.getSettings,
      );
      const clientConfig = forClient.providerInstances[museId]!.config as {
        readonly customModels: ReadonlyArray<unknown>;
      };
      assert.deepEqual(clientConfig, muse.config);

      // The instance card adds one and saves the whole list back.
      const added = [...clientConfig.customModels, { slug: "muse-small", name: "Muse Small" }];
      const saved = yield* serverSettings.updateSettings({
        providerInstances: {
          ...forClient.providerInstances,
          [museId]: { ...muse, config: { ...clientConfig, customModels: added } },
        },
      });
      assert.deepEqual(saved.providerInstances[museId]?.config, { customModels: added });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "sends the Registry icon to clients and drops withheld values when any address moves",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const acpId = ProviderInstanceId.make("acp_kilo");
        const cursorId = ProviderInstanceId.make("cursor_work");
        const iconUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
        const acp = {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: "kilo", distribution: "auto", registryIconUrl: iconUrl },
        };
        const cursor = {
          driver: ProviderDriverKind.make("cursor"),
          config: {
            binaryPath: "cursor-agent",
            apiEndpoint: "https://api.cursor.example",
            // A field a newer build added, unknown here.
            sessionToken: "cursor-newer-token",
          },
        };
        // Cursor has no password field, yet its address still guards opaque keys.
        assert.deepEqual(ServerSettingsModule.PROVIDER_SETTINGS_SECRET_DESTINATION_KEYS.cursor, [
          "apiEndpoint",
        ]);
        yield* serverSettings.updateSettings({
          providerInstances: { [acpId]: acp, [cursorId]: cursor },
        });

        const forClient = ServerSettingsModule.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        assert.deepEqual(forClient.providerInstances[acpId]?.config, acp.config);
        assert.notInclude(JSON.stringify(forClient), "cursor-newer-token");
        const clientCursor = forClient.providerInstances[cursorId]!.config as Record<
          string,
          unknown
        >;
        assert.equal(clientCursor.sessionToken, REDACTED_SECRET_MARKER);

        // A changed binary path is an ordinary edit: the withheld value stays.
        const rebinned = yield* serverSettings.updateSettings({
          providerInstances: {
            ...forClient.providerInstances,
            [cursorId]: { ...cursor, config: { ...clientCursor, binaryPath: "/opt/cursor-agent" } },
          },
        });
        assert.deepEqual(rebinned.providerInstances[cursorId]?.config, {
          ...cursor.config,
          binaryPath: "/opt/cursor-agent",
        });

        // A moved known address drops it.
        const moved = yield* serverSettings.updateSettings({
          providerInstances: {
            ...forClient.providerInstances,
            [cursorId]: {
              ...cursor,
              config: { ...clientCursor, apiEndpoint: "https://attacker.example" },
            },
          },
        });
        assert.deepEqual(moved.providerInstances[cursorId]?.config, {
          binaryPath: "cursor-agent",
          apiEndpoint: "https://attacker.example",
        });
        assert.deepEqual(moved.providerInstances[acpId]?.config, acp.config);
      }).pipe(Effect.provide(layerServerSettings())),
  );
});
