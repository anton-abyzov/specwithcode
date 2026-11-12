/**
 * Whether the Switch service has ever answered on this machine.
 *
 * Switch is optional. Until it has answered once, nothing listening on its
 * port means "not installed", not a fault, and the Overview stays quiet. Once
 * it has answered, a later failure is worth a warning. The answer is one empty
 * file in the state directory, so it survives restarts and updates.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";

const FILE_NAME = "switch-seen";

export interface SwitchSeenShape {
  readonly get: Effect.Effect<boolean>;
  /** Records the first valid answer; later calls do nothing. */
  readonly mark: Effect.Effect<void>;
}

/**
 * Without a store, Switch counts as seen: every failure is reported, as it
 * was before the store existed. The server provides the file-backed `layer`.
 */
export const SwitchSeen = Context.Reference<SwitchSeenShape>(
  "@specweave-studio/server/studio/SwitchSeen",
  { defaultValue: () => ({ get: Effect.succeed(true), mark: Effect.void }) },
);

/** A store that lives as long as the process; for tests. */
export const makeMemorySwitchSeen = (initial: boolean): SwitchSeenShape => {
  const seen = Ref.makeUnsafe(initial);
  return { get: Ref.get(seen), mark: Ref.set(seen, true) };
};

const makeFileSwitchSeen = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, FILE_NAME);
  // A state directory that cannot be read counts as "never seen": a missing
  // warning on a machine with Switch costs less than a false one without it.
  const seen = yield* Ref.make(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)));
  const store: SwitchSeenShape = {
    get: Ref.get(seen),
    mark: Effect.gen(function* () {
      if (yield* Ref.getAndSet(seen, true)) return;
      yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(file, "", { mode: 0o600 });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Capacity: could not record that Switch answered", { cause }),
      ),
    ),
  };
  return store;
});

export const layer = Layer.effect(SwitchSeen, makeFileSwitchSeen);
