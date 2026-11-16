import {
  defaultMachineNickname,
  sameMachineNicknames,
} from "@specweave-studio/shared/machineNicknames";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetTargets from "./FleetTargets.ts";

/**
 * A machine nobody has named names itself once, from the chip in its computer
 * name ("Anton M5MAX PROLED" shows as "M5"), so a new machine reads short in
 * Runs on, thread rows and on every paired device without a rename first.
 *
 * The name is stamped older than any choice: a rename made on any machine,
 * before or after, wins when nicknames sync. A machine that already has an
 * entry, even one that keeps the computer name, is left alone, and so is one
 * whose short name another machine on its fleet list shows or would take
 * (`defaultMachineNickname`). It is tried again whenever nicknames change, so
 * names that arrive from paired machines are counted first.
 */
export const nameThisMachine = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const targets = yield* FleetTargets.FleetTargets;
  const descriptor = yield* environment.getDescriptor;
  const current = yield* settings.getSettings;
  const nicknames = current.machineNicknames ?? {};
  if (nicknames[descriptor.environmentId] !== undefined) return false;
  const fleet = yield* targets.load.pipe(Effect.orElseSucceed(() => null));
  const others = new Map(
    (fleet?.machines ?? []).map((machine) => [machine.environmentId as string, machine.label]),
  );
  const entry = defaultMachineNickname(
    nicknames,
    descriptor.environmentId,
    descriptor.label,
    others,
  );
  if (entry === null) return false;
  yield* settings.updateSettings({ machineNicknames: { [descriptor.environmentId]: entry } });
  return true;
});

const attempt = nameThisMachine.pipe(Effect.catchCause(() => Effect.succeed(false)));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    // Names that arrive from paired machines can make a name taken, so try again on each.
    yield* attempt.pipe(
      Effect.andThen(
        settings.streamChanges.pipe(
          Stream.map((current) => current.machineNicknames),
          Stream.changesWith(sameMachineNicknames),
          Stream.debounce(Duration.seconds(2)),
          Stream.runForEach(() => attempt),
        ),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );
  }),
);
