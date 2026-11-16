import { defaultMachineNickname } from "@specweave-studio/shared/machineNicknames";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * A machine nobody has named names itself once, from the chip in its computer
 * name ("Anton M5MAX PROLED" shows as "M5"), so a new machine reads short in
 * Runs on, thread rows and on every paired device without a rename first. The
 * name is stamped older than any choice: a rename made on any machine, before
 * or after, wins when nicknames sync. A machine that already has an entry,
 * even one that keeps the computer name, is left alone.
 */
export const nameThisMachine = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  const current = yield* settings.getSettings;
  const entry = defaultMachineNickname(
    current.machineNicknames ?? {},
    descriptor.environmentId,
    descriptor.label,
  );
  if (entry === null) return false;
  yield* settings.updateSettings({ machineNicknames: { [descriptor.environmentId]: entry } });
  return true;
});

export const layer = Layer.effectDiscard(
  nameThisMachine.pipe(
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  ),
);
