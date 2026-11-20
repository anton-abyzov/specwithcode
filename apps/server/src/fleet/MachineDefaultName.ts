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
 * A machine nobody has named names itself from the chip in its computer name
 * ("Anton M5MAX PROLED" shows as "M5"), so a new machine reads short in Runs
 * on, thread rows and on every paired device without a rename first.
 *
 * The name is stamped older than any choice: a rename made on any machine,
 * before or after, wins when nicknames sync, and a name a person chose is never
 * touched. While the machine still carries a name it gave itself, that name
 * follows its fleet list (`defaultMachineNickname`): it goes back to the
 * computer name when another machine shows or would take the same name, and
 * takes the chip once the name is free again.
 */
export const nameThisMachine = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const targets = yield* FleetTargets.FleetTargets;
  const descriptor = yield* environment.getDescriptor;
  const fleet = yield* targets.load.pipe(Effect.orElseSucceed(() => null));
  const others = new Map(
    (fleet?.machines ?? []).map((machine) => [machine.environmentId as string, machine.label]),
  );
  // Read after the fleet list, so a name that arrived while it loaded counts.
  const current = yield* settings.getSettings;
  const entry = defaultMachineNickname(
    current.machineNicknames ?? {},
    descriptor.environmentId,
    descriptor.label,
    others,
  );
  if (entry === null) return false;
  yield* settings.updateSettings({ machineNicknames: { [descriptor.environmentId]: entry } });
  return true;
});

const attempt = nameThisMachine.pipe(Effect.catchCause(() => Effect.succeed(false)));

/** The fleet list changes without a settings write (a machine removed or joined). */
const RECHECK_EVERY = Duration.minutes(5);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    // Subscribed before the first try, so a name that arrives during it is not missed.
    const changes = yield* settings.subscribeChanges;
    // The tick tries once at once, then again every few minutes.
    yield* Stream.merge(
      changes.pipe(
        Stream.map((current) => current.machineNicknames),
        Stream.changesWith(sameMachineNicknames),
        Stream.debounce(Duration.seconds(2)),
      ),
      Stream.tick(RECHECK_EVERY),
    ).pipe(
      Stream.runForEach(() => attempt),
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );
  }),
);
