import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  OpenCodeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import type {
  OpenCodeRuntimeShape,
  OpenCodeServerConnection,
} from "../../provider/opencodeRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { makeOpenCodeAdapterV2 } from "./OpenCodeAdapterV2.ts";

const decodeOpenCodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);

it.effect.each([
  {
    name: "a server it started with OPENCODE_SERVER_PASSWORD",
    settings: {},
    connection: { external: false, serverPassword: "environment-password" },
    expectedConnectPassword: undefined,
    expectedClientPassword: "environment-password",
  },
  {
    name: "an external server with a settings password",
    settings: { serverUrl: "http://opencode.test", serverPassword: "settings-password" },
    connection: { external: true, serverPassword: "settings-password" },
    expectedConnectPassword: "settings-password",
    expectedClientPassword: "settings-password",
  },
  {
    name: "an external server without a password",
    settings: { serverUrl: "http://opencode.test" },
    connection: { external: true },
    expectedConnectPassword: undefined,
    expectedClientPassword: undefined,
  },
] as const)(
  "authenticates the SDK client with the password the connection resolved for $name",
  (testCase) =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const connectInputs: Array<{ readonly serverPassword?: string }> = [];
      const clientInputs: Array<{ readonly serverPassword?: string }> = [];
      const fakeClient = {
        event: {
          subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
            // Emits nothing and ends when the pump's abort signal fires.
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<never>>((resolve) => {
                    const done = () => resolve({ done: true, value: undefined });
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener("abort", done, { once: true });
                  }),
              }),
            },
          }),
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const connection: OpenCodeServerConnection = {
        url: "test://opencode",
        version: "test",
        exitCode: null,
        ...testCase.connection,
      };
      const runtime: OpenCodeRuntimeShape = {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: (input) =>
          Effect.sync(() => {
            connectInputs.push(input);
            return connection;
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: (input) => {
          clientInputs.push(input);
          return fakeClient;
        },
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadInventoryFromCli: unused("loadInventoryFromCli"),
        loadOpenCodeSkills: unused("loadOpenCodeSkills"),
        loadSkillsFromCli: unused("loadSkillsFromCli"),
      };
      const instanceId = ProviderInstanceId.make("opencode-auth");
      const adapter = makeOpenCodeAdapterV2({
        instanceId,
        settings: decodeOpenCodeSettings(testCase.settings),
        environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        runtime,
        idAllocator,
        serverConfig,
      });
      yield* adapter.openSession({
        threadId: ThreadId.make("thread-opencode-auth"),
        providerSessionId: ProviderSessionId.make("session-opencode-auth"),
        modelSelection: { instanceId, model: "anthropic/claude-sonnet" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        }),
      });

      assert.lengthOf(connectInputs, 1);
      assert.strictEqual(connectInputs[0]?.serverPassword, testCase.expectedConnectPassword);
      assert.lengthOf(clientInputs, 1);
      assert.strictEqual(clientInputs[0]?.serverPassword, testCase.expectedClientPassword);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          ServerConfig.layerTest(process.cwd(), {
            prefix: "studio-opencode-v2-auth-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);
