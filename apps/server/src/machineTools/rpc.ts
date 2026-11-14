/**
 * Machine readiness over RPC: each machine's own server checks Git, Node.js,
 * gh and SpecWeave and installs a missing one, streaming the install's log.
 * One install runs at a time per machine, shared with the readiness check
 * after an update (readinessSweep.ts).
 */
import {
  MachineToolsError,
  type MachineReadinessToolId,
  type MachineToolInstallEvent,
  MACHINE_TOOLS_RPC_METHODS,
  WsMachineToolsRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { checkMachineTools, machineToolName, MachineToolInstallError } from "./machineTools.ts";
import {
  machineToolsContext,
  readSweepState,
  seedManagedToolPath,
  startInstall,
} from "./runtime.ts";

export { seedManagedToolPath } from "./runtime.ts";

const toError = (cause: unknown) =>
  new MachineToolsError({
    code: cause instanceof MachineToolInstallError ? cause.code : "failed",
    reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1900),
  });

export const layerRpcHandlers = WsMachineToolsRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const services = yield* Effect.context<
      | ServerConfig.ServerConfig
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
    >();
    // Normally seeded at server start; this covers a server that skipped it.
    yield* seedManagedToolPath(config.baseDir);
    const context = machineToolsContext.pipe(Effect.provideContext(services));

    return {
      [MACHINE_TOOLS_RPC_METHODS.machineToolsCheck]: () =>
        context.pipe(
          Effect.flatMap(({ ctx, git }) =>
            Effect.tryPromise({
              try: async () => {
                const check = await checkMachineTools(ctx, git);
                const lastSweep = await readSweepState(ctx.host, ctx.home).catch(() => null);
                return lastSweep === null ? check : { ...check, lastSweep };
              },
              catch: toError,
            }),
          ),
        ),
      [MACHINE_TOOLS_RPC_METHODS.machineToolsInstall]: (input: {
        readonly tool: MachineReadinessToolId;
      }) =>
        Stream.callback<MachineToolInstallEvent, MachineToolsError>((queue) =>
          Effect.gen(function* () {
            const { ctx, git } = yield* context;
            const log = (line: string) =>
              Queue.offerUnsafe(queue, { type: "log", line: line.slice(0, 3900) });
            // A closed stream stops the waiting, not the install.
            const started = startInstall(ctx, input.tool, git, log);
            if ("busyWith" in started)
              return yield* new MachineToolsError({
                code: "busy",
                reason: `${machineToolName(started.busyWith)} is being installed on this machine. Wait for it to end.`,
              });
            const outcome = yield* Effect.tryPromise({ try: () => started.run, catch: toError });
            Queue.offerUnsafe(queue, {
              type: "done",
              ok: true,
              ...(outcome.handedOff ? { handedOff: true } : {}),
              detail: outcome.detail,
            });
          }).pipe(
            Effect.catchTags({ MachineToolsError: (error) => Queue.fail(queue, error) }),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
        ),
    };
  }),
);
