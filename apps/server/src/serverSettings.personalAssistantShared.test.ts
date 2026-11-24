import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ServerSettings } from "@specweave-studio/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

// The real file-backed settings layer on a private temporary settings path.
const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "studio-server-settings-percy-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("personalAssistantShared on disk", (it) => {
  it.effect("writes a switch that is off with machines, and on with no machines", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const m4 = EnvironmentId.make("m4");

      const onAlone = { enabled: true, machines: [], enabledAt: "2026-11-24T10:00:00.000Z" };
      yield* service.setPersonalAssistantShared!(onAlone);
      let persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.deepEqual(persisted.personalAssistantShared, onAlone);
      assert.deepEqual((yield* service.getSettings).personalAssistantShared, onAlone);

      const offWithMachine = { enabled: false, machines: [m4] };
      yield* service.setPersonalAssistantShared!(offWithMachine);
      persisted = yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath));
      assert.deepEqual(persisted.personalAssistantShared, offWithMachine);
      assert.deepEqual((yield* service.getSettings).personalAssistantShared, offWithMachine);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
