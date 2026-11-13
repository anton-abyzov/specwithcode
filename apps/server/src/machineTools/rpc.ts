/**
 * First-run setup's machine basics over RPC: each machine's own server checks
 * Git, Node.js and gh and installs a missing one, streaming the install's log.
 * One install runs at a time per machine.
 */
import {
  MachineToolsError,
  type MachineToolId,
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
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { nodeToolDirs } from "../project/nodeToolDirs.ts";
import { probeGit } from "../provider/providerDiscovery.ts";
import { makeNodeProvisionHost } from "../provision/host.ts";
import {
  checkMachineTools,
  installMachineTool,
  MachineToolInstallError,
  managedToolDirs,
  runsOnGlibc,
  type MachineToolsContext,
  withPathDirs,
} from "./machineTools.ts";

/**
 * Puts the folders the app installed tools into on this server's PATH, after
 * the person's own folders. Agents, terminals and Git spawns inherit it.
 */
export function addToServerPath(dirs: ReadonlyArray<string>): void {
  // oxlint-disable-next-line studio/no-global-process-runtime -- the server's own PATH is the point.
  const env = process.env;
  // oxlint-disable-next-line studio/no-global-process-runtime -- as above.
  const platform = process.platform;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const next = withPathDirs(env[key], dirs, platform);
  if (next !== undefined) env[key] = next;
}

const toolName = (tool: MachineToolId) =>
  tool === "gh" ? "GitHub CLI" : tool === "node" ? "Node.js" : "Git";

let installing: MachineToolId | null = null;

export const layerRpcHandlers = WsMachineToolsRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = makeNodeProvisionHost();
    const glibc = runsOnGlibc();
    // Tools the app installed earlier are on the PATH from the start.
    const installed: string[] = [];
    for (const dir of managedToolDirs({
      home: config.baseDir,
      platform: host.platform,
      arch: host.arch,
      glibc,
    })) {
      if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) installed.push(dir);
    }
    addToServerPath(installed);

    const context = Effect.gen(function* () {
      const env = process.env;
      const nodeManagerDirs = yield* nodeToolDirs({
        home: NodeOS.homedir(),
        platform: host.platform as NodeJS.Platform,
        execPath: process.execPath,
        fnmDir: env.FNM_DIR,
        nvmDir: env.NVM_DIR,
        voltaHome: env.VOLTA_HOME,
        xdgDataHome: env.XDG_DATA_HOME,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
      const git = yield* probeGit(env, host.platform as NodeJS.Platform).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      // The host reads the live PATH, so a tool installed a moment ago is found.
      const ctx: MachineToolsContext = {
        host: makeNodeProvisionHost(),
        home: config.baseDir,
        glibc,
        nodeManagerDirs,
      };
      return { ctx, git };
    });

    return {
      [MACHINE_TOOLS_RPC_METHODS.machineToolsCheck]: () =>
        context.pipe(
          Effect.flatMap(({ ctx, git }) =>
            Effect.tryPromise({
              try: () => checkMachineTools(ctx, git),
              catch: (cause) =>
                new MachineToolsError({
                  code: "failed",
                  reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1900),
                }),
            }),
          ),
        ),
      [MACHINE_TOOLS_RPC_METHODS.machineToolsInstall]: (input: { readonly tool: MachineToolId }) =>
        Stream.callback<MachineToolInstallEvent, MachineToolsError>((queue) =>
          Effect.gen(function* () {
            if (installing !== null)
              return yield* new MachineToolsError({
                code: "busy",
                reason: `${toolName(installing)} is being installed on this machine. Wait for it to end.`,
              });
            const { ctx, git } = yield* context;
            installing = input.tool;
            const log = (line: string) =>
              Queue.offerUnsafe(queue, { type: "log", line: line.slice(0, 3900) });
            yield* Effect.tryPromise({
              try: async () => {
                const outcome = await installMachineTool(ctx, input.tool, git, log);
                addToServerPath(outcome.pathDirs);
                Queue.offerUnsafe(queue, {
                  type: "done",
                  ok: true,
                  ...(outcome.handedOff ? { handedOff: true } : {}),
                  detail: outcome.detail,
                });
              },
              catch: (cause) =>
                new MachineToolsError({
                  code: cause instanceof MachineToolInstallError ? cause.code : "failed",
                  reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1900),
                }),
            }).pipe(Effect.ensuring(Effect.sync(() => (installing = null))));
          }).pipe(
            Effect.catchTags({ MachineToolsError: (error) => Queue.fail(queue, error) }),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
        ),
    };
  }),
);
