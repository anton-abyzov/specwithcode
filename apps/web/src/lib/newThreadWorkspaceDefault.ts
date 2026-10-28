import { WS_METHODS, type EnvironmentId, type ThreadEnvMode } from "@specweave-studio/contracts";
import { subscribe, type EnvironmentRpcStreamFailure } from "@specweave-studio/client-runtime/rpc";
import type { EnvironmentRegistry } from "@specweave-studio/client-runtime/connection";
import {
  executeAtomQuery,
  followStreamInEnvironment,
} from "@specweave-studio/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** A finite observation: live status atoms remain `waiting` while subscribed. */
export function observeNewThreadIsRepo(
  environmentId: EnvironmentId,
  cwd: string,
): Effect.Effect<
  boolean | undefined,
  EnvironmentRpcStreamFailure<typeof WS_METHODS.subscribeVcsStatus> | Cause.TimeoutError,
  EnvironmentRegistry.EnvironmentRegistry
> {
  return followStreamInEnvironment(
    environmentId,
    subscribe(WS_METHODS.subscribeVcsStatus, { cwd }),
  ).pipe(
    Stream.filter((event) => event._tag !== "remoteUpdated"),
    Stream.runHead,
    Effect.map((event) => (Option.isSome(event) ? event.value.local.isRepo : undefined)),
    Effect.timeout("5 seconds"),
  );
}

/** Only a fresh, unconfigured web draft gets the Git-aware default. */
export async function resolveNewThreadWorkspaceDefault(options: {
  readonly configuredMode: ThreadEnvMode | null;
  readonly readIsRepo: () => Promise<boolean | undefined>;
}): Promise<ThreadEnvMode> {
  if (options.configuredMode !== null) return options.configuredMode;
  try {
    return (await options.readIsRepo()) === true ? "worktree" : "local";
  } catch {
    // Offline/unknown workspaces remain usable without pretending Git was verified.
    return "local";
  }
}

export function readNewThreadWorkspaceDefault(options: {
  readonly configuredMode: ThreadEnvMode | null;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string | undefined;
}): Promise<ThreadEnvMode> {
  return resolveNewThreadWorkspaceDefault({
    configuredMode: options.configuredMode,
    readIsRepo: async () => {
      if (!options.workspaceRoot) return undefined;
      const result = await executeAtomQuery(
        appAtomRegistry,
        connectionAtomRuntime.atom(
          observeNewThreadIsRepo(options.environmentId, options.workspaceRoot),
        ),
        { reportDefect: false, reportFailure: false },
      );
      return result._tag === "Success" ? result.value : undefined;
    },
  });
}
