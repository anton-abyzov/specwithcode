import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@specweave-studio/contracts";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-protected-paths-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

describe("AcpAdapterV2 client file system credential stores", () => {
  it.effect(
    "refuses the secrets folder and fleet file, also through links, under full access",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
        let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
        const crypto = yield* Crypto.Crypto;
        const instanceId = ProviderInstanceId.make("acp-protected-paths-test");
        const adapter = makeAntigravityAdapterV2({
          instanceId,
          crypto,
          selfInvocation: yield* resolveSelfInvocation(),
          fileSystem,
          path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig,
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { STUDIO_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleReadTextFile: (handler) =>
                  Effect.sync(() => {
                    readTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
                handleWriteTextFile: (handler) =>
                  Effect.sync(() => {
                    writeTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.succeed(undefined),
        });

        // The worst case: the agent's workspace is the data home itself, so
        // workspace containment alone would let every read through.
        const workspace = serverConfig.baseDir;
        yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
        const secretFile = path.join(serverConfig.secretsDir, "anthropic-api-key.bin");
        yield* fileSystem.writeFileString(secretFile, "fake-key");
        const fleetFile = path.join(serverConfig.baseDir, "studio-fleet.json");
        yield* fileSystem.writeFileString(fleetFile, '{"version":1,"machines":[]}');
        const logFile = path.join(serverConfig.logsDir, "readable.log");
        yield* fileSystem.makeDirectory(serverConfig.logsDir, { recursive: true });
        yield* fileSystem.writeFileString(logFile, "log line");

        const threadId = ThreadId.make("thread-acp-protected-paths");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-protected-paths"),
          modelSelection,
          runtimePolicy,
        });
        yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
        if (readTextFile === undefined || writeTextFile === undefined) {
          return yield* Effect.die("Antigravity sessions must serve client file requests");
        }
        const read = readTextFile;
        const write = writeTextFile;
        const readExit = (target: string) =>
          read(
            { sessionId: "mock-session-1", path: target },
            { requestId: "test-read", method: "fs/read_text_file" },
          ).pipe(Effect.exit);
        const writeExit = (target: string) =>
          write(
            { sessionId: "mock-session-1", path: target, content: "planted" },
            { requestId: "test-write", method: "fs/write_text_file" },
          ).pipe(Effect.exit);

        // Containment allows the data home; the read of an ordinary file there works.
        const log = yield* read(
          { sessionId: "mock-session-1", path: logFile },
          { requestId: "test-read", method: "fs/read_text_file" },
        );
        assert.equal(log.content, "log line");

        assert.isTrue(Exit.isFailure(yield* readExit(secretFile)), "direct secret read");
        assert.isTrue(Exit.isFailure(yield* readExit(fleetFile)), "fleet file read");
        assert.isTrue(
          Exit.isFailure(
            yield* readExit(
              path.join(workspace, "userdata", "secrets", "..", "secrets", "anthropic-api-key.bin"),
            ),
          ),
          "a dotted spelling of the secret path",
        );

        const fileLink = path.join(workspace, "notes.txt");
        yield* fileSystem.symlink(secretFile, fileLink);
        assert.isTrue(Exit.isFailure(yield* readExit(fileLink)), "read through a file link");
        const dirLink = path.join(workspace, "keys");
        yield* fileSystem.symlink(serverConfig.secretsDir, dirLink);
        assert.isTrue(
          Exit.isFailure(yield* readExit(path.join(dirLink, "anthropic-api-key.bin"))),
          "read through a folder link",
        );

        const overwrite = yield* writeExit(secretFile);
        assert.isTrue(Exit.isFailure(overwrite), "overwrite of a secret");
        assert.equal(yield* fileSystem.readFileString(secretFile), "fake-key");
        const planted = path.join(serverConfig.secretsDir, "planted.bin");
        const danglingLink = path.join(workspace, "planted-link.bin");
        yield* fileSystem.symlink(planted, danglingLink);
        assert.isTrue(
          Exit.isFailure(yield* writeExit(danglingLink)),
          "write through a dangling link",
        );
        assert.isFalse(yield* fileSystem.exists(planted));
        assert.isTrue(Exit.isFailure(yield* writeExit(fleetFile)), "overwrite of the fleet file");
        assert.equal(yield* fileSystem.readFileString(fleetFile), '{"version":1,"machines":[]}');
        // The session's agent runs inside the temporary data home, and Windows
        // cannot remove a folder a live process uses: close the session first.
      }).pipe(Effect.scoped, Effect.provide(layerSession)),
  );
});
