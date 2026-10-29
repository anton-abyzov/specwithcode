import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { installedManagedUpdateHelper } from "../managedUpdates/ManagedUpdatesService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";

/** Records only the child passed by ManagedEndpointRuntime after its own spawn.
 * Failure preserves the connector and leaves update admission fail closed.
 */
export class RelayProcessOwnership extends Context.Service<
  RelayProcessOwnership,
  {
    readonly publish: (pid: number, executable: string) => Effect.Effect<string | null>;
    readonly clear: (pid: number, generation: string | null) => Effect.Effect<void>;
  }
>()("specweave-studio/cloud/RelayProcessOwnership") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const sequence = yield* Ref.make(0);
  const helperContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  // The existing resolver verifies owning UID, non-writable ancestors, canonical
  // regular files and every packaged helper; payloads never select executable code.
  const invoke = (
    action: "publish" | "clear",
    pid: number,
    generation: string,
    executable?: string,
  ) =>
    Effect.gen(function* () {
      if (platform !== "darwin") return false;
      const helper = yield* installedManagedUpdateHelper.pipe(Effect.provide(helperContext));
      if (helper === null) return false;
      const result = yield* runner.run({
        command: "/usr/bin/python3",
        args: [
          "-B",
          "-E",
          "-s",
          path.join(path.dirname(helper), "relay_ownership.py"),
          action,
          config.baseDir,
          String(process.pid),
          String(pid),
          generation,
          ...(executable === undefined ? [] : [executable]),
        ],
        timeout: "3 seconds",
        maxOutputBytes: 1024,
        outputMode: "error",
      });
      return (
        result.code === 0 && !result.timedOut && !result.stdoutTruncated && !result.stderrTruncated
      );
    }).pipe(
      Effect.orElseSucceed(() => false),
      Effect.tap((ok) =>
        ok || platform !== "darwin"
          ? Effect.void
          : Effect.logWarning("Relay ownership proof unavailable", { action }),
      ),
    );
  return RelayProcessOwnership.of({
    publish: (pid, executable) =>
      Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(sequence, (value) => value + 1);
        const generation = `${process.pid}-${pid}-${next}`;
        return (yield* invoke("publish", pid, generation, executable)) ? generation : null;
      }),
    clear: (pid, generation) =>
      generation === null ? Effect.void : invoke("clear", pid, generation).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(RelayProcessOwnership, make);
