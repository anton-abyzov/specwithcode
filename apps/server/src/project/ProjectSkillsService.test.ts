import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";

const cwd = "/nonexistent/project-skills-service-test";

const provider = (id: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled: true,
    availability: "available",
    status: "ready",
    skills: [],
    workspaceSnapshots: [{ cwd, skills: [] }],
  }) as never;

const makeLayer = (calls: Array<{ instanceId: string; fresh: boolean | undefined }>) => {
  const providers = [provider("claudeAgent"), provider("codex")];
  const registry = Layer.effect(
    ProviderRegistry.ProviderRegistry,
    Effect.gen(function* () {
      const base = yield* ProviderRegistry.ProviderRegistry;
      return ProviderRegistry.ProviderRegistry.of({
        ...base,
        refreshWorkspaceSnapshot: (input) =>
          Effect.sync(() => {
            calls.push({ instanceId: input.instanceId, fresh: input.fresh });
            return providers;
          }),
      });
    }),
  ).pipe(Layer.provide(ProviderRegistryMock.layer(providers)));
  return ProjectSkillsService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        registry,
        Layer.succeed(
          ProjectStore.ProjectStoreV2,
          ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeedSome({ workspaceRoot: cwd }),
          } as never),
        ),
        NodeServices.layer,
      ),
    ),
  );
};

it.effect("a plain read keeps snapshots; Rescan asks each provider for a fresh scan", () => {
  const calls: Array<{ instanceId: string; fresh: boolean | undefined }> = [];
  return Effect.gen(function* () {
    const service = yield* ProjectSkillsService.ProjectSkillsService;
    const projectId = ProjectId.make("project-skills");

    yield* service.read({ projectId });
    assert.deepStrictEqual(
      calls.map((call) => call.fresh),
      [false, false],
    );

    calls.length = 0;
    const snapshot = yield* service.read({ projectId, refresh: true });
    assert.deepStrictEqual(calls, [
      { instanceId: "claudeAgent", fresh: true },
      { instanceId: "codex", fresh: true },
    ]);
    assert.deepStrictEqual(
      snapshot.providers.map((state) => state.state),
      ["ok", "ok"],
    );
  }).pipe(Effect.provide(makeLayer(calls)));
});
