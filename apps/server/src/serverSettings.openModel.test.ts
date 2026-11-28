import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import {
  buildOpenModelEnvironment,
  openModelPresetById,
} from "@specweave-studio/shared/openModelPresets";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

// As in serverSettings.test.ts: a fresh temporary state folder and an in-memory database.
const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "studio-server-settings-open-model-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("open-model preset keys in settings", (it) => {
  it.effect("keeps a preset's key out of settings.json and out of client settings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("claude_zai");
      const key = `${"0123456789abcdef".repeat(2)}.AbCdEfGh12345678`;
      const preset = openModelPresetById("zai");
      if (!preset) throw new Error("no zai preset");
      const environment = buildOpenModelEnvironment({ preset, key });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: preset.label,
            environment,
            config: {},
          },
        },
      });

      // The server itself still has the key, to launch with.
      const tokenRow = next.providerInstances[instanceId]?.environment?.find(
        (row) => row.name === "ANTHROPIC_AUTH_TOKEN",
      );
      assert.equal(tokenRow?.value, key);
      assert.equal(tokenRow?.sensitive, true);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, key);
      assert.notInclude(raw, "AbCdEfGh12345678");
      assert.include(raw, '"valueRedacted": true');
      // The non-secret rows, the marker among them, stay readable.
      assert.include(raw, "SPECWITHCODE_OPEN_MODEL_PRESET");
      assert.include(raw, preset.baseUrl);

      const forClient = JSON.stringify(ServerSettingsModule.redactServerSettingsForClient(next));
      assert.notInclude(forClient, key);
      assert.notInclude(forClient, "AbCdEfGh12345678");
      assert.include(forClient, "SPECWITHCODE_OPEN_MODEL_PRESET");
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
