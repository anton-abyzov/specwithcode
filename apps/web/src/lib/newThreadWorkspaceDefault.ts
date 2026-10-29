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

/**
 * Only a fresh, unconfigured web draft gets the Git-aware default: a worktree
 * for one Git repository, the current checkout otherwise. A Git folder that
 * holds separate clones, such as an umbrella whose `repositories/` its own
 * `.gitignore` excludes, stays in the current checkout, since a worktree of it
 * would hold none of their code. Its layout is read only for a Git folder.
 */
export async function resolveNewThreadWorkspaceDefault(options: {
  readonly configuredMode: ThreadEnvMode | null;
  readonly readIsRepo: () => Promise<boolean | undefined>;
  readonly readHoldsSeparateClones?: () => Promise<boolean | undefined>;
}): Promise<ThreadEnvMode> {
  if (options.configuredMode !== null) return options.configuredMode;
  try {
    if ((await options.readIsRepo()) !== true) return "local";
  } catch {
    // Offline/unknown workspaces remain usable without pretending Git was verified.
    return "local";
  }
  // An unreadable layout keeps the Git default.
  const separateClones = await options.readHoldsSeparateClones?.().catch(() => undefined);
  return separateClones === true ? "local" : "worktree";
}

/** A large folder's layout walk must not hold the new draft for long. */
const LAYOUT_READ_MS = 5_000;
const within =
  <A>(ms: number, read: () => Promise<A>) =>
  (): Promise<A | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    });

export function readNewThreadWorkspaceDefault(options: {
  readonly configuredMode: ThreadEnvMode | null;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string | undefined;
  readonly readHoldsSeparateClones?: () => Promise<boolean | undefined>;
}): Promise<ThreadEnvMode> {
  return resolveNewThreadWorkspaceDefault({
    configuredMode: options.configuredMode,
    ...(options.readHoldsSeparateClones
      ? { readHoldsSeparateClones: within(LAYOUT_READ_MS, options.readHoldsSeparateClones) }
      : {}),
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
