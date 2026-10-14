import { parseJson, stringifyJson } from "../json.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MachineHandoffError } from "@specweave-studio/contracts";
import * as ServerConfig from "../config.ts";

/** Private durable state, separate from conversation rows and Git publication. */
export class MachineHandoffStore extends Context.Service<
  MachineHandoffStore,
  {
    readonly root: string;
    readonly prepareWorktreeParent: Effect.Effect<string, MachineHandoffError>;
    readonly read: (key: string) => Effect.Effect<unknown | null, MachineHandoffError>;
    readonly write: (key: string, value: unknown) => Effect.Effect<void, MachineHandoffError>;
    readonly retainContext: (
      key: string,
      text: string,
    ) => Effect.Effect<string, MachineHandoffError>;
  }
>()("specweave-studio/fleet/MachineHandoffStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = yield* fs
    .realPath(config.stateDir)
    .pipe(Effect.mapError(() => new MachineHandoffError({ code: "storage_failed" })));
  const root = path.join(stateDir, "machine-handoffs");
  const location = (key: string) => {
    if (!/^[a-z0-9_-]+$/i.test(key)) throw new Error("Invalid internal handoff key");
    return path.join(root, key);
  };
  const prepareRoot = Effect.gen(function* () {
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    if ((yield* fs.realPath(root)) !== root)
      return yield* new MachineHandoffError({ code: "storage_failed" });
    yield* fs.chmod(root, 0o700);
  });
  const writeText = (key: string, text: string) =>
    Effect.gen(function* () {
      yield* prepareRoot;
      const target = location(key);
      const temporary = `${target}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(new TextEncoder().encode(text));
          yield* file.sync;
        }),
      );
      yield* fs.rename(temporary, target);
    }).pipe(Effect.mapError(() => new MachineHandoffError({ code: "storage_failed" })));
  const read = (key: string) =>
    Effect.gen(function* () {
      const target = location(key);
      if (!(yield* fs.exists(target))) return null;
      if ((yield* fs.realPath(root)) !== root || (yield* fs.realPath(target)) !== target)
        return yield* new MachineHandoffError({ code: "storage_failed" });
      const text = yield* fs.readFileString(target);
      return yield* Effect.try({
        try: () => parseJson(text) as unknown,
        catch: () => new MachineHandoffError({ code: "storage_failed" }),
      });
    }).pipe(Effect.mapError(() => new MachineHandoffError({ code: "storage_failed" })));
  return MachineHandoffStore.of({
    root,
    read,
    prepareWorktreeParent: Effect.gen(function* () {
      yield* prepareRoot;
      const parent = path.join(root, "git");
      yield* fs.makeDirectory(parent, { mode: 0o700, recursive: true });
      if ((yield* fs.realPath(parent)) !== parent)
        return yield* new MachineHandoffError({ code: "storage_failed" });
      yield* fs.chmod(parent, 0o700);
      return parent;
    }).pipe(Effect.mapError(() => new MachineHandoffError({ code: "storage_failed" }))),
    write: (key, value) => writeText(key, stringifyJson(value)),
    retainContext: (key, text) => writeText(key, text).pipe(Effect.as(location(key))),
  });
});
export const layer = Layer.effect(MachineHandoffStore, make);
