import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MachineDefaultName from "./MachineDefaultName.ts";

/** One server's first start: its settings, what it reports about itself, then naming. */
const start = (label: string, before: Record<string, { name: string; updatedAt: string }> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      if (Object.keys(before).length > 0) {
        yield* settings.updateSettings({ machineNicknames: before });
      }
      const named = yield* MachineDefaultName.nameThisMachine;
      const after = yield* settings.getSettings;
      return { named, nicknames: after.machineNicknames };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("env-m5"),
              label,
            } as never),
          }),
        ),
      ),
    ),
  );

describe("a machine nobody named", () => {
  it("names itself after the chip in its computer name", async () => {
    const { named, nicknames } = await start("Anton M5MAX PROLED");
    expect(named).toBe(true);
    expect(nicknames["env-m5"]).toEqual({ name: "M5", updatedAt: "1970-01-01T00:00:00.000Z" });
  });

  it("keeps a name it already has, the computer name chosen on purpose included", async () => {
    const chosen = { name: "", updatedAt: "2026-11-14T00:00:00.000Z" };
    const { named, nicknames } = await start("Anton M5MAX PROLED", { "env-m5": chosen });
    expect(named).toBe(false);
    expect(nicknames["env-m5"]?.name).toBe("");
  });

  it("leaves a computer name with no chip as it is", async () => {
    const { named, nicknames } = await start("linux-mini");
    expect(named).toBe(false);
    expect(nicknames["env-m5"]).toBeUndefined();
  });
});
