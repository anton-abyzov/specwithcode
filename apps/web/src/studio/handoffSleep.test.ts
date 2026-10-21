import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffModeSnapshot,
} from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { handleHandoffSleep } from "./handoffSleep";

const M4 = "env-m4" as EnvironmentId;
const MINIS = "env-minis" as EnvironmentId;

const snapshot = (sleepTarget: EnvironmentId | null) =>
  ({ ok: true, value: { config: { sleepTarget } } as unknown as HandoffModeSnapshot }) as const;
const run = { results: [] } as unknown as HandoffMachineRun;

describe("handleHandoffSleep (simulated suspend)", () => {
  it("hands running threads to the sleep target with reason sleep", async () => {
    const handOffMachine = vi.fn(async () => ({ ok: true as const, value: run }));
    const outcome = await handleHandoffSleep(M4, {
      snapshot: async () => snapshot(MINIS),
      handOffMachine,
    });
    expect(handOffMachine).toHaveBeenCalledWith(M4, MINIS);
    expect(outcome).toEqual({ kind: "handed-off", run });
  });

  it("does nothing while the setting is off", async () => {
    const handOffMachine = vi.fn();
    expect(
      await handleHandoffSleep(M4, { snapshot: async () => snapshot(null), handOffMachine }),
    ).toEqual({ kind: "off" });
    expect(handOffMachine).not.toHaveBeenCalled();
  });

  it("reports a server that did not answer instead of throwing", async () => {
    expect(
      await handleHandoffSleep(M4, {
        snapshot: async () => ({ ok: false, error: "M4 is not connected." }),
        handOffMachine: vi.fn(),
      }),
    ).toEqual({ kind: "failed", error: "M4 is not connected." });
  });
});
