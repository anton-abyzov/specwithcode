import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ownMachineLabel } from "./machineNames.ts";

const environment = Option.some({
  getDescriptor: Effect.succeed({ environmentId: "env-here", label: "host-name" }),
});
const named = (machineNicknames: Record<string, { name: string }>) =>
  Option.some({ getSettings: Effect.succeed({ machineNicknames }) });

it.effect("names this machine by the owner's name for it, else the name it joined with", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* ownMachineLabel(environment, named({ "env-here": { name: "Studio A" } })),
      "Studio A",
    );
    assert.equal(
      yield* ownMachineLabel(environment, named({ "env-other": { name: "Studio B" } })),
      "host-name",
    );
    assert.equal(yield* ownMachineLabel(environment, Option.none()), "host-name");
    assert.isUndefined(yield* ownMachineLabel(Option.none(), Option.none()));
  }),
);
