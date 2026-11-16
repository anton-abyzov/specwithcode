import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as MachineDefaultName from "./MachineDefaultName.ts";

type Nicknames = Record<string, { name: string; updatedAt: string }>;

/** This server: what it reports about itself and the machines on its fleet list. */
const services = (label: string, fleet: ReadonlyArray<{ environmentId: string; label: string }>) =>
  Layer.mergeAll(
    ServerSettings.layerTest(),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: EnvironmentId.make("env-m5"), label } as never),
    }),
    Layer.mock(FleetTargets.FleetTargets)({
      load: Effect.succeed({ machines: fleet } as never),
    }),
  );

const start = (
  label: string,
  input: { readonly before?: Nicknames; readonly fleet?: ReadonlyArray<{ environmentId: string; label: string }> } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      if (input.before) yield* settings.updateSettings({ machineNicknames: input.before });
      const named = yield* MachineDefaultName.nameThisMachine;
      const after = yield* settings.getSettings;
      return { named, nicknames: after.machineNicknames };
    }).pipe(Effect.provide(services(label, input.fleet ?? []))),
  );

describe("a machine nobody named", () => {
  it("names itself after the chip in its computer name", async () => {
    const { named, nicknames } = await start("Anton M5MAX PROLED", {
      fleet: [{ environmentId: "env-m4", label: "Anton's MacBook M4MAX" }],
    });
    expect(named).toBe(true);
    expect(nicknames["env-m5"]).toEqual({ name: "M5", updatedAt: "1970-01-01T00:00:00.000Z" });
  });

  it("keeps a name it already has, the computer name chosen on purpose included", async () => {
    const chosen = { name: "", updatedAt: "2026-11-14T00:00:00.000Z" };
    const { named, nicknames } = await start("Anton M5MAX PROLED", { before: { "env-m5": chosen } });
    expect(named).toBe(false);
    expect(nicknames["env-m5"]?.name).toBe("");
  });

  it("leaves a computer name with no chip as it is", async () => {
    const { named, nicknames } = await start("linux-mini");
    expect(named).toBe(false);
    expect(nicknames["env-m5"]).toBeUndefined();
  });

  it("keeps its computer name while a machine on its list shows the same short name", async () => {
    const { named } = await start("Anton M5MAX PROLED", {
      before: { "env-studio": { name: "m5", updatedAt: "2026-11-13T00:00:00.000Z" } },
      fleet: [{ environmentId: "env-studio", label: "Mac Studio" }],
    });
    expect(named).toBe(false);
  });

  it("ignores the name an old registration left behind", async () => {
    const { named, nicknames } = await start("Anton M5MAX PROLED", {
      before: { "env-old-m5": { name: "m5", updatedAt: "2026-11-13T00:00:00.000Z" } },
      fleet: [{ environmentId: "env-m4", label: "Anton's MacBook M4MAX" }],
    });
    expect(named).toBe(true);
    expect(nicknames["env-m5"]?.name).toBe("M5");
  });

  it("does it from the server's own layer at start", async () => {
    const nicknames = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* Layer.build(MachineDefaultName.layer);
        for (let tries = 0; tries < 50; tries += 1) {
          const current = yield* settings.getSettings;
          if (current.machineNicknames["env-m5"] !== undefined) return current.machineNicknames;
          yield* Effect.sleep("20 millis");
        }
        return (yield* settings.getSettings).machineNicknames;
      }).pipe(Effect.scoped, Effect.provide(services("Anton M5MAX PROLED", []))),
    );
    expect(nicknames["env-m5"]?.name).toBe("M5");
  });
});
