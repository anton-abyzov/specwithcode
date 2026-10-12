import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ServerSettings } from "@specweave-studio/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";

const layerTest = Settings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest("/tmp", { prefix: "studio-instructions-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest)("agent instruction persistence", (it) => {
  it.effect("persists additive instructions and resets only the project's policy", () =>
    Effect.gen(function* () {
      const service = yield* Settings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const projectId = ProjectId.make("instructions-test");
      yield* service.updateSettings({
        agentInstructions: "Always run headless",
        claudeWorkflowMode: "on-request",
        projectSettingsOverrides: {
          [projectId]: { agentInstructions: "Use Node 22", claudeWorkflowMode: "automatic" },
        },
      });
      const saved = yield* Schema.decodeEffect(Schema.fromJsonString(ServerSettings))(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(saved.agentInstructions, "Always run headless");
      assert.equal(saved.projectSettingsOverrides[projectId]?.agentInstructions, "Use Node 22");
      const reset = yield* service.updateSettings({
        projectSettingsOverrides: { [projectId]: null },
      });
      assert.equal(reset.agentInstructions, "Always run headless");
      assert.equal(reset.claudeWorkflowMode, "on-request");
      assert.isUndefined(reset.projectSettingsOverrides[projectId]);
    }),
  );
});
