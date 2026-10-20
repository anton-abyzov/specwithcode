/**
 * Provision from Settings > Connections: the machine's own server runs the
 * same runner as `specwithcode provision` and streams its progress. It never
 * restarts or replaces the server it runs in, and root steps run only with
 * passwordless sudo; otherwise the readback carries the one line to run there.
 */
import {
  ProvisionError,
  type ProvisionEvent,
  PROVISION_RPC_METHODS,
  WsProvisionRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { loginShellPath, makeNodeProvisionHost } from "./host.ts";
import { ProvisionRunError, runProvision, type ProvisionOptions } from "./runner.ts";

const toProvisionError = (cause: unknown) =>
  cause instanceof ProvisionRunError
    ? new ProvisionError({ code: cause.code, reason: cause.message.slice(0, 1900) })
    : new ProvisionError({
        code: "failed",
        reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1900),
      });

let running = false;

export const layerRpcHandlers = WsProvisionRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const options = (dryRun: boolean, resume: boolean): ProvisionOptions => ({
      dryRun,
      resume,
      manifestVersion: packageJson.version,
      baseDir: config.baseDir,
      mode: "remote",
      loginShellPath,
      serverPath: process.env.PATH ?? "",
      runtime: { version: process.version, execPath: process.execPath },
    });
    return {
      [PROVISION_RPC_METHODS.provisionPreview]: () =>
        Effect.tryPromise({
          try: () => runProvision(makeNodeProvisionHost(), options(true, false)),
          catch: toProvisionError,
        }),
      [PROVISION_RPC_METHODS.provisionRun]: (input: { readonly resume?: boolean | undefined }) =>
        Stream.callback<ProvisionEvent, ProvisionError>((queue) =>
          Effect.gen(function* () {
            if (running)
              return yield* new ProvisionError({
                code: "busy",
                reason: "Provisioning is already running on this machine.",
              });
            running = true;
            yield* Effect.tryPromise({
              try: () =>
                runProvision(makeNodeProvisionHost(), {
                  ...options(false, input.resume === true),
                  onEvent: (event) => Queue.offerUnsafe(queue, event),
                }),
              catch: toProvisionError,
            }).pipe(Effect.ensuring(Effect.sync(() => (running = false))));
          }).pipe(
            Effect.catchTags({ ProvisionError: (error) => Queue.fail(queue, error) }),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
        ),
    };
  }),
);
