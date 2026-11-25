import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ServerSettings } from "@specweave-studio/contracts";
import { simplifyProjectSettingsOverrides } from "@specweave-studio/shared/serverSettings";
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
          prefix: "studio-server-settings-simplified-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("the one-time project settings cleanup", (it) => {
  it.effect("never runs over an override this server wrote, so it stays the project's", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const solo = ProjectId.make("solo");
      // A fresh home: no settings file yet, so nothing has been cleaned up.
      assert.isFalse((yield* serverSettings.getSettings).projectSettingsSimplified);

      yield* serverSettings.updateSettings({
        projectSettingsOverrideChanges: {
          [solo]: { set: { adversarialReview: { autoOnFeatureComplete: false } } },
        },
      });

      // What a reload or the next start reads back. With only this project
      // live, the cleanup would make its override the value for every project.
      const persisted = yield* decodeServerSettingsJson(
        yield* fileSystem.readFileString(serverConfig.settingsPath),
      );
      assert.isTrue(persisted.projectSettingsSimplified);
      const reloaded = simplifyProjectSettingsOverrides(persisted, [solo]);
      assert.deepEqual(reloaded.projectSettingsOverrides[solo]?.adversarialReview, {
        autoOnFeatureComplete: false,
      });
      assert.deepEqual(reloaded.adversarialReview, persisted.adversarialReview);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
