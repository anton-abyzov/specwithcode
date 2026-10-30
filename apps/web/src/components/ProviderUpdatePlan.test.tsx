// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";

vi.mock("~/state/environments", () => ({ useEnvironments: () => [] }));
vi.mock("~/state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("~/state/server", () => ({ serverEnvironment: { updateProvider: Symbol("update") } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { ProviderUpdatePlan } from "./ProviderUpdatesAction";
import type { ProviderUpdatePlanRow, ProviderUpdateRowResult } from "./ProviderUpdatesAction.logic";

function planRow(instance: string, driver: string): ProviderUpdatePlanRow {
  const environmentId = EnvironmentId.make("env-local");
  const instanceId = ProviderInstanceId.make(instance);
  return {
    key: `${environmentId}:${instanceId}`,
    environmentId,
    instanceId,
    driver: ProviderDriverKind.make(driver),
    machineLabel: "This Mac",
    reason: null,
    provider: {
      instanceId,
      driver: ProviderDriverKind.make(driver),
      version: "1.0.0",
      versionAdvisory: { latestVersion: "1.1.0", updateCommand: "npm install -g" },
    } as ServerProvider,
  };
}

describe("ProviderUpdatePlan Update anyway", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const buttons = (label: string) =>
    [...container.querySelectorAll("button")].filter((button) => button.textContent === label);

  it("retries only the in-use row, with force", async () => {
    const codex = planRow("codex", "codex");
    const claude = planRow("claude", "claudeAgent");
    const run = vi.fn(
      async (row: ProviderUpdatePlanRow, force: boolean): Promise<ProviderUpdateRowResult> => {
        if (row.instanceId === "codex")
          return force
            ? { text: "Updated and verified: 1.1.0" }
            : { text: "codex is running (pid 7: codex).", inUse: true };
        return { text: "npm exited with code 1." };
      },
    );
    await act(async () =>
      root.render(
        <ProviderUpdatePlan
          rows={[codex, claude]}
          initialSelection={[codex.key, claude.key]}
          run={run}
        />,
      ),
    );

    await act(async () => buttons("Update 2 selected")[0]!.click());
    expect(run.mock.calls.map(([row, force]) => [row.instanceId, force])).toEqual([
      ["codex", false],
      ["claude", false],
    ]);
    expect(container.textContent).toContain("codex is running (pid 7: codex).");
    // Only the in-use row offers Update anyway.
    expect(buttons("Update anyway")).toHaveLength(1);

    await act(async () => buttons("Update anyway")[0]!.click());
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]![0].instanceId).toBe("codex");
    expect(run.mock.calls[2]![1]).toBe(true);
    expect(container.textContent).toContain("Updated and verified: 1.1.0");
    // The other row kept its result and was not resent.
    expect(container.textContent).toContain("npm exited with code 1.");
    expect(buttons("Update anyway")).toHaveLength(0);
  });
});
