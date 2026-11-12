import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** The part of the settings service that holds machine names. */
export interface MachineNameSettings<E> {
  readonly getSettings: Effect.Effect<
    { readonly machineNicknames?: Readonly<Record<string, { readonly name: string }>> },
    E
  >;
}

/**
 * The names the owner gave machines in Settings, by environment id. Agents are told and may
 * ask for these names, so every text that names a machine reads them here. Empty when the
 * settings cannot be read: the name a machine joined with is used then.
 */
export const ownerMachineNames = <E>(settings: Option.Option<MachineNameSettings<E>>) =>
  Effect.gen(function* () {
    const names = new Map<string, string>();
    if (Option.isNone(settings)) return names;
    const read = yield* settings.value.getSettings.pipe(Effect.option);
    for (const [environmentId, entry] of Object.entries(
      (Option.isSome(read) ? read.value.machineNicknames : undefined) ?? {},
    )) {
      const name = normalizeMachineNickname(entry.name);
      if (name !== "") names.set(environmentId, name);
    }
    return names;
  });
