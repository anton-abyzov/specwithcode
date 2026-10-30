import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  describeProviderUpdateResult,
  providerUpdateCommandInput,
  providerUpdateSkipReason,
  runProviderUpdateBatch,
} from "./ProviderUpdatesAction.logic";
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
  it("keeps running every selected item after one fails", async () => {
    const visited: number[] = [];
    const failures = await runProviderUpdateBatch(
      [1, 2, 3, 4],
      async (item) => {
        visited.push(item);
        if (item === 1) throw new Error("codex is running");
      },
      () => false,
    );
    expect(visited.sort()).toEqual([1, 2, 3, 4]);
    expect(failures.map((failure) => failure.item)).toEqual([1]);
  });
  it("marks an in-use refusal so the row can offer a forced retry", () => {
    const refused = {
      ...provider,
      updateState: {
        status: "failed",
        startedAt: null,
        finishedAt: null,
        message: "codex is running (pid 1: codex).",
        output: null,
        inUse: true,
      },
    } as ServerProvider;
    expect(
      describeProviderUpdateResult(
        AsyncResult.success({ providers: [refused] }) as never,
        provider.instanceId,
      ),
    ).toEqual({ text: "codex is running (pid 1: codex).", inUse: true });
    expect(
      describeProviderUpdateResult(
        AsyncResult.success({
          providers: [{ ...refused, updateState: { ...refused.updateState!, inUse: undefined } }],
        }) as never,
        provider.instanceId,
      ),
    ).toEqual({ text: "codex is running (pid 1: codex)." });
  });
});

describe("providerUpdateCommandInput", () => {
  const target = {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex-work"),
  };

  it("sends force only for an Update anyway retry", () => {
    // The fleet plan's run(row, force) and Settings' updateAnyway both build input here.
    expect(providerUpdateCommandInput(target, { force: true })).toEqual({
      provider: "codex",
      instanceId: "codex-work",
      force: true,
    });
    expect(providerUpdateCommandInput(target, { targetVersion: "0.166.0", force: true })).toEqual({
      provider: "codex",
      instanceId: "codex-work",
      targetVersion: "0.166.0",
      force: true,
    });
  });

  it("omits force and an empty target version on a normal update", () => {
    expect(providerUpdateCommandInput(target)).toEqual({
      provider: "codex",
      instanceId: "codex-work",
    });
    expect(providerUpdateCommandInput(target, { targetVersion: undefined, force: false })).toEqual({
      provider: "codex",
      instanceId: "codex-work",
    });
    expect("force" in providerUpdateCommandInput(target, { force: false })).toBe(false);
  });
});
