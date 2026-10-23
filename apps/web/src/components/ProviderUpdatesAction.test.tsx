import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { providerUpdateSkipReason, runProviderUpdateBatch } from "./ProviderUpdatesAction.logic";
const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.162.1",
  versionAdvisory: {
    status: "behind_latest",
    canUpdate: true,
    updateCommand: "owning npm (staged)",
    latestVersion: "0.164.0",
  },
} as ServerProvider;
describe("explicit provider fleet plan", () => {
  it("requires a connected authorized destination with a proven installer", () => {
    expect(providerUpdateSkipReason(provider, true, true)).toBeNull();
    expect(providerUpdateSkipReason(provider, false, true)).toContain("Offline");
    expect(providerUpdateSkipReason(provider, true, false)).toContain("permission");
    expect(
      providerUpdateSkipReason(
        {
          ...provider,
          versionAdvisory: {
            ...provider.versionAdvisory!,
            canUpdate: false,
            message: "Restore reviewed fleet wrapper",
          },
        },
        true,
        true,
      ),
    ).toBe("Restore reviewed fleet wrapper");
    expect(
      providerUpdateSkipReason(
        { ...provider, versionAdvisory: { ...provider.versionAdvisory!, status: "unknown" } },
        true,
        true,
      ),
    ).toContain("unknown");
    expect(
      providerUpdateSkipReason(
        { ...provider, updateState: { status: "running" } as never },
        true,
        true,
      ),
    ).toContain("already running");
  });
  it("bounds execution to two items and visits each explicit selection once", async () => {
    let active = 0,
      maximum = 0;
    const visited: number[] = [];
    await runProviderUpdateBatch(
      [1, 2, 3, 4],
      async (item) => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        visited.push(item);
        active--;
      },
      () => false,
    );
    expect(maximum).toBe(2);
    expect(visited.sort()).toEqual([1, 2, 3, 4]);
  });
  it("cancels only queued items", async () => {
    let cancelled = false;
    const visited: number[] = [];
    await runProviderUpdateBatch(
      [1, 2, 3],
      async (item) => {
        visited.push(item);
        cancelled = true;
      },
      () => cancelled,
    );
    expect(visited).toEqual([1]);
  });
});
