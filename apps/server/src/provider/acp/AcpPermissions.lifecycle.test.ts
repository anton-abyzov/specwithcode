import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import * as Runtime from "./AcpSessionRuntime.ts";
import {
  makeAcpAdapterV2,
  AcpProviderCapabilitiesV2,
} from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ServerConfig from "../../config.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-permissions-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

describe("ACP permission lifecycle", () => {
  it.effect("synchronizes initial open and already-active resume without a prompt", () =>
    Effect.gen(function* () {
      let allowAll = false;
      const changes: boolean[] = [];
      const instanceId = ProviderInstanceId.make("permissions-test");
      const adapter = makeAcpAdapterV2({
        instanceId,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ProviderDriverKind.make("acp-test"),
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (input) =>
            Effect.gen(function* () {
              const path = yield* Path.Path;
              const native = yield* Runtime.make({
                ...input,
                spawn: {
                  command: process.execPath,
                  args: [
                    yield* path
                      .fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url))
                      .pipe(Effect.orDie),
                  ],
                  cwd: input.cwd,
                  env: { STUDIO_ACP_SESSION_LIFECYCLE: "1" },
                },
              });
              return {
                ...native,
                getConfigOptions: Effect.gen(function* () {
                  return [
                    ...(yield* native.getConfigOptions),
                    {
                      id: "allowAll",
                      name: "Allow All",
                      type: "boolean" as const,
                      currentValue: allowAll,
                    },
                  ];
                }),
                setConfigOption: (id: string, value: string | boolean) =>
                  id !== "allowAll"
                    ? native.setConfigOption(id, value)
                    : Effect.sync(() => {
                        allowAll = value === true;
                        changes.push(allowAll);
                        return {
                          configOptions: [
                            {
                              id,
                              name: "Allow All",
                              type: "boolean" as const,
                              currentValue: allowAll,
                            },
                          ],
                        };
                      }),
              };
            }).pipe(Effect.provide(NodeServices.layer)),
        },
      });
      const threadId = ThreadId.make("permissions-thread");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: process.cwd(),
      };
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("permissions-session"),
        modelSelection,
        runtimePolicy,
      });
      const thread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      expect(changes).toEqual([true]);
      yield* session.resumeThread({
        providerThread: thread,
        runtimePolicy: { ...runtimePolicy, runtimeMode: "approval-required" },
      });
      expect(changes).toEqual([true, false]);
      allowAll = true; // Provider drift while the session is idle.
      yield* session.resumeThread({ providerThread: thread });
      expect(changes).toEqual([true, false, false]);
      yield* session.resumeThread({ providerThread: thread, runtimePolicy });
      expect(changes).toEqual([true, false, false, true]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
